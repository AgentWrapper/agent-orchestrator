package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// This file wires the T4 executor DI seams (SessionSpawner, CommandSessions,
// ArtifactStore, SessionMessenger) onto the real session service and store. The
// executors stay unaware of concrete infra; these adapters translate their
// narrow shapes to/from domain + ports types.

// SessionCommander is the session-manager surface the agent-spawn and router
// adapters need. Satisfied by *internal/service/session.Service (which spawns
// visible sidebar sessions, per spec §4b).
type SessionCommander interface {
	Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, error)
	Kill(ctx context.Context, id domain.SessionID) (bool, error)
	Send(ctx context.Context, id domain.SessionID, message string) error
}

// SessionReader reads session snapshots, PR facts, and persisted pipeline
// artifacts for the executor adapters. Satisfied by *storage/sqlite/store.Store.
type SessionReader interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
	GetDisplayPRFactsForSession(ctx context.Context, id domain.SessionID) (domain.PRFacts, bool, error)
	GetPipelineRun(ctx context.Context, id pipeline.RunID) (pipeline.RunState, bool, error)
	GetPipelineArtifact(ctx context.Context, id pipeline.ArtifactID) (pipeline.Artifact, bool, error)
}

// BuildExecutorSet assembles the three kind executors over the real session
// service + store and returns the routing facade the engine drives. This is the
// single place the executors are wired to infra.
func BuildExecutorSet(cmd SessionCommander, reader SessionReader, log *slog.Logger) *executors.Set {
	if log == nil {
		log = slog.Default()
	}
	agent := executors.NewAgentExecutor(&sessionSpawnerAdapter{cmd: cmd, reader: reader, log: log})
	// nil LogSink: the subprocess output is still captured (capped) for the
	// JSON-over-stdout contract; streaming it to an activity log is a phase-2
	// nicety, not needed for correctness.
	// ponytail: nil sink drops live command logs; wire a LogSink when the Runs UI
	// wants streaming stdout.
	command := executors.NewCommandExecutor(executors.NewOSRunner(nil), &commandSessionsAdapter{reader: reader})
	builtin := executors.NewBuiltinExecutor(&artifactStoreAdapter{reader: reader}, &sessionMessengerAdapter{cmd: cmd, reader: reader})
	return executors.NewSet(agent, command, builtin)
}

// ---------------------------------------------------------------------------
// SessionSpawner (agent executor)
// ---------------------------------------------------------------------------

type sessionSpawnerAdapter struct {
	cmd    SessionCommander
	reader SessionReader
	log    *slog.Logger
}

var _ executors.SessionSpawner = (*sessionSpawnerAdapter)(nil)

func (a *sessionSpawnerAdapter) Spawn(ctx context.Context, req executors.SpawnRequest) (executors.SpawnedSession, error) {
	sess, err := a.cmd.Spawn(ctx, ports.SpawnConfig{
		ProjectID: domain.ProjectID(req.ProjectID),
		IssueID:   domain.IssueID(req.IssueID),
		Kind:      domain.KindWorker,
		Harness:   domain.AgentHarness(req.Harness),
		Branch:    req.Branch,
		Prompt:    req.Prompt,
	})
	if err != nil {
		// The PR's owning worker session usually has the PR source branch checked
		// out while alive, so a pr.updated-triggered stage spawn onto that branch
		// is refused (ErrWorkspaceBranchCheckedOutElsewhere, surfaced as a 409).
		// Fall back once to a run-unique derived branch based at the PR head so the
		// stage still runs; the agent pushes with `git push origin HEAD:<branch>`.
		if req.Branch == "" || !isBranchCheckedOutElsewhere(err) {
			return executors.SpawnedSession{}, err
		}
		return a.spawnOnFallbackBranch(ctx, req, err)
	}
	return executors.SpawnedSession{
		SessionID:     string(sess.ID),
		WorkspacePath: sess.Metadata.WorkspacePath,
	}, nil
}

