package engine

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/triggers"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// This file is the only place the executors' narrow seams meet real infra. The
// executors never learn about the session service, the runtime adapter or the
// store; these adapters translate their vocabulary to and from domain types.

// SessionCommander is the session-manager surface the pipeline stages need.
// Satisfied by *internal/service/session.Service, which spawns the same visible
// sidebar sessions a human gets.
type SessionCommander interface {
	// Spawn returns the session plus the prompt and system-prompt byte counts the
	// session service reports for telemetry; the pipeline engine ignores both.
	Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, int, int, error)
	Kill(ctx context.Context, id domain.SessionID) (bool, error)
	Send(ctx context.Context, id domain.SessionID, message string) error
}

// SessionReader reads session rows. Satisfied by *storage/sqlite/store.Store.
type SessionReader interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
}

// RuntimeInterrupter sends the terminal interrupt to a session's runtime pane.
// It is what makes timed_out different from cancelled: the agent's work stops,
// the session and its scrollback survive (spec section 7.2). Satisfied by the
// selected runtime adapter.
type RuntimeInterrupter interface {
	Interrupt(ctx context.Context, handle ports.RuntimeHandle) error
}

// CredentialStore is the persistence half of the engine-held credentials.
// Satisfied by *storage/sqlite/store.Store.
type CredentialStore interface {
	GetPipelineCredential(ctx context.Context, projectID domain.ProjectID, name string) (map[string]string, bool, error)
	ListPipelineCredentialNames(ctx context.Context, projectID domain.ProjectID) ([]string, error)
}

// ProjectReader resolves a project's primary checkout, the tree a `workspace:
// checkout` stage runs in. Satisfied by *storage/sqlite/store.Store.
type ProjectReader interface {
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
}

// ---------------------------------------------------------------------------
// Session seams (agent executor, nudges, kill-on)
// ---------------------------------------------------------------------------

// SessionAdapter implements the agent executor's session seam, the driver's
// nudge messenger, and the kill-on disposer, all over one pair of dependencies.
type SessionAdapter struct {
	cmd     SessionCommander
	reader  SessionReader
	runtime RuntimeInterrupter
	log     *slog.Logger
}

// NewSessionAdapter builds the session seam. runtime may be nil, in which case
// an interrupt degrades to a log line rather than killing the session, which is
// the safe direction: losing the scrollback is the thing the timed_out rule
// exists to prevent.
func NewSessionAdapter(cmd SessionCommander, reader SessionReader, runtime RuntimeInterrupter, log *slog.Logger) *SessionAdapter {
	if log == nil {
		log = slog.Default()
	}
	return &SessionAdapter{cmd: cmd, reader: reader, runtime: runtime, log: log}
}

var (
	_ executors.SessionSpawner   = (*SessionAdapter)(nil)
	_ executors.SessionMessenger = (*SessionAdapter)(nil)
	_ SessionDisposer            = (*SessionAdapter)(nil)
	_ triggers.SessionSpawnCheck = (*SessionAdapter)(nil)
)

// Spawn starts the stage's worker session in the tree the driver resolved for
// the stage. The session manager adopts that tree instead of creating one of
// its own, which is what makes `workspace: run`, `stage` and `inherit` mean
// something for an agent stage and what makes $AO_WORKSPACE name the tree the
// agent is really in. Ownership of the tree stays with the run (spec section
// 5.5): session teardown never destroys an adopted workspace.
func (a *SessionAdapter) Spawn(ctx context.Context, req executors.SpawnRequest) (executors.SpawnedSession, error) {
	sess, _, _, err := a.cmd.Spawn(ctx, ports.SpawnConfig{
		ProjectID:     domain.ProjectID(req.ProjectID),
		Kind:          domain.KindWorker,
		Harness:       domain.AgentHarness(req.Harness),
		Prompt:        req.Prompt,
		WorkspacePath: req.WorkspacePath,
		// The run id lands on the session's metadata: it is the marker the
		// session trigger bridge reads as its loop guard, so it has to be set
		// here, at spawn, and not once the stage settles.
		PipelineRunID: req.RunID,
		DisplayName:   req.DisplayName,
		Env:           req.Env,
	})
	if err != nil {
		return executors.SpawnedSession{}, err
	}
	return executors.SpawnedSession{
		SessionID:     string(sess.ID),
		WorkspacePath: sess.Metadata.WorkspacePath,
	}, nil
}

