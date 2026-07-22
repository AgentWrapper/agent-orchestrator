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

// This file backs Pipelines v1 (issue #229). The persistence is normalized:
// pipeline_runs holds run-level scalars + the frozen config snapshot, stage
// state lives in pipeline_stage_runs, and findings/JSON artifacts live in
// pipeline_artifacts. A full pipeline.RunState is reassembled from all three by
// hydrateRun; hydrate-on-boot (pipeline_hydrate.go) reuses it.

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

// CreatePipelineDefinition inserts a new definition. The raw YAML and the
// normalized config are stored side by side (spec §4b).
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
	return def, err == nil, err
}

// GetPipelineDefinitionByName resolves a definition by (project, name), the
// natural reference for CLI/manual triggers. ok=false if none.
func (s *Store) GetPipelineDefinitionByName(ctx context.Context, projectID domain.ProjectID, name string) (pipeline.Definition, bool, error) {
	row, err := s.qr.GetPipelineDefinitionByName(ctx, gen.GetPipelineDefinitionByNameParams{ProjectID: projectID, Name: name})
	if errors.Is(err, sql.ErrNoRows) {
		return pipeline.Definition{}, false, nil
	}
	if err != nil {
		return pipeline.Definition{}, false, fmt.Errorf("get pipeline definition %s/%s: %w", projectID, name, err)
	}
	def, err := definitionFromRow(row)
	return def, err == nil, err
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

// UpdatePipelineDefinition overwrites a definition's YAML/config/name in place
// (v1 has no version history). ok=false when no row matched the id.
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

// DeletePipelineDefinition removes a definition. Runs snapshot their config, so
// deleting a definition does not touch existing runs. ok=false if none matched.
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

// SavePipelineRun upserts a run and all of its stage-run rows in one
// transaction (the engine's PERSIST_RUN effect). Artifacts are appended
// separately via AppendPipelineArtifacts.
func (s *Store) SavePipelineRun(ctx context.Context, projectID domain.ProjectID, run pipeline.RunState) error {
	params, err := runUpsertParams(projectID, run)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "save pipeline run", func(q *gen.Queries) error {
		if err := q.UpsertPipelineRun(ctx, params); err != nil {
			return err
		}
		for name, st := range run.Stages {
			if err := q.UpsertPipelineStageRun(ctx, stageUpsertParams(projectID, string(run.RunID), name, st)); err != nil {
				return err
			}
		}
		return nil
	})
}

// GetPipelineRun returns a fully reconstructed run (stages + findings), ok=false
// if none.
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

