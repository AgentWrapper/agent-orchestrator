package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// This file backs Pipelines v2. SQLite is the store of record: the run folder's
// run.json is a projection for humans, and everything the engine needs to
// resume after a restart lives here (decision D2).
//
// A run is normalized across two tables: pipeline_runs holds the run scalars,
// the flattened subject, and the frozen definition; pipeline_stage_runs holds
// one row per stage. hydrateRun reassembles a pipeline.RunState from both, and
// SavePipelineRun writes both in one transaction so a reader never sees a run
// whose stages are half-updated.

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

// CreatePipelineDefinition inserts a new definition. The raw YAML as authored
// and the parsed snapshot are stored side by side: humans edit YAML, runs
// freeze the parsed form.
func (s *Store) CreatePipelineDefinition(ctx context.Context, def pipeline.Definition) error {
	cfg, err := json.Marshal(def.Config)
	if err != nil {
		return fmt.Errorf("marshal pipeline config %s: %w", def.Name, err)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.CreatePipelineDefinition(ctx, gen.CreatePipelineDefinitionParams{
		ID:         string(def.ID),
		ProjectID:  domain.ProjectID(def.ProjectID),
		Name:       def.Name,
		YamlSource: def.YAMLSource,
		ConfigJson: string(cfg),
		CreatedAt:  def.CreatedAt,
		UpdatedAt:  def.UpdatedAt,
	})
}

// GetPipelineDefinition returns a definition by id, ok=false if none.
func (s *Store) GetPipelineDefinition(ctx context.Context, id pipeline.ID) (pipeline.Definition, bool, error) {
	row, err := s.qr.GetPipelineDefinition(ctx, string(id))
	if errors.Is(err, sql.ErrNoRows) {
		return pipeline.Definition{}, false, nil
	}
	if err != nil {
		return pipeline.Definition{}, false, fmt.Errorf("get pipeline definition %s: %w", id, err)
	}
	def, err := definitionFromRow(row)
	if err != nil {
		return pipeline.Definition{}, false, err
	}
	return def, true, nil
}

// GetPipelineDefinitionByName resolves a definition by (project, name), the
// natural reference for CLI and manual triggers. ok=false if none.
func (s *Store) GetPipelineDefinitionByName(ctx context.Context, projectID domain.ProjectID, name string) (pipeline.Definition, bool, error) {
	row, err := s.qr.GetPipelineDefinitionByName(ctx, gen.GetPipelineDefinitionByNameParams{ProjectID: projectID, Name: name})
	if errors.Is(err, sql.ErrNoRows) {
		return pipeline.Definition{}, false, nil
	}
	if err != nil {
		return pipeline.Definition{}, false, fmt.Errorf("get pipeline definition %s/%s: %w", projectID, name, err)
	}
	def, err := definitionFromRow(row)
	if err != nil {
		return pipeline.Definition{}, false, err
	}
	return def, true, nil
}

// ListPipelineDefinitions returns every definition for a project, by name.
func (s *Store) ListPipelineDefinitions(ctx context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error) {
	rows, err := s.qr.ListPipelineDefinitions(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("list pipeline definitions for %s: %w", projectID, err)
	}
	out := make([]pipeline.Definition, 0, len(rows))
	for _, row := range rows {
		def, err := definitionFromRow(row)
		if err != nil {
			return nil, err
		}
		out = append(out, def)
	}
	return out, nil
}

// UpdatePipelineDefinition overwrites a definition's name, YAML and config in
// place (there is no version history). Runs freeze their definition, so an
// edit never touches a run in flight. ok=false when no row matched the id.
func (s *Store) UpdatePipelineDefinition(ctx context.Context, def pipeline.Definition) (bool, error) {
	cfg, err := json.Marshal(def.Config)
	if err != nil {
		return false, fmt.Errorf("marshal pipeline config %s: %w", def.Name, err)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdatePipelineDefinition(ctx, gen.UpdatePipelineDefinitionParams{
		Name:       def.Name,
		YamlSource: def.YAMLSource,
		ConfigJson: string(cfg),
		UpdatedAt:  def.UpdatedAt,
		ID:         string(def.ID),
	})
	if err != nil {
		return false, fmt.Errorf("update pipeline definition %s: %w", def.ID, err)
	}
	return n > 0, nil
}

// DeletePipelineDefinition removes a definition. Existing runs keep their
// frozen copy and are untouched. ok=false if no row matched.
func (s *Store) DeletePipelineDefinition(ctx context.Context, id pipeline.ID) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.DeletePipelineDefinition(ctx, string(id))
	if err != nil {
		return false, fmt.Errorf("delete pipeline definition %s: %w", id, err)
	}
	return n > 0, nil
}

// ---------------------------------------------------------------------------
// Runs (+ stage runs, persisted atomically)
// ---------------------------------------------------------------------------

// SavePipelineRun upserts a run and every one of its stage rows in a single
// transaction (the engine's persist effect). Stage rows are never deleted
// here: the plan-at-start walk enumerates every reachable stage before
// anything runs, so the stage set of a run does not shrink.
//
// It takes a pointer because the run row is where RunNumber is assigned: the
// insert allocates the next per-pipeline number and returns it, and the caller
// needs it back before it writes run.json. On a later save the returned number
// is the one the row already carried, so the write-back is a no-op.
func (s *Store) SavePipelineRun(ctx context.Context, run *pipeline.RunState) error {
	params, err := runUpsertParams(*run)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "save pipeline run", func(q *gen.Queries) error {
		number, err := q.UpsertPipelineRun(ctx, params)
		if err != nil {
			return err
		}
		run.RunNumber = int(number)
		for id, st := range run.Stages {
			if st == nil {
				continue
			}
			if err := q.UpsertPipelineStageRun(ctx, stageUpsertParams(*run, id, st)); err != nil {
				return err
			}
		}
		return nil
	})
}