// Get reports how busy the session is and whether its row went terminal.
func (a *SessionAdapter) Get(ctx context.Context, sessionID string) (executors.SessionSnapshot, bool, error) {
	rec, ok, err := a.reader.GetSession(ctx, domain.SessionID(sessionID))
	if err != nil || !ok {
		return executors.SessionSnapshot{}, false, err
	}
	return executors.SessionSnapshot{
		Activity:   rec.Activity.State,
		Terminated: rec.IsTerminated,
		// FirstSignalAt is the platform's own record of the first hook callback
		// for this spawn, cleared on every spawn/restore. Zero means the row
		// still carries its seeded activity and nothing has been observed yet.
		Signalled: !rec.FirstSignalAt.IsZero(),
	}, true, nil
}

// Interrupt stops the agent's work and keeps the session.
func (a *SessionAdapter) Interrupt(ctx context.Context, sessionID string) error {
	if a.runtime == nil {
		a.log.Warn("pipeline stage interrupt skipped: no runtime wired", "session", sessionID)
		return nil
	}
	rec, ok, err := a.reader.GetSession(ctx, domain.SessionID(sessionID))
	if err != nil {
		return err
	}
	if !ok || rec.Metadata.RuntimeHandleID == "" {
		// Nothing to interrupt is not an error: the session is already gone or
		// never had a live pane.
		return nil
	}
	return a.runtime.Interrupt(ctx, ports.RuntimeHandle{ID: rec.Metadata.RuntimeHandleID})
}

// Kill tears the session down. Best-effort and idempotent: a missing or
// already-dead session is not an error, which the executor contract requires.
func (a *SessionAdapter) Kill(ctx context.Context, sessionID string) error {
	_, _ = a.cmd.Kill(ctx, domain.SessionID(sessionID))
	return nil
}

// Alive implements the messenger seam: a nudge is only worth sending into a
// session that is still there.
func (a *SessionAdapter) Alive(ctx context.Context, sessionID string) (bool, error) {
	rec, ok, err := a.reader.GetSession(ctx, domain.SessionID(sessionID))
	if err != nil || !ok {
		return false, err
	}
	return !rec.IsTerminated && rec.Activity.State != domain.ActivityExited, nil
}

// Send delivers the nudge into the live session.
func (a *SessionAdapter) Send(ctx context.Context, sessionID, message string) error {
	return a.cmd.Send(ctx, domain.SessionID(sessionID), message)
}

// IsPipelineSpawned implements the session trigger bridge's loop guard over the
// marker Spawn wrote. An unknown session is not pipeline-spawned; a read failure
// propagates, because the bridge's fail-safe (skip the session) is only correct
// when it knows the provenance is unknown.
func (a *SessionAdapter) IsPipelineSpawned(ctx context.Context, sessionID domain.SessionID) (bool, error) {
	rec, ok, err := a.reader.GetSession(ctx, sessionID)
	if err != nil || !ok {
		return false, err
	}
	return rec.Metadata.PipelineRunID != "", nil
}

// GetPath implements the workspace resolver's session seam: where the subject
// session's own worktree lives.
func (a *SessionAdapter) GetPath(ctx context.Context, sessionID string) (string, bool, error) {
	rec, ok, err := a.reader.GetSession(ctx, domain.SessionID(sessionID))
	if err != nil || !ok {
		return "", false, err
	}
	return rec.Metadata.WorkspacePath, rec.Metadata.WorkspacePath != "", nil
}

// ---------------------------------------------------------------------------
// Store-backed seams
// ---------------------------------------------------------------------------