// spawnOnFallbackBranch retries a spawn that was refused because req.Branch is
// checked out elsewhere. It creates a fresh derived branch based at the original
// branch's head (BaseBranch), notes the substitution in the prompt, and logs it.
func (a *sessionSpawnerAdapter) spawnOnFallbackBranch(ctx context.Context, req executors.SpawnRequest, cause error) (executors.SpawnedSession, error) {
	fallback := fallbackBranchName(req.StageRunID)
	a.log.Warn("pipeline spawn: source branch checked out elsewhere, using fallback branch",
		"sourceBranch", req.Branch,
		"fallbackBranch", fallback,
		"stageRunId", req.StageRunID,
		"cause", cause.Error(),
	)
	sess, err := a.cmd.Spawn(ctx, ports.SpawnConfig{
		ProjectID:  domain.ProjectID(req.ProjectID),
		IssueID:    domain.IssueID(req.IssueID),
		Kind:       domain.KindWorker,
		Harness:    domain.AgentHarness(req.Harness),
		Branch:     fallback,
		BaseBranch: req.Branch,
		Prompt:     appendFallbackBranchNote(req.Prompt, fallback, req.Branch),
	})
	if err != nil {
		return executors.SpawnedSession{}, err
	}
	return executors.SpawnedSession{
		SessionID:     string(sess.ID),
		WorkspacePath: sess.Metadata.WorkspacePath,
	}, nil
}

// isBranchCheckedOutElsewhere reports whether err is the branch-conflict refusal.
// The session service maps the workspace sentinel to a typed API error whose
// Unwrap chain does not carry the sentinel, so both forms are checked: the
// wrapped sentinel (direct session-manager wiring) and the API error code (the
// production path through session.Service).
func isBranchCheckedOutElsewhere(err error) bool {
	if errors.Is(err, ports.ErrWorkspaceBranchCheckedOutElsewhere) {
		return true
	}
	var apiErr *apierr.Error
	return errors.As(err, &apiErr) && apiErr.Code == "BRANCH_CHECKED_OUT_ELSEWHERE"
}

// fallbackBranchName mints a collision-free branch under pipeline/ from the
// stage run id (itself run-unique, e.g. sr-<uuid> or sr-<uuid>#2 on retry). A
// missing id falls back to a fixed leaf; the caller only reaches this when a
// real stage spawn conflicts, where StageRunID is always set.
func fallbackBranchName(stageRunID string) string {
	leaf := sanitizeBranchSegment(stageRunID)
	if leaf == "" {
		leaf = "stage"
	}
	return "pipeline/" + leaf
}

// sanitizeBranchSegment collapses characters git refnames forbid into '-' so an
// id like "sr-abc#2" becomes a valid branch leaf "sr-abc-2".
func sanitizeBranchSegment(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-.")
}

// appendFallbackBranchNote tells the agent it is on a derived branch and how to
// push back to the real PR source branch. The stage prompt already names the PR
// branch; this only clarifies the substitution.
func appendFallbackBranchNote(prompt, fallback, sourceBranch string) string {
	note := fmt.Sprintf("Note: this session is on fallback branch `%s` because `%s` was already checked out in another worktree. Push your work with `git push origin HEAD:%s`.",
		fallback, sourceBranch, sourceBranch)
	if strings.TrimSpace(prompt) == "" {
		return note
	}
	return prompt + "\n\n" + note
}

func (a *sessionSpawnerAdapter) Get(ctx context.Context, sessionID string) (executors.SessionSnapshot, bool, error) {
	rec, ok, err := a.reader.GetSession(ctx, domain.SessionID(sessionID))
	if err != nil {
		return executors.SessionSnapshot{}, false, err
	}
	if !ok {
		return executors.SessionSnapshot{}, false, nil
	}
	return executors.SessionSnapshot{
		Activity:   string(rec.Activity.State),
		Terminated: rec.IsTerminated,
	}, true, nil
}

func (a *sessionSpawnerAdapter) Kill(ctx context.Context, sessionID string) error {
	// Best-effort, idempotent teardown: a missing or already-dead session is not
	// an error (the executor contract requires this). The session manager logs
	// its own kill failures, so swallowing here keeps stage teardown clean.
	_, _ = a.cmd.Kill(ctx, domain.SessionID(sessionID))
	return nil
}

// ---------------------------------------------------------------------------
// CommandSessions (command executor)
// ---------------------------------------------------------------------------

type commandSessionsAdapter struct {
	reader SessionReader
}

