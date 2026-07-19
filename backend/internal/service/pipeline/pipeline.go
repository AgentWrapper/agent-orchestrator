// Package pipelinesvc is the read/write service boundary for the Pipelines v1
// HTTP API (spec §7, T7). It sits between the pipelines controller and the two
// merged foundations it orchestrates: the SQLite store (definitions CRUD, runs,
// artifacts) and the per-project engine supervisor (manual trigger, cancel,
// resume, config-change termination).
//
// Definition authoring runs YAML through pipeline.ParseDefinition so the editor
// (T9) sees every validation issue in one pass; run lifecycle mutations route
// through the engine (never the store) so run state stays owned by the actor
// loop (spec §6, §9 note 4). The engine's own docs warn that its methods must
// be called from request handlers, not from inside a sink/executor — this
// service is exactly that request-handler path.
package pipelinesvc

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/engine"
)

// Store is the persistence surface the service reads and writes. It is a subset
// of *storage/sqlite/store.Store, kept narrow so the service unit-tests against
// a fake and never reaches past the documented CRUD methods.
type Store interface {
	ListPipelineDefinitions(ctx context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error)
	GetPipelineDefinition(ctx context.Context, id pipeline.ID) (pipeline.Definition, bool, error)
	GetPipelineDefinitionByName(ctx context.Context, projectID domain.ProjectID, name string) (pipeline.Definition, bool, error)
	CreatePipelineDefinition(ctx context.Context, def pipeline.Definition) error
	UpdatePipelineDefinition(ctx context.Context, def pipeline.Definition) (bool, error)
	DeletePipelineDefinition(ctx context.Context, id pipeline.ID) (bool, error)

	ListPipelineRuns(ctx context.Context, projectID domain.ProjectID, filter pipeline.RunFilter) ([]pipeline.RunState, error)
	GetPipelineRun(ctx context.Context, id pipeline.RunID) (pipeline.RunState, bool, error)
	GetPipelineArtifact(ctx context.Context, id pipeline.ArtifactID) (pipeline.Artifact, bool, error)
}

// Engine is the per-project runtime surface the service drives for run
// lifecycle. It is the subset of *engine.Engine used from request handlers.
type Engine interface {
	TriggerRun(req engine.TriggerRequest) (pipeline.RunID, error)
	Cancel(runID pipeline.RunID, reason pipeline.RunTerminationReason)
	Resume(runID pipeline.RunID)
	Dispatch(event pipeline.Event)
	State() pipeline.EngineState
}

// Engines resolves the engine for a project. *engine.Supervisor satisfies this
// via SupervisorEngines; tests inject a fake that hands back a real engine.
type Engines interface {
	For(ctx context.Context, projectID domain.ProjectID) (Engine, error)
}

// SupervisorEngines adapts a *engine.Supervisor (whose For returns the concrete
// *engine.Engine) to the Engines interface the service depends on.
func SupervisorEngines(sup *engine.Supervisor) Engines {
	return supervisorEngines{sup: sup}
}

type supervisorEngines struct{ sup *engine.Supervisor }

func (s supervisorEngines) For(ctx context.Context, projectID domain.ProjectID) (Engine, error) {
	return s.sup.For(ctx, projectID)
}

// TriggerInput is the manual-trigger request: a definition reference (id or
// name) plus optional session and head SHA. The service resolves the reference
// to a stored definition and starts a run through the project engine.
type TriggerInput struct {
	// Ref is the definition id or name to run.
	Ref string
	// SessionID scopes the loop key; empty is allowed (an unscoped manual run).
	SessionID string
	// HeadSHA pins the run to a commit; empty is allowed.
	HeadSHA string
}

// Manager is the pipelines service the HTTP controller depends on. A nil
// Manager keeps the routes registered but returns 501 (mirrors the other
// controllers).
type Manager interface {
	ListDefinitions(ctx context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error)
	CreateDefinition(ctx context.Context, projectID domain.ProjectID, yamlSource string) (pipeline.Definition, error)
	UpdateDefinition(ctx context.Context, id pipeline.ID, yamlSource string) (pipeline.Definition, error)
	DeleteDefinition(ctx context.Context, id pipeline.ID) error
	ValidateDefinition(ctx context.Context, yamlSource string) (valid bool, issues []pipeline.Issue, err error)
	ConfigSchema() []byte

	ListRuns(ctx context.Context, projectID domain.ProjectID, filter pipeline.RunFilter) ([]pipeline.RunState, error)
	GetRun(ctx context.Context, id pipeline.RunID) (pipeline.RunState, error)
	CancelRun(ctx context.Context, projectID domain.ProjectID, id pipeline.RunID) (pipeline.RunState, error)
	ResumeRun(ctx context.Context, projectID domain.ProjectID, id pipeline.RunID) (pipeline.RunState, error)
	TriggerRun(ctx context.Context, projectID domain.ProjectID, in TriggerInput) (pipeline.RunID, error)
	GetArtifact(ctx context.Context, id pipeline.ArtifactID) (pipeline.Artifact, error)
}

