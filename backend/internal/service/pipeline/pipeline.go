// Package pipelinesvc is the read/write service boundary for the pipelines
// HTTP API. It sits between the pipelines controller and the two things it
// orchestrates: the SQLite store (definitions, runs, signals) and the
// per-project engine supervisor (trigger, cancel).
//
// Definition authoring runs YAML through pipeline.ParseDefinition so the editor
// sees every validation issue in one pass. Run lifecycle mutations route
// through the engine, never the store, so run state stays owned by the actor
// loop.
package pipelinesvc

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/engine"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/triggers"
)

// ErrEnginesUnavailable means the service was built without an engine
// supervisor, so nothing can be triggered or cancelled. The read paths and the
// signal path still work.
var ErrEnginesUnavailable = errors.New("pipeline engine unavailable")

// Store is the persistence surface the service reads and writes: a subset of
// *storage/sqlite/store.Store, kept narrow so the service unit-tests against a
// fake. SignalStore is the slice the signal path needs.
type Store interface {
	SignalStore

	ListPipelineDefinitions(ctx context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error)
	GetPipelineDefinition(ctx context.Context, id pipeline.ID) (pipeline.Definition, bool, error)
	GetPipelineDefinitionByName(ctx context.Context, projectID domain.ProjectID, name string) (pipeline.Definition, bool, error)
	CreatePipelineDefinition(ctx context.Context, def pipeline.Definition) error
	UpdatePipelineDefinition(ctx context.Context, def pipeline.Definition) (bool, error)
	DeletePipelineDefinition(ctx context.Context, id pipeline.ID) (bool, error)

	ListPipelineRuns(ctx context.Context, projectID domain.ProjectID, filter pipeline.RunFilter) ([]pipeline.RunState, error)

	// Credential writes and the names-only read (decision D13). Reading a
	// credential's values is not part of this seam: only the engine's resolver
	// does that, and only into a command stage's env.
	SetPipelineCredential(ctx context.Context, projectID domain.ProjectID, name string, env map[string]string, now time.Time) error
	ListPipelineCredentialNames(ctx context.Context, projectID domain.ProjectID) ([]string, error)
	DeletePipelineCredential(ctx context.Context, projectID domain.ProjectID, name string) (bool, error)

	// Sessions and their PRs are how a manual trigger resolves a PR subject
	// server-side: the pr table reaches a project only through its session.
	ListSessions(ctx context.Context, projectID domain.ProjectID) ([]domain.SessionRecord, error)
	ListPRsBySession(ctx context.Context, sessionID domain.SessionID) ([]domain.PullRequest, error)
}

// Engine is the subset of the per-project engine actor the request handlers
// drive.
type Engine interface {
	TriggerRun(req triggers.TriggerRequest) (pipeline.RunID, error)
	Cancel(runID pipeline.RunID, reason string)
}

// Engines resolves the engine for a project. *engine.Supervisor satisfies this
// through SupervisorEngines.
type Engines interface {
	For(ctx context.Context, projectID domain.ProjectID) (Engine, error)
}

// SupervisorEngines adapts a *engine.Supervisor (whose For returns the concrete
// *engine.Engine) to the Engines interface.
func SupervisorEngines(sup *engine.Supervisor) Engines { return supervisorEngines{sup: sup} }

type supervisorEngines struct{ sup *engine.Supervisor }

func (s supervisorEngines) For(ctx context.Context, projectID domain.ProjectID) (Engine, error) {
	eng, err := s.sup.For(ctx, projectID)
	if err != nil {
		// An explicit nil, so a caller never gets a non-nil interface wrapping a
		// nil pointer.
		return nil, err
	}
	return eng, nil
}

// TriggerInput is a manual trigger: which definition, and optionally what the
// run is about.
type TriggerInput struct {
	// Ref is the definition id or name to run.
	Ref string
	// SessionID makes the run a session-subject run. Empty makes it a
	// project-subject run, which is first-class (spec section 4).
	SessionID string
	// PRNumber makes the run a PR-subject run. It wins over SessionID, because
	// a PR subject already carries the session tracking it when there is one,
	// and a PR subject is the more specific of the two. Zero means no PR.
	PRNumber int
}