// GetPipelineRun returns a fully reconstructed run, ok=false if none.
func (s *Store) GetPipelineRun(ctx context.Context, id pipeline.RunID) (pipeline.RunState, bool, error) {
	row, err := s.qr.GetPipelineRun(ctx, string(id))
	if errors.Is(err, sql.ErrNoRows) {
		return pipeline.RunState{}, false, nil
	}
	if err != nil {
		return pipeline.RunState{}, false, fmt.Errorf("get pipeline run %s: %w", id, err)
	}
	run, err := hydrateRun(ctx, s.qr, row)
	if err != nil {
		return pipeline.RunState{}, false, err
	}
	return run, true, nil
}

// ListPipelineRuns returns a project's runs newest-first, optionally narrowed
// by pipeline name, run status and count. Each run comes back fully
// reconstructed, because the Kanban card renders stage outcomes.
func (s *Store) ListPipelineRuns(ctx context.Context, projectID domain.ProjectID, filter pipeline.RunFilter) ([]pipeline.RunState, error) {
	params := gen.ListPipelineRunsParams{ProjectID: projectID, Lim: -1}
	if filter.PipelineName != "" {
		params.PipelineName = sql.NullString{String: filter.PipelineName, Valid: true}
	}
	if filter.Status != "" {
		params.Status = sql.NullString{String: filter.Status, Valid: true}
	}
	if filter.Limit > 0 {
		params.Lim = int64(filter.Limit)
	}
	rows, err := s.qr.ListPipelineRuns(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("list pipeline runs for %s: %w", projectID, err)
	}
	return hydrateRuns(ctx, s.qr, rows)
}

// ---------------------------------------------------------------------------
// Stage signals
// ---------------------------------------------------------------------------