// CredentialAdapter serves both the engine's Credentials seam and the service
// layer's pipeline.CredentialResolver over the store.
type CredentialAdapter struct{ store CredentialStore }

// NewCredentialAdapter builds the credential seam.
func NewCredentialAdapter(store CredentialStore) *CredentialAdapter {
	return &CredentialAdapter{store: store}
}

var (
	_ Credentials                 = (*CredentialAdapter)(nil)
	_ pipeline.CredentialResolver = (*CredentialAdapter)(nil)
)

// Resolve flattens the named credentials into one environment, in order, so a
// later name wins a key collision. An unknown name is an error: a stage that
// asked for a credential must never run without it.
func (a *CredentialAdapter) Resolve(ctx context.Context, projectID string, names []string) (map[string]string, error) {
	out := make(map[string]string)
	for _, name := range names {
		env, ok, err := a.store.GetPipelineCredential(ctx, domain.ProjectID(projectID), name)
		if err != nil {
			return nil, fmt.Errorf("read credential %q: %w", name, err)
		}
		if !ok {
			return nil, fmt.Errorf("project %s does not define credential %q", projectID, name)
		}
		for k, v := range env {
			out[k] = v
		}
	}
	return out, nil
}

// Exists reports whether the project declares a credential by that name.
func (a *CredentialAdapter) Exists(ctx context.Context, projectID, name string) (bool, error) {
	_, ok, err := a.store.GetPipelineCredential(ctx, domain.ProjectID(projectID), name)
	return ok, err
}

// Names lists the project's declared credential names, which is what the
// plan-time check needs. Names only, never values.
func (a *CredentialAdapter) Names(ctx context.Context, projectID string) ([]string, error) {
	return a.store.ListPipelineCredentialNames(ctx, domain.ProjectID(projectID))
}

// CheckoutAdapter resolves a project's primary local checkout for a
// `workspace: checkout` stage: the tree the user is actually coding in, which
// is why the kind is explicit and never a default.
type CheckoutAdapter struct{ projects ProjectReader }

// NewCheckoutAdapter builds the checkout seam.
func NewCheckoutAdapter(projects ProjectReader) *CheckoutAdapter {
	return &CheckoutAdapter{projects: projects}
}

var _ executors.Checkouts = (*CheckoutAdapter)(nil)

// CheckoutPath returns the project's registered repo path.
func (a *CheckoutAdapter) CheckoutPath(projectID string) (string, error) {
	rec, ok, err := a.projects.GetProject(context.Background(), projectID)
	if err != nil {
		return "", fmt.Errorf("resolve project %q: %w", projectID, err)
	}
	if !ok || rec.Path == "" {
		return "", fmt.Errorf("project %q has no registered checkout", projectID)
	}
	return rec.Path, nil
}

// sessionWorkspaces adapts SessionAdapter.GetPath onto the resolver's seam,
// whose Get name would otherwise collide with the spawner's.
type sessionWorkspaces struct{ sessions *SessionAdapter }

var _ executors.SessionWorkspaces = sessionWorkspaces{}

func (s sessionWorkspaces) Get(ctx context.Context, sessionID string) (string, bool, error) {
	return s.sessions.GetPath(ctx, sessionID)
}

// SessionWorkspaces returns the adapter's view for the workspace resolver.
func (a *SessionAdapter) SessionWorkspaces() executors.SessionWorkspaces {
	return sessionWorkspaces{sessions: a}
}

// ---------------------------------------------------------------------------
// Executor set
// ---------------------------------------------------------------------------

// BuildExecutorSet assembles the two kind executors over the real seams and
// returns the routing facade the engine drives. This is the single place the
// executors are wired to infra.
func BuildExecutorSet(sessions *SessionAdapter, signals executors.SignalReader) *executors.Set {
	return &executors.Set{
		Agent:   executors.NewAgentExecutor(sessions, signals),
		Command: executors.NewCommandExecutor(executors.NewOSRunner),
	}
}