// Manager is the pipelines service the HTTP controller and the lifecycle merge
// gate depend on. A nil Manager keeps the routes registered but answers 501,
// which is what the AO_PIPELINES flag being off looks like from the outside.
type Manager interface {
	ListDefinitions(ctx context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error)
	CreateDefinition(ctx context.Context, projectID domain.ProjectID, yamlSource string) (pipeline.Definition, error)
	UpdateDefinition(ctx context.Context, id pipeline.ID, yamlSource string) (pipeline.Definition, error)
	DeleteDefinition(ctx context.Context, id pipeline.ID) error
	ValidateDefinition(ctx context.Context, projectID domain.ProjectID, yamlSource string) (valid bool, issues, warnings []pipeline.Issue, err error)
	ConfigSchema() []byte

	ListRuns(ctx context.Context, projectID domain.ProjectID, filter pipeline.RunFilter) ([]pipeline.RunState, error)
	GetRun(ctx context.Context, id pipeline.RunID) (pipeline.RunState, error)
	TriggerRun(ctx context.Context, projectID domain.ProjectID, in TriggerInput) (pipeline.RunID, error)
	CancelRun(ctx context.Context, projectID domain.ProjectID, id pipeline.RunID) (pipeline.RunState, error)
	// StageLog reads a stage's captured stdout+stderr out of the run folder,
	// tailed to the last tailLines lines (0 for the whole log).
	StageLog(ctx context.Context, runID pipeline.RunID, stageID string, tailLines int) (StageLog, error)
	// RunOutput reads one declared `produces` artifact out of the run folder.
	// The filename is authorized against the run's frozen declared set.
	RunOutput(ctx context.Context, runID pipeline.RunID, filename string) (RunOutput, error)

	// PRBlocksMerge reports whether a PR's pipeline runs block it from merging.
	// It is the read side of the lifecycle merge-readiness gate.
	PRBlocksMerge(ctx context.Context, projectID domain.ProjectID, prURL, headSHA string) (bool, error)
	// SignalStage records one `ao pipeline done|fail` against a running stage.
	// The read side is not here: the agent executor polls the concrete Service
	// through executors.SignalReader, not through this HTTP-facing seam.
	SignalStage(ctx context.Context, runID pipeline.RunID, stageID string, kind pipeline.SignalKind, reason string) error

	// Credentials (decision D13): set and delete take values in, listing gives
	// names back. Nothing here returns a value, which is what keeps a secret
	// out of every HTTP response and every line the CLI prints.
	SetCredential(ctx context.Context, projectID domain.ProjectID, name string, env map[string]string) error
	ListCredentialNames(ctx context.Context, projectID domain.ProjectID) ([]string, error)
	DeleteCredential(ctx context.Context, projectID domain.ProjectID, name string) error
}

// Service is the concrete Manager over a Store plus, once wired, the engine
// supervisor.
type Service struct {
	store Store
	// creds is the resolver-dependent second validation pass: it rejects a
	// credential name the project does not declare. Nil skips the pass, which
	// keeps the pure Validate dependency-free for the editor.
	creds pipeline.CredentialResolver
	now   func() time.Time
	newID func() pipeline.ID

	// mu guards engines only. It exists because the daemon wires the engine
	// after the service: the executor set needs this Service as its signal
	// reader, and the supervisor needs the executor set, so the cycle is broken
	// by binding the engines last (see SetEngines).
	mu      sync.RWMutex
	engines Engines
}

// Option customizes a Service (test clocks and id allocators).
type Option func(*Service)

// WithClock overrides the timestamp source.
func WithClock(now func() time.Time) Option {
	return func(s *Service) { s.now = now }
}

// WithIDGen overrides the definition-id allocator.
func WithIDGen(gen func() pipeline.ID) Option {
	return func(s *Service) { s.newID = gen }
}

// WithCredentials wires the credential resolver the save path validates
// against.
func WithCredentials(r pipeline.CredentialResolver) Option {
	return func(s *Service) { s.creds = r }
}

// WithEngines wires the engine supervisor at construction, for callers that
// have one in hand already.
func WithEngines(e Engines) Option {
	return func(s *Service) { s.engines = e }
}