// AppendPipelineStageSignal records one `ao pipeline done|fail`. Signals are
// append-only; a stage signalled again after a nudge gets a second row and the
// reader takes the newest.
func (s *Store) AppendPipelineStageSignal(ctx context.Context, sig pipeline.StageSignal) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	err := s.qw.InsertPipelineStageSignal(ctx, gen.InsertPipelineStageSignalParams{
		RunID:     string(sig.RunID),
		StageID:   sig.StageID,
		Kind:      string(sig.Kind),
		Reason:    sig.Reason,
		CreatedAt: sig.CreatedAt,
	})
	if err != nil {
		return fmt.Errorf("append pipeline stage signal %s/%s: %w", sig.RunID, sig.StageID, err)
	}
	return nil
}

// LatestPipelineStageSignal returns the newest signal for a (run, stage),
// ok=false when the stage has not signalled.
func (s *Store) LatestPipelineStageSignal(ctx context.Context, runID pipeline.RunID, stageID string) (pipeline.StageSignal, bool, error) {
	row, err := s.qr.GetLatestPipelineStageSignal(ctx, gen.GetLatestPipelineStageSignalParams{
		RunID:   string(runID),
		StageID: stageID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return pipeline.StageSignal{}, false, nil
	}
	if err != nil {
		return pipeline.StageSignal{}, false, fmt.Errorf("latest pipeline stage signal %s/%s: %w", runID, stageID, err)
	}
	return pipeline.StageSignal{
		RunID:     pipeline.RunID(row.RunID),
		StageID:   row.StageID,
		Kind:      pipeline.SignalKind(row.Kind),
		Reason:    row.Reason,
		CreatedAt: row.CreatedAt,
	}, true, nil
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

// SetPipelineCredential creates or replaces a named credential. The env map is
// stored wholesale: setting a name again replaces its whole environment rather
// than merging, so removing a variable is possible.
func (s *Store) SetPipelineCredential(ctx context.Context, projectID domain.ProjectID, name string, env map[string]string, now time.Time) error {
	if env == nil {
		env = map[string]string{}
	}
	blob, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("marshal pipeline credential %s/%s: %w", projectID, name, err)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	err = s.qw.UpsertPipelineCredential(ctx, gen.UpsertPipelineCredentialParams{
		ProjectID: projectID,
		Name:      name,
		EnvJson:   string(blob),
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		return fmt.Errorf("set pipeline credential %s/%s: %w", projectID, name, err)
	}
	return nil
}

// GetPipelineCredential returns a credential's environment for injection into
// a command stage. This is the only read path that returns values, and it is
// daemon-internal: nothing that reaches a user, a log line or an agent's
// environment goes through it (decision D13).
func (s *Store) GetPipelineCredential(ctx context.Context, projectID domain.ProjectID, name string) (map[string]string, bool, error) {
	blob, err := s.qr.GetPipelineCredential(ctx, gen.GetPipelineCredentialParams{ProjectID: projectID, Name: name})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("get pipeline credential %s/%s: %w", projectID, name, err)
	}
	var env map[string]string
	if err := json.Unmarshal([]byte(blob), &env); err != nil {
		return nil, false, fmt.Errorf("unmarshal pipeline credential %s/%s: %w", projectID, name, err)
	}
	return env, true, nil
}

// ListPipelineCredentialNames returns the declared credential names for a
// project, sorted. Names only, never values.
func (s *Store) ListPipelineCredentialNames(ctx context.Context, projectID domain.ProjectID) ([]string, error) {
	names, err := s.qr.ListPipelineCredentialNames(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("list pipeline credentials for %s: %w", projectID, err)
	}
	return names, nil
}

// DeletePipelineCredential removes a credential, ok=false if no row matched.
func (s *Store) DeletePipelineCredential(ctx context.Context, projectID domain.ProjectID, name string) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.DeletePipelineCredential(ctx, gen.DeletePipelineCredentialParams{ProjectID: projectID, Name: name})
	if err != nil {
		return false, fmt.Errorf("delete pipeline credential %s/%s: %w", projectID, name, err)
	}
	return n > 0, nil
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

// hydrateRuns reassembles every run in rows, preserving their order.
func hydrateRuns(ctx context.Context, q *gen.Queries, rows []gen.PipelineRun) ([]pipeline.RunState, error) {
	out := make([]pipeline.RunState, 0, len(rows))
	for _, row := range rows {
		run, err := hydrateRun(ctx, q, row)
		if err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, nil
}

// hydrateRun reassembles a pipeline.RunState from its run row plus its stage
// rows. Nudged is rebuilt from the per-stage flag and stays nil when no stage
// was ever nudged, which is the state the reducer produces for a fresh run.
func hydrateRun(ctx context.Context, q *gen.Queries, row gen.PipelineRun) (pipeline.RunState, error) {
	var def pipeline.Pipeline
	if err := json.Unmarshal([]byte(row.DefinitionJson), &def); err != nil {
		return pipeline.RunState{}, fmt.Errorf("unmarshal frozen definition for run %s: %w", row.ID, err)
	}

	stageRows, err := q.ListPipelineStageRunsByRun(ctx, row.ID)
	if err != nil {
		return pipeline.RunState{}, fmt.Errorf("list stage runs for run %s: %w", row.ID, err)
	}
	stages := make(map[string]*pipeline.StageState, len(stageRows))
	var nudged map[string]bool
	for _, sr := range stageRows {
		st := stageStateFromRow(sr)
		stages[sr.StageID] = &st
		if sr.Nudged != 0 {
			if nudged == nil {
				nudged = make(map[string]bool, len(stageRows))
			}
			nudged[sr.StageID] = true
		}
	}

	return pipeline.RunState{
		RunID:        pipeline.RunID(row.ID),
		ProjectID:    string(row.ProjectID),
		PipelineID:   pipeline.ID(row.PipelineID),
		RunNumber:    int(row.RunNumber),
		PipelineName: row.PipelineName,
		Subject:      subjectFromRow(row),
		Status:       pipeline.RunStatus(row.Status),
		RunDir:       row.RunDir,
		Def:          def,
		Stages:       stages,
		Nudged:       nudged,
		CancelReason: row.CancelReason,
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
		SettledAt:    timeFromNullTime(row.SettledAt),
	}, nil
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

func definitionFromRow(r gen.PipelineDefinition) (pipeline.Definition, error) {
	var cfg pipeline.Pipeline
	if err := json.Unmarshal([]byte(r.ConfigJson), &cfg); err != nil {
		return pipeline.Definition{}, fmt.Errorf("unmarshal pipeline config %s: %w", r.ID, err)
	}
	return pipeline.Definition{
		ID:         pipeline.ID(r.ID),
		ProjectID:  string(r.ProjectID),
		Name:       r.Name,
		YAMLSource: r.YamlSource,
		Config:     cfg,
		CreatedAt:  r.CreatedAt,
		UpdatedAt:  r.UpdatedAt,
	}, nil
}

func runUpsertParams(run pipeline.RunState) (gen.UpsertPipelineRunParams, error) {
	def, err := json.Marshal(run.Def)
	if err != nil {
		return gen.UpsertPipelineRunParams{}, fmt.Errorf("marshal frozen definition for run %s: %w", run.RunID, err)
	}
	params := gen.UpsertPipelineRunParams{
		ID:             string(run.RunID),
		ProjectID:      domain.ProjectID(run.ProjectID),
		PipelineID:     string(run.PipelineID),
		PipelineName:   run.PipelineName,
		SubjectKind:    string(run.Subject.Kind),
		SessionID:      run.Subject.SessionID,
		Status:         string(run.Status),
		RunDir:         run.RunDir,
		DefinitionJson: string(def),
		CancelReason:   run.CancelReason,
		CreatedAt:      run.CreatedAt,
		UpdatedAt:      run.UpdatedAt,
		SettledAt:      nullTimeFromTime(run.SettledAt),
	}
	if pr := run.Subject.PR; pr != nil {
		params.PRNumber = int64(pr.Number)
		params.PRRepo = pr.Repo
		params.PRURL = pr.URL
		params.HeadSha = pr.HeadSHA
		params.PRHeadBranch = pr.HeadBranch
		params.PRBaseBranch = pr.BaseBranch
		params.FromFork = boolToInt64(pr.FromFork)
	}
	return params, nil
}

// subjectFromRow rebuilds the subject from its flattened columns. The PR half
// is present exactly when the row carries a PR identity, so a session or
// project subject never comes back holding a zero-valued PRRef.
func subjectFromRow(r gen.PipelineRun) pipeline.Subject {
	s := pipeline.Subject{
		Kind:      pipeline.SubjectKind(r.SubjectKind),
		ProjectID: string(r.ProjectID),
		SessionID: r.SessionID,
	}
	if r.PRNumber != 0 || r.PRRepo != "" || r.PRURL != "" {
		s.PR = &pipeline.PRRef{
			Number:     int(r.PRNumber),
			Repo:       r.PRRepo,
			URL:        r.PRURL,
			HeadSHA:    r.HeadSha,
			HeadBranch: r.PRHeadBranch,
			BaseBranch: r.PRBaseBranch,
			FromFork:   r.FromFork != 0,
		}
	}
	return s
}

func stageUpsertParams(run pipeline.RunState, stageID string, st *pipeline.StageState) gen.UpsertPipelineStageRunParams {
	return gen.UpsertPipelineStageRunParams{
		RunID:         string(run.RunID),
		ProjectID:     domain.ProjectID(run.ProjectID),
		StageID:       stageID,
		Outcome:       string(st.Outcome),
		Attempt:       int64(st.Attempt),
		EnteredVia:    string(st.EnteredVia),
		PrevStage:     st.PrevStage,
		FailedStage:   st.FailedStage,
		FailedOutcome: string(st.FailedOutcome),
		SessionID:     st.SessionID,
		WorkspaceKind: string(st.WorkspaceKind),
		WorkspacePath: st.WorkspacePath,
		DeadlineAt:    nullTimeFromTime(st.DeadlineAt),
		StartedAt:     nullTimeFromTime(st.StartedAt),
		SettledAt:     nullTimeFromTime(st.SettledAt),
		Reason:        st.Reason,
		OutputTail:    st.OutputTail,
		Nudged:        boolToInt64(run.Nudged[stageID]),
		Pgid:          int64(st.PGID),
	}
}

func stageStateFromRow(r gen.PipelineStageRun) pipeline.StageState {
	return pipeline.StageState{
		ID:            r.StageID,
		Outcome:       pipeline.Outcome(r.Outcome),
		Attempt:       int(r.Attempt),
		EnteredVia:    pipeline.EntryEdge(r.EnteredVia),
		PrevStage:     r.PrevStage,
		FailedStage:   r.FailedStage,
		FailedOutcome: pipeline.Outcome(r.FailedOutcome),
		SessionID:     r.SessionID,
		WorkspaceKind: pipeline.WorkspaceKind(r.WorkspaceKind),
		WorkspacePath: r.WorkspacePath,
		DeadlineAt:    timeFromNullTime(r.DeadlineAt),
		StartedAt:     timeFromNullTime(r.StartedAt),
		SettledAt:     timeFromNullTime(r.SettledAt),
		Reason:        r.Reason,
		OutputTail:    r.OutputTail,
		PGID:          int(r.Pgid),
	}
}

// boolToInt64 maps a Go bool onto the SQLite integer-bool column convention.
func boolToInt64(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// nullTimeFromTime treats the zero time as "not set", which is what the state
// structs mean by it: a stage that has not settled has a zero SettledAt.
func nullTimeFromTime(t time.Time) sql.NullTime {
	if t.IsZero() {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t, Valid: true}
}

func timeFromNullTime(t sql.NullTime) time.Time {
	if !t.Valid {
		return time.Time{}
	}
	return t.Time
}