// Service is the concrete Manager over a Store + Engines.
type Service struct {
	store   Store
	engines Engines
	now     func() time.Time
	newID   func() pipeline.ID
}

// Option customizes a Service (test clocks / id allocators).
type Option func(*Service)

// WithClock overrides the timestamp source (definition created/updated stamps).
func WithClock(now func() time.Time) Option {
	return func(s *Service) { s.now = now }
}

// WithIDGen overrides the definition-id allocator.
func WithIDGen(gen func() pipeline.ID) Option {
	return func(s *Service) { s.newID = gen }
}

// New builds a Service. store and engines are required.
func New(store Store, engines Engines, opts ...Option) *Service {
	s := &Service{
		store:   store,
		engines: engines,
		now:     func() time.Time { return time.Now().UTC() },
		newID:   func() pipeline.ID { return pipeline.ID("pl-" + uuid.NewString()) },
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

var _ Manager = (*Service)(nil)

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

// ListDefinitions returns every definition for a project.
func (s *Service) ListDefinitions(ctx context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error) {
	return s.store.ListPipelineDefinitions(ctx, projectID)
}

// CreateDefinition validates the raw YAML, assigns identity + timestamps, and
// persists both the YAML and the normalized config. A parse/validation failure
// is returned verbatim (a *pipeline.ValidationError carries the full issue list
// the editor surfaces); a duplicate name in the project is a 409.
func (s *Service) CreateDefinition(ctx context.Context, projectID domain.ProjectID, yamlSource string) (pipeline.Definition, error) {
	cfg, err := parse(yamlSource)
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
	id := s.newID()
	cfg.ID = id
	def := pipeline.Definition{
		ID:         id,
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
// (v1 has no version history). After a successful update it terminates any
// in-flight run of the old config by dispatching CONFIG_CHANGED for each
// affected loop through the project engine (spec §6); the failure to reach the
// engine is non-fatal to the write (the definition is already persisted).
func (s *Service) UpdateDefinition(ctx context.Context, id pipeline.ID, yamlSource string) (pipeline.Definition, error) {
	existing, ok, err := s.store.GetPipelineDefinition(ctx, id)
	if err != nil {
		return pipeline.Definition{}, err
	}
	if !ok {
		return pipeline.Definition{}, notFoundDefinition(id)
	}

	cfg, err := parse(yamlSource)
	if err != nil {
		return pipeline.Definition{}, err
	}
	// A rename must not collide with another definition's name in the project;
	// without this check the UNIQUE(project_id, name) constraint surfaces as a
	// raw 500 instead of the same 409 CreateDefinition returns.
	if cfg.Name != existing.Name {
		if other, ok, err := s.store.GetPipelineDefinitionByName(ctx, domain.ProjectID(existing.ProjectID), cfg.Name); err != nil {
			return pipeline.Definition{}, err
		} else if ok && other.ID != id {
			return pipeline.Definition{}, apierr.Conflict("PIPELINE_NAME_TAKEN",
				fmt.Sprintf("a pipeline named %q already exists in this project", cfg.Name), nil)
		}
	}
	cfg.ID = id
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

	s.terminateInFlight(ctx, domain.ProjectID(existing.ProjectID), id)
	return def, nil
}

// DeleteDefinition removes a definition. Runs snapshot their config, so existing
// runs are untouched.
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

// ValidateDefinition dry-runs ParseDefinition over the raw YAML and reports the
// outcome as data (never an error envelope): a valid document yields
// (true, nil, nil); a validation failure yields (false, issues, nil) carrying
// the full multi-issue list with dotted paths; a bare YAML syntax / unknown-field
// error is surfaced as a single root-path issue so the visual editor renders it
// in the Problems list rather than as a request error. Persists nothing. The
// err return is reserved for genuine infrastructure failures (none today), so
// the editor can treat a nil err as "the answer is the issue list".
func (s *Service) ValidateDefinition(_ context.Context, yamlSource string) (bool, []pipeline.Issue, error) {
	if _, err := pipeline.ParseDefinition([]byte(yamlSource)); err != nil {
		var verr *pipeline.ValidationError
		if errors.As(err, &verr) {
			return false, verr.Issues, nil
		}
		return false, []pipeline.Issue{{Path: "", Message: err.Error()}}, nil
	}
	return true, nil, nil
}

// ConfigSchema returns the JSON Schema for the YAML definition document, for the
// editor's client-side validation/autocomplete (T9).
func (s *Service) ConfigSchema() []byte {
	return pipeline.ConfigJSONSchema()
}

// terminateInFlight dispatches CONFIG_CHANGED for every non-terminal run of the
// updated definition so runs pinned to the old config stop. Best-effort: if the
// project has no engine yet (nothing has triggered), there is nothing to stop.
func (s *Service) terminateInFlight(ctx context.Context, projectID domain.ProjectID, defID pipeline.ID) {
	eng, err := s.engines.For(ctx, projectID)
	if err != nil {
		return
	}
	now := s.now()
	seen := map[string]bool{}
	for _, run := range eng.State().Runs {
		if run.PipelineID != defID || run.LoopState.IsTerminal() {
			continue
		}
		key := pipeline.LoopKey(run.SessionID, run.PipelineName)
		if seen[key] {
			continue
		}
		seen[key] = true
		eng.Dispatch(pipeline.ConfigChanged{Now: now, SessionID: run.SessionID, PipelineName: run.PipelineName})
	}
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// ListRuns returns runs for a project, newest first, filtered per RunFilter.
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

// CancelRun terminates an in-flight run through the project engine, then returns
// the run's post-cancel state read back from the store. Cancelling an unknown
// run is a 404; cancelling an already-terminal run is an idempotent no-op that
// returns the current state.
func (s *Service) CancelRun(ctx context.Context, projectID domain.ProjectID, id pipeline.RunID) (pipeline.RunState, error) {
	if _, err := s.GetRun(ctx, id); err != nil {
		return pipeline.RunState{}, err
	}
	eng, err := s.engines.For(ctx, projectID)
	if err != nil {
		return pipeline.RunState{}, err
	}
	eng.Cancel(id, pipeline.TerminationManualCancel)
	return s.GetRun(ctx, id)
}

// ResumeRun re-arms a stalled/failed run through the project engine and returns
// the post-resume state.
func (s *Service) ResumeRun(ctx context.Context, projectID domain.ProjectID, id pipeline.RunID) (pipeline.RunState, error) {
	if _, err := s.GetRun(ctx, id); err != nil {
		return pipeline.RunState{}, err
	}
	eng, err := s.engines.For(ctx, projectID)
	if err != nil {
		return pipeline.RunState{}, err
	}
	eng.Resume(id)
	return s.GetRun(ctx, id)
}

// TriggerRun resolves the definition reference (id first, then name within the
// project) and starts a manual run through the project engine, returning the new
// run id. An unresolvable reference is a 404.
func (s *Service) TriggerRun(ctx context.Context, projectID domain.ProjectID, in TriggerInput) (pipeline.RunID, error) {
	def, err := s.resolveDefinition(ctx, projectID, in.Ref)
	if err != nil {
		return "", err
	}
	eng, err := s.engines.For(ctx, projectID)
	if err != nil {
		return "", err
	}
	runID, err := eng.TriggerRun(engine.TriggerRequest{
		Pipeline:  def.Config,
		SessionID: in.SessionID,
		Trigger:   pipeline.TriggerManual,
		HeadSHA:   in.HeadSHA,
	})
	if err != nil {
		// A structurally invalid snapshot (cycle) is the only TriggerRun error;
		// surface it as an unprocessable definition rather than a 500.
		return "", apierr.Invalid("PIPELINE_TRIGGER_REJECTED", err.Error(), nil)
	}
	return runID, nil
}

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

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

// GetArtifact returns one artifact blob by id.
func (s *Service) GetArtifact(ctx context.Context, id pipeline.ArtifactID) (pipeline.Artifact, error) {
	art, ok, err := s.store.GetPipelineArtifact(ctx, id)
	if err != nil {
		return pipeline.Artifact{}, err
	}
	if !ok {
		return pipeline.Artifact{}, apierr.NotFound("PIPELINE_ARTIFACT_NOT_FOUND",
			fmt.Sprintf("no artifact %q", id))
	}
	return art, nil
}

// parse validates raw YAML, passing a *pipeline.ValidationError (the full issue
// list) through untouched so the editor surfaces every problem, while mapping a
// bare YAML syntax / unknown-field error to a 400 rather than a 500.
func parse(yamlSource string) (*pipeline.Pipeline, error) {
	cfg, err := pipeline.ParseDefinition([]byte(yamlSource))
	if err == nil {
		return cfg, nil
	}
	var verr *pipeline.ValidationError
	if errors.As(err, &verr) {
		return nil, verr
	}
	return nil, apierr.Invalid("PIPELINE_PARSE_ERROR", err.Error(), nil)
}

func notFoundDefinition(id pipeline.ID) error {
	return apierr.NotFound("PIPELINE_DEFINITION_NOT_FOUND", fmt.Sprintf("no pipeline definition %q", id))
}

func notFoundRun(id pipeline.RunID) error {
	return apierr.NotFound("PIPELINE_RUN_NOT_FOUND", fmt.Sprintf("no pipeline run %q", id))
}