// New builds a Service over the run, definition and signal store.
func New(store Store, opts ...Option) *Service {
	s := &Service{
		store: store,
		now:   func() time.Time { return time.Now().UTC() },
		newID: func() pipeline.ID { return pipeline.ID("pl-" + uuid.NewString()) },
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// SetEngines binds the engine supervisor after construction. It is called once,
// during wiring, before any request is served.
func (s *Service) SetEngines(e Engines) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.engines = e
}

var _ Manager = (*Service)(nil)

// engine resolves the project's engine, or says plainly that there is none.
func (s *Service) engine(ctx context.Context, projectID domain.ProjectID) (Engine, error) {
	s.mu.RLock()
	engines := s.engines
	s.mu.RUnlock()
	if engines == nil {
		return nil, ErrEnginesUnavailable
	}
	return engines.For(ctx, projectID)
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

// ListDefinitions returns every definition for a project.
func (s *Service) ListDefinitions(ctx context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error) {
	return s.store.ListPipelineDefinitions(ctx, projectID)
}

// CreateDefinition validates the raw YAML, assigns identity and timestamps, and
// persists the YAML alongside the parsed snapshot. A duplicate name in the
// project is a 409.
func (s *Service) CreateDefinition(ctx context.Context, projectID domain.ProjectID, yamlSource string) (pipeline.Definition, error) {
	cfg, err := s.parse(ctx, projectID, yamlSource)
	if err != nil {
		return pipeline.Definition{}, err
	}
	if _, ok, err := s.store.GetPipelineDefinitionByName(ctx, projectID, cfg.Name); err != nil {
		return pipeline.Definition{}, err
	} else if ok {
		return pipeline.Definition{}, apierr.Conflict("PIPELINE_NAME_TAKEN",
			fmt.Sprintf("a pipeline named %q already exists in this project", cfg.Name), nil)
	}

	now := s.now()
	def := pipeline.Definition{
		ID:         s.newID(),
		ProjectID:  string(projectID),
		Name:       cfg.Name,
		YAMLSource: yamlSource,
		Config:     *cfg,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := s.store.CreatePipelineDefinition(ctx, def); err != nil {
		return pipeline.Definition{}, err
	}
	return def, nil
}

// UpdateDefinition re-validates the YAML and overwrites the definition in place
// (there is no version history). Runs freeze their definition at trigger time,
// so an edit never touches a run in flight.
func (s *Service) UpdateDefinition(ctx context.Context, id pipeline.ID, yamlSource string) (pipeline.Definition, error) {
	existing, ok, err := s.store.GetPipelineDefinition(ctx, id)
	if err != nil {
		return pipeline.Definition{}, err
	}
	if !ok {
		return pipeline.Definition{}, notFoundDefinition(id)
	}

	projectID := domain.ProjectID(existing.ProjectID)
	cfg, err := s.parse(ctx, projectID, yamlSource)
	if err != nil {
		return pipeline.Definition{}, err
	}
	// A rename must not collide with another definition in the project;
	// without this the UNIQUE(project_id, name) constraint surfaces as a 500
	// instead of the 409 create returns.
	if cfg.Name != existing.Name {
		if other, ok, err := s.store.GetPipelineDefinitionByName(ctx, projectID, cfg.Name); err != nil {
			return pipeline.Definition{}, err
		} else if ok && other.ID != id {
			return pipeline.Definition{}, apierr.Conflict("PIPELINE_NAME_TAKEN",
				fmt.Sprintf("a pipeline named %q already exists in this project", cfg.Name), nil)
		}
	}

	def := pipeline.Definition{
		ID:         id,
		ProjectID:  existing.ProjectID,
		Name:       cfg.Name,
		YAMLSource: yamlSource,
		Config:     *cfg,
		CreatedAt:  existing.CreatedAt,
		UpdatedAt:  s.now(),
	}
	updated, err := s.store.UpdatePipelineDefinition(ctx, def)
	if err != nil {
		return pipeline.Definition{}, err
	}
	if !updated {
		return pipeline.Definition{}, notFoundDefinition(id)
	}
	return def, nil
}

// DeleteDefinition removes a definition. Runs snapshot their definition, so
// existing runs are untouched.
func (s *Service) DeleteDefinition(ctx context.Context, id pipeline.ID) error {
	deleted, err := s.store.DeletePipelineDefinition(ctx, id)
	if err != nil {
		return err
	}
	if !deleted {
		return notFoundDefinition(id)
	}
	return nil
}

// ValidateDefinition dry-runs the parser over the raw YAML and reports the
// outcome as data, never an error envelope: the editor wants the issue list as
// a result. Persists nothing.
//
// Warnings come back on their own channel and survive an invalid document: a
// pipeline can be both unsaveable and worth a second look, and the editor
// renders the two lists differently.
func (s *Service) ValidateDefinition(ctx context.Context, projectID domain.ProjectID, yamlSource string) (bool, []pipeline.Issue, []pipeline.Issue, error) {
	cfg, warnings, err := pipeline.ParseDefinitionWithWarnings([]byte(yamlSource))
	if err != nil {
		return false, issuesFromError(err), warnings, nil
	}
	if err := pipeline.ValidateCredentials(ctx, cfg, string(projectID), s.creds); err != nil {
		var verr *pipeline.ValidationError
		if errors.As(err, &verr) {
			return false, verr.Issues, warnings, nil
		}
		// A store failure is a real error: telling the author to fix a name that
		// is fine would be worse than saying the check could not run.
		return false, nil, nil, err
	}
	return true, nil, warnings, nil
}

// ConfigSchema returns the JSON Schema for the definition document, which the
// editor uses for client-side validation and autocomplete.
func (s *Service) ConfigSchema() []byte { return pipeline.ConfigJSONSchema() }

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// ListRuns returns a project's runs, newest first.
func (s *Service) ListRuns(ctx context.Context, projectID domain.ProjectID, filter pipeline.RunFilter) ([]pipeline.RunState, error) {
	return s.store.ListPipelineRuns(ctx, projectID, filter)
}

// GetRun returns one fully reconstructed run.
func (s *Service) GetRun(ctx context.Context, id pipeline.RunID) (pipeline.RunState, error) {
	run, ok, err := s.store.GetPipelineRun(ctx, id)
	if err != nil {
		return pipeline.RunState{}, err
	}
	if !ok {
		return pipeline.RunState{}, notFoundRun(id)
	}
	return run, nil
}

// TriggerRun resolves the definition reference (id first, then name within the
// project) and starts a run through the project engine.
//
// The subject is resolved server-side, never taken from the caller: a PR number
// is looked up against the project's tracked PRs so the run carries the real
// head SHA, branches and fork provenance. The fork flag in particular decides
// whether any credential is injected anywhere in the run (spec section 8), so
// letting a client assert it would be a hole.
func (s *Service) TriggerRun(ctx context.Context, projectID domain.ProjectID, in TriggerInput) (pipeline.RunID, error) {
	def, err := s.resolveDefinition(ctx, projectID, in.Ref)
	if err != nil {
		return "", err
	}
	subject, err := s.resolveSubject(ctx, projectID, in)
	if err != nil {
		return "", err
	}
	eng, err := s.engine(ctx, projectID)
	if err != nil {
		return "", err
	}
	runID, err := eng.TriggerRun(triggers.TriggerRequest{Definition: def, Event: "manual", Subject: subject})
	if err != nil {
		return "", apierr.Invalid("PIPELINE_TRIGGER_REJECTED", err.Error(), nil)
	}
	return runID, nil
}

// resolveSubject turns a manual trigger's optional pointers into the subject the
// run is about: a PR when a number was given, else a session, else the project
// (which is first-class, spec section 4).
func (s *Service) resolveSubject(ctx context.Context, projectID domain.ProjectID, in TriggerInput) (pipeline.Subject, error) {
	if in.PRNumber > 0 {
		return s.prSubject(ctx, projectID, in.PRNumber)
	}
	if in.SessionID != "" {
		return pipeline.Subject{Kind: pipeline.SubjectSession, ProjectID: string(projectID), SessionID: in.SessionID}, nil
	}
	return pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: string(projectID)}, nil
}

// prSubject looks up one tracked PR by number within the project.
//
// ponytail: the pr table is keyed by url and reaches a project only through the
// session that tracks it, so this walks the project's sessions. Manual triggers
// are a human clicking a button; add a project-scoped PR query if that stops
// being true.
func (s *Service) prSubject(ctx context.Context, projectID domain.ProjectID, number int) (pipeline.Subject, error) {
	sessions, err := s.store.ListSessions(ctx, projectID)
	if err != nil {
		return pipeline.Subject{}, err
	}
	for _, sess := range sessions {
		prs, err := s.store.ListPRsBySession(ctx, sess.ID)
		if err != nil {
			return pipeline.Subject{}, err
		}
		for _, pr := range prs {
			if pr.Number != number {
				continue
			}
			return pipeline.Subject{
				Kind:      pipeline.SubjectPR,
				ProjectID: string(projectID),
				SessionID: string(pr.SessionID),
				PR: &pipeline.PRRef{
					Number:     pr.Number,
					Repo:       pr.Repo,
					URL:        pr.URL,
					HeadSHA:    pr.HeadSHA,
					HeadBranch: pr.SourceBranch,
					BaseBranch: pr.TargetBranch,
					// Unknown provenance is treated as a fork: identity-only is
					// the fail-safe answer when nobody can say where the head
					// lives (decision D17).
					FromFork: pr.IsFromFork == nil || *pr.IsFromFork,
				},
			}, nil
		}
	}
	return pipeline.Subject{}, apierr.NotFound("PIPELINE_PR_NOT_FOUND",
		fmt.Sprintf("this project tracks no pull request #%d", number))
}

// CancelRun tears an in-flight run down through the project engine and returns
// the post-cancel state read back from the store. Cancelling an unknown run is
// a 404; cancelling a settled one is an idempotent no-op.
func (s *Service) CancelRun(ctx context.Context, projectID domain.ProjectID, id pipeline.RunID) (pipeline.RunState, error) {
	if _, err := s.GetRun(ctx, id); err != nil {
		return pipeline.RunState{}, err
	}
	eng, err := s.engine(ctx, projectID)
	if err != nil {
		return pipeline.RunState{}, err
	}
	eng.Cancel(id, "cancelled from the API")
	// Cancel is synchronous on the engine actor (its persist effect runs before
	// it returns), so the read-back reflects the cancellation.
	return s.GetRun(ctx, id)
}

// PRBlocksMerge holds no opinion. v2 has no blocks-merge contract: a pipeline
// reports outcomes, and gating a merge on one is a separate feature nobody has
// specified. Pipelines must never fabricate a block.
func (s *Service) PRBlocksMerge(context.Context, domain.ProjectID, string, string) (bool, error) {
	return false, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (s *Service) resolveDefinition(ctx context.Context, projectID domain.ProjectID, ref string) (pipeline.Definition, error) {
	if ref == "" {
		return pipeline.Definition{}, apierr.Invalid("PIPELINE_REF_REQUIRED", "a pipeline id or name is required", nil)
	}
	if def, ok, err := s.store.GetPipelineDefinition(ctx, pipeline.ID(ref)); err != nil {
		return pipeline.Definition{}, err
	} else if ok && def.ProjectID == string(projectID) {
		return def, nil
	}
	if def, ok, err := s.store.GetPipelineDefinitionByName(ctx, projectID, ref); err != nil {
		return pipeline.Definition{}, err
	} else if ok {
		return def, nil
	}
	return pipeline.Definition{}, apierr.NotFound("PIPELINE_NOT_FOUND",
		fmt.Sprintf("no pipeline definition %q in this project", ref))
}

// parse validates raw YAML for the save path: the pure rules first, then the
// resolver-dependent credential pass. A *pipeline.ValidationError passes
// through untouched so the editor surfaces every problem at once, while a bare
// YAML syntax error becomes a 400 rather than a 500.
func (s *Service) parse(ctx context.Context, projectID domain.ProjectID, yamlSource string) (*pipeline.Pipeline, error) {
	cfg, err := pipeline.ParseDefinition([]byte(yamlSource))
	if err != nil {
		var verr *pipeline.ValidationError
		if errors.As(err, &verr) {
			return nil, verr
		}
		return nil, apierr.Invalid("PIPELINE_PARSE_ERROR", err.Error(), nil)
	}
	if err := pipeline.ValidateCredentials(ctx, cfg, string(projectID), s.creds); err != nil {
		return nil, err
	}
	return cfg, nil
}

// issuesFromError renders a parse failure as the editor's Problems list: a
// validation error keeps its per-path issues, and a bare syntax error becomes
// one root-path issue rather than an error envelope.
func issuesFromError(err error) []pipeline.Issue {
	var verr *pipeline.ValidationError
	if errors.As(err, &verr) {
		return verr.Issues
	}
	return []pipeline.Issue{{Path: "", Message: err.Error()}}
}

func notFoundDefinition(id pipeline.ID) error {
	return apierr.NotFound("PIPELINE_DEFINITION_NOT_FOUND", fmt.Sprintf("no pipeline definition %q", id))
}

func notFoundRun(id pipeline.RunID) error {
	return apierr.NotFound("PIPELINE_RUN_NOT_FOUND", fmt.Sprintf("no pipeline run %q", id))
}