// ListPipelineRuns returns runs for a project newest-first, optionally filtered
// by pipeline name and/or loop state. Each run is fully reconstructed.
func (s *Store) ListPipelineRuns(ctx context.Context, projectID domain.ProjectID, filter pipeline.RunFilter) ([]pipeline.RunState, error) {
	params := gen.ListPipelineRunsParams{ProjectID: projectID, Lim: -1}
	if filter.PipelineName != "" {
		params.PipelineName = filter.PipelineName
	}
	if filter.Status != "" {
		params.LoopState = string(filter.Status)
	}
	if filter.Limit > 0 {
		params.Lim = int64(filter.Limit)
	}
	rows, err := s.qr.ListPipelineRuns(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("list pipeline runs for %s: %w", projectID, err)
	}
	out := make([]pipeline.RunState, 0, len(rows))
	for _, row := range rows {
		run, err := hydrateRun(ctx, s.qr, row)
		if err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, nil
}

// LatestSettledPipelineRunByPR returns the most recent settled (done or stalled)
// run for a PR, matched by the RunContext PR URL. The run is fully reconstructed.
// It is the read side of the lifecycle merge-readiness gate: the caller compares
// the run's head SHA against the PR's current head and consults BlocksMerge. No
// settled run for the PR returns (zero, false, nil).
func (s *Store) LatestSettledPipelineRunByPR(ctx context.Context, projectID domain.ProjectID, prURL string) (pipeline.RunState, bool, error) {
	if prURL == "" {
		return pipeline.RunState{}, false, nil
	}
	row, err := s.qr.GetLatestSettledPipelineRunByPR(ctx, gen.GetLatestSettledPipelineRunByPRParams{ProjectID: projectID, PRURL: prURL})
	if errors.Is(err, sql.ErrNoRows) {
		return pipeline.RunState{}, false, nil
	}
	if err != nil {
		return pipeline.RunState{}, false, fmt.Errorf("latest settled pipeline run for %s: %w", prURL, err)
	}
	run, err := hydrateRun(ctx, s.qr, row)
	if err != nil {
		return pipeline.RunState{}, false, err
	}
	return run, true, nil
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

// AppendPipelineArtifacts inserts artifacts (the engine's APPEND_ARTIFACTS
// effect). Append-only: an artifact id is written once; status changes go
// through UpdatePipelineArtifactStatus. The batch is atomic.
func (s *Store) AppendPipelineArtifacts(ctx context.Context, projectID domain.ProjectID, artifacts []pipeline.Artifact) error {
	if len(artifacts) == 0 {
		return nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "append pipeline artifacts", func(q *gen.Queries) error {
		for _, a := range artifacts {
			params, err := artifactInsertParams(projectID, a)
			if err != nil {
				return err
			}
			if err := q.InsertPipelineArtifact(ctx, params); err != nil {
				return err
			}
		}
		return nil
	})
}

// UpdatePipelineArtifactStatus flips an artifact's status (open -> dismissed /
// sent_to_agent / resolved), optionally stamping sent_to_agent_at. ok=false if
// no artifact matched the id.
func (s *Store) UpdatePipelineArtifactStatus(ctx context.Context, id pipeline.ArtifactID, status pipeline.ArtifactStatus, sentToAgentAt *time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdatePipelineArtifactStatus(ctx, gen.UpdatePipelineArtifactStatusParams{
		Status:        string(status),
		SentToAgentAt: nullTimeFromPtr(sentToAgentAt),
		ID:            string(id),
	})
	if err != nil {
		return false, fmt.Errorf("update pipeline artifact status %s: %w", id, err)
	}
	return n > 0, nil
}

// GetPipelineArtifact returns one artifact blob by id, ok=false if none.
func (s *Store) GetPipelineArtifact(ctx context.Context, id pipeline.ArtifactID) (pipeline.Artifact, bool, error) {
	row, err := s.qr.GetPipelineArtifact(ctx, string(id))
	if errors.Is(err, sql.ErrNoRows) {
		return pipeline.Artifact{}, false, nil
	}
	if err != nil {
		return pipeline.Artifact{}, false, fmt.Errorf("get pipeline artifact %s: %w", id, err)
	}
	a, err := artifactFromRow(row)
	if err != nil {
		return pipeline.Artifact{}, false, err
	}
	return a, true, nil
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

// hydrateRun reassembles a pipeline.RunState from its run row plus its stage
// runs and artifacts. Stage artifact lists are keyed by the stage's current
// stage_run_id; RunState.Findings mirrors the finding-kind artifacts (JSON
// artifacts are intentionally not mirrored there, per RunState's contract).
func hydrateRun(ctx context.Context, q *gen.Queries, row gen.PipelineRun) (pipeline.RunState, error) {
	var cfg pipeline.Pipeline
	if err := json.Unmarshal([]byte(row.ConfigSnapshot), &cfg); err != nil {
		return pipeline.RunState{}, fmt.Errorf("unmarshal config snapshot for run %s: %w", row.ID, err)
	}
	var fingerprints []string
	if err := json.Unmarshal([]byte(row.Fingerprints), &fingerprints); err != nil {
		return pipeline.RunState{}, fmt.Errorf("unmarshal fingerprints for run %s: %w", row.ID, err)
	}
	var runCtx pipeline.RunContext
	// Legacy rows predate the column and default to '{}', which unmarshals to the
	// zero RunContext (empty PRURL), degrading to the old session+pipeline key.
	if row.ContextJson != "" {
		if err := json.Unmarshal([]byte(row.ContextJson), &runCtx); err != nil {
			return pipeline.RunState{}, fmt.Errorf("unmarshal context for run %s: %w", row.ID, err)
		}
	}

	artRows, err := q.ListPipelineArtifactsByRun(ctx, row.ID)
	if err != nil {
		return pipeline.RunState{}, fmt.Errorf("list artifacts for run %s: %w", row.ID, err)
	}
	artifactsByStageRun := make(map[string][]pipeline.ArtifactID, len(artRows))
	findings := make([]pipeline.Artifact, 0, len(artRows))
	for _, ar := range artRows {
		artifactsByStageRun[ar.StageRunID] = append(artifactsByStageRun[ar.StageRunID], pipeline.ArtifactID(ar.ID))
		if ar.Kind == string(pipeline.ArtifactKindFinding) {
			a, err := artifactFromRow(ar)
			if err != nil {
				return pipeline.RunState{}, err
			}
			findings = append(findings, a)
		}
	}

	stageRows, err := q.ListPipelineStageRunsByRun(ctx, row.ID)
	if err != nil {
		return pipeline.RunState{}, fmt.Errorf("list stage runs for run %s: %w", row.ID, err)
	}
	stages := make(map[string]pipeline.StageState, len(stageRows))
	for _, sr := range stageRows {
		st := stageStateFromRow(sr)
		st.Artifacts = artifactsByStageRun[sr.StageRunID]
		stages[sr.StageName] = st
	}

	return pipeline.RunState{
		RunID:                  pipeline.RunID(row.ID),
		PipelineID:             pipeline.ID(row.PipelineID),
		PipelineName:           row.PipelineName,
		SessionID:              row.SessionID,
		PipelineConfigSnapshot: cfg,
		HeadSHA:                row.HeadSha,
		Context:                runCtx,
		LoopState:              pipeline.LoopStateName(row.LoopState),
		TerminationReason:      pipeline.RunTerminationReason(row.TerminationReason),
		LoopRounds:             int(row.LoopRounds),
		BlocksMerge:            row.BlocksMerge != 0,
		Stages:                 stages,
		Findings:               findings,
		Fingerprints:           fingerprints,
		CreatedAt:              row.CreatedAt,
		UpdatedAt:              row.UpdatedAt,
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

func runUpsertParams(projectID domain.ProjectID, run pipeline.RunState) (gen.UpsertPipelineRunParams, error) {
	cfg, err := json.Marshal(run.PipelineConfigSnapshot)
	if err != nil {
		return gen.UpsertPipelineRunParams{}, fmt.Errorf("marshal config snapshot for run %s: %w", run.RunID, err)
	}
	fingerprints := run.Fingerprints
	if fingerprints == nil {
		fingerprints = []string{}
	}
	fpJSON, err := json.Marshal(fingerprints)
	if err != nil {
		return gen.UpsertPipelineRunParams{}, fmt.Errorf("marshal fingerprints for run %s: %w", run.RunID, err)
	}
	ctxJSON, err := json.Marshal(run.Context)
	if err != nil {
		return gen.UpsertPipelineRunParams{}, fmt.Errorf("marshal context for run %s: %w", run.RunID, err)
	}
	return gen.UpsertPipelineRunParams{
		ID:                string(run.RunID),
		ProjectID:         projectID,
		PipelineID:        string(run.PipelineID),
		PipelineName:      run.PipelineName,
		SessionID:         run.SessionID,
		HeadSha:           run.HeadSHA,
		LoopState:         string(run.LoopState),
		TerminationReason: string(run.TerminationReason),
		LoopRounds:        int64(run.LoopRounds),
		ConfigSnapshot:    string(cfg),
		Fingerprints:      string(fpJSON),
		ContextJson:       string(ctxJSON),
		BlocksMerge:       boolToInt64(run.BlocksMerge),
		CreatedAt:         run.CreatedAt,
		UpdatedAt:         run.UpdatedAt,
	}, nil
}

// boolToInt64 maps a Go bool onto the SQLite integer-bool column convention.
func boolToInt64(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func stageUpsertParams(projectID domain.ProjectID, runID, stageName string, st pipeline.StageState) gen.UpsertPipelineStageRunParams {
	return gen.UpsertPipelineStageRunParams{
		RunID:        runID,
		ProjectID:    projectID,
		StageName:    stageName,
		StageRunID:   string(st.StageRunID),
		Status:       string(st.Status),
		Attempt:      int64(st.Attempt),
		Verdict:      string(st.Verdict),
		StartedAt:    nullTimeFromPtr(st.StartedAt),
		CompletedAt:  nullTimeFromPtr(st.CompletedAt),
		ErrorMessage: st.ErrorMessage,
		SessionID:    st.SessionID,
		Notes:        marshalStageNotes(st.Notes),
		Output:       st.Output,
	}
}

func stageStateFromRow(r gen.PipelineStageRun) pipeline.StageState {
	return pipeline.StageState{
		StageRunID:   pipeline.StageRunID(r.StageRunID),
		Status:       pipeline.StageStatus(r.Status),
		Attempt:      int(r.Attempt),
		Verdict:      pipeline.Verdict(r.Verdict),
		StartedAt:    ptrFromNullTime(r.StartedAt),
		CompletedAt:  ptrFromNullTime(r.CompletedAt),
		ErrorMessage: r.ErrorMessage,
		SessionID:    r.SessionID,
		Notes:        unmarshalStageNotes(r.Notes),
		Output:       r.Output,
	}
}

// marshalStageNotes encodes a stage's notes as a JSON array for the notes
// column. An empty list stores "" (not "null") so a legacy default round-trips
// to a nil slice.
func marshalStageNotes(notes []string) string {
	if len(notes) == 0 {
		return ""
	}
	b, err := json.Marshal(notes)
	if err != nil {
		return ""
	}
	return string(b)
}

// unmarshalStageNotes decodes the notes column back into a slice. An empty or
// malformed value yields nil so the run detail simply shows no notes.
func unmarshalStageNotes(s string) []string {
	if s == "" {
		return nil
	}
	var notes []string
	if err := json.Unmarshal([]byte(s), &notes); err != nil {
		return nil
	}
	return notes
}

func artifactInsertParams(projectID domain.ProjectID, a pipeline.Artifact) (gen.InsertPipelineArtifactParams, error) {
	status := a.Status
	if status == "" {
		status = pipeline.ArtifactStatusOpen
	}
	payload, err := json.Marshal(a)
	if err != nil {
		return gen.InsertPipelineArtifactParams{}, fmt.Errorf("marshal artifact %s: %w", a.ArtifactID, err)
	}
	return gen.InsertPipelineArtifactParams{
		ID:            string(a.ArtifactID),
		PipelineRunID: string(a.PipelineRunID),
		ProjectID:     projectID,
		StageRunID:    string(a.StageRunID),
		StageName:     a.StageName,
		Kind:          string(a.Kind),
		Fingerprint:   a.Fingerprint,
		Status:        string(status),
		SentToAgentAt: nullTimeFromPtr(a.SentToAgentAt),
		Payload:       string(payload),
		CreatedAt:     a.CreatedAt,
	}, nil
}

// artifactFromRow unmarshals the payload blob, then overlays the two mutable
// columns (status, sent_to_agent_at) which are authoritative over the blob.
func artifactFromRow(r gen.PipelineArtifact) (pipeline.Artifact, error) {
	var a pipeline.Artifact
	if err := json.Unmarshal([]byte(r.Payload), &a); err != nil {
		return pipeline.Artifact{}, fmt.Errorf("unmarshal artifact %s: %w", r.ID, err)
	}
	a.Status = pipeline.ArtifactStatus(r.Status)
	a.SentToAgentAt = ptrFromNullTime(r.SentToAgentAt)
	return a, nil
}

func nullTimeFromPtr(t *time.Time) sql.NullTime {
	if t == nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: *t, Valid: true}
}

func ptrFromNullTime(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time
	return &v
}