var _ executors.CommandSessions = (*commandSessionsAdapter)(nil)

func (a *commandSessionsAdapter) Get(ctx context.Context, sessionID string) (executors.CommandSession, bool, error) {
	rec, ok, err := a.reader.GetSession(ctx, domain.SessionID(sessionID))
	if err != nil {
		return executors.CommandSession{}, false, err
	}
	if !ok {
		return executors.CommandSession{}, false, nil
	}

	// Fork provenance rides the pr.is_from_fork tri-state (migration 0041),
	// populated from the SCM observer's head-repo vs base-repo comparison. A
	// session with no PR is ForkNo and runs normally. An attributed PR maps its
	// stored tri-state: known-fork -> ForkYes, known-same-repo -> ForkNo, and
	// unknown (nil, e.g. a legacy row observed before this column) stays
	// ForkUnknown, which the command executor gates behind allowForkPRs.
	fork := executors.ForkNo
	prNumber := 0
	if prf, prok, perr := a.reader.GetDisplayPRFactsForSession(ctx, domain.SessionID(sessionID)); perr == nil && prok && prf.Number > 0 {
		fork = forkStatusFromFlag(prf.IsFromFork)
		prNumber = prf.Number
	}

	return executors.CommandSession{
		WorkspacePath: rec.Metadata.WorkspacePath,
		Fork:          fork,
		PRNumber:      prNumber,
	}, true, nil
}

// forkStatusFromFlag maps the stored is_from_fork tri-state onto the command
// executor's ForkStatus. nil (unknown) stays fail-safe ForkUnknown.
func forkStatusFromFlag(isFromFork *bool) executors.ForkStatus {
	switch {
	case isFromFork == nil:
		return executors.ForkUnknown
	case *isFromFork:
		return executors.ForkYes
	default:
		return executors.ForkNo
	}
}

// ---------------------------------------------------------------------------
// SessionMessenger (builtin router)
// ---------------------------------------------------------------------------

type sessionMessengerAdapter struct {
	cmd    SessionCommander
	reader SessionReader
}

var _ executors.SessionMessenger = (*sessionMessengerAdapter)(nil)

func (a *sessionMessengerAdapter) Alive(ctx context.Context, sessionID string) (bool, error) {
	rec, ok, err := a.reader.GetSession(ctx, domain.SessionID(sessionID))
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil
	}
	return !rec.IsTerminated && rec.Activity.State != domain.ActivityExited, nil
}

func (a *sessionMessengerAdapter) Send(ctx context.Context, sessionID, message string) error {
	return a.cmd.Send(ctx, domain.SessionID(sessionID), message)
}

// ---------------------------------------------------------------------------
// ArtifactStore (builtin router/compose)
// ---------------------------------------------------------------------------

type artifactStoreAdapter struct {
	reader SessionReader
}

var _ executors.ArtifactStore = (*artifactStoreAdapter)(nil)

// UpstreamArtifacts returns the persisted artifacts of the named upstream stages,
// keyed by stage name. It reads through the existing public store surface
// (GetPipelineRun for the stage->artifact-id mapping, then GetPipelineArtifact
// for each blob) so no new store query is introduced.
//
// ponytail: N+1 artifact fetch per builtin stage. Fine at v1 scale (builtins
// consume a handful of upstream artifacts); add a batch "artifacts by run+stage"
// store query if builtin-heavy pipelines show up hot in a profile.
func (a *artifactStoreAdapter) UpstreamArtifacts(ctx context.Context, runID pipeline.RunID, stageNames []string) (map[string][]pipeline.Artifact, error) {
	out := make(map[string][]pipeline.Artifact, len(stageNames))
	run, ok, err := a.reader.GetPipelineRun(ctx, runID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return out, nil
	}
	for _, name := range stageNames {
		stage, ok := run.Stages[name]
		if !ok {
			continue
		}
		var arts []pipeline.Artifact
		for _, id := range stage.Artifacts {
			art, ok, err := a.reader.GetPipelineArtifact(ctx, id)
			if err != nil {
				return nil, err
			}
			if ok {
				arts = append(arts, art)
			}
		}
		if len(arts) > 0 {
			out[name] = arts
		}
	}
	return out, nil
}
