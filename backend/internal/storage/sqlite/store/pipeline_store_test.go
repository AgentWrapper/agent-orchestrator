package store_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// samplePipeline returns a small but real-shaped pipeline config with a command
// stage, so config-snapshot JSON columns are exercised with nested content.
func samplePipeline(name string) pipeline.Pipeline {
	return pipeline.Pipeline{
		ID:    pipeline.ID("pl-" + name),
		Name:  name,
		Scope: pipeline.ScopeWorker,
		Stages: []pipeline.Stage{{
			Name:    "lint",
			Trigger: pipeline.StageTrigger{On: []pipeline.StageTriggerEvent{pipeline.TriggerManual}},
			Executor: pipeline.StageExecutor{
				Kind:    pipeline.ExecutorCommand,
				Command: "golangci-lint",
				Args:    []string{"run"},
			},
			Task: pipeline.TaskSpec{Prompt: "lint the code"},
		}},
	}
}

func sampleDefinition(project, name string, now time.Time) pipeline.Definition {
	return pipeline.Definition{
		ID:         pipeline.ID("pl-" + name),
		ProjectID:  project,
		Name:       name,
		YAMLSource: "name: " + name + "\nstages:\n  - name: lint\n    executor: { kind: command, command: golangci-lint }\n",
		Config:     samplePipeline(name),
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}

func TestPipelineDefinitionCRUDRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	def := sampleDefinition("mer", "review", now)
	if err := s.CreatePipelineDefinition(ctx, def); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, ok, err := s.GetPipelineDefinition(ctx, def.ID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.YAMLSource != def.YAMLSource {
		t.Fatalf("yaml column not round-tripped:\n got %q\nwant %q", got.YAMLSource, def.YAMLSource)
	}
	if got.Config.Name != "review" || len(got.Config.Stages) != 1 || got.Config.Stages[0].Executor.Command != "golangci-lint" {
		t.Fatalf("normalized config column not round-tripped: %+v", got.Config)
	}

	byName, ok, err := s.GetPipelineDefinitionByName(ctx, "mer", "review")
	if err != nil || !ok || byName.ID != def.ID {
		t.Fatalf("get by name: ok=%v err=%v id=%v", ok, err, byName.ID)
	}

	// Update overwrites in place (no version history).
	def.YAMLSource = "name: review\nstages: []\n"
	def.Config.Stages = nil
	def.UpdatedAt = now.Add(time.Minute)
	updated, err := s.UpdatePipelineDefinition(ctx, def)
	if err != nil || !updated {
		t.Fatalf("update: ok=%v err=%v", updated, err)
	}
	got, _, _ = s.GetPipelineDefinition(ctx, def.ID)
	if len(got.Config.Stages) != 0 || got.YAMLSource != def.YAMLSource {
		t.Fatalf("update not persisted: %+v", got)
	}

	if list, err := s.ListPipelineDefinitions(ctx, "mer"); err != nil || len(list) != 1 {
		t.Fatalf("list = %d err=%v, want 1", len(list), err)
	}

	deleted, err := s.DeletePipelineDefinition(ctx, def.ID)
	if err != nil || !deleted {
		t.Fatalf("delete: ok=%v err=%v", deleted, err)
	}
	if _, ok, _ := s.GetPipelineDefinition(ctx, def.ID); ok {
		t.Fatal("definition still present after delete")
	}
	// Deleting a missing id is a no-op (ok=false), not an error.
	if deleted, err := s.DeletePipelineDefinition(ctx, def.ID); err != nil || deleted {
		t.Fatalf("delete missing = %v %v, want false nil", deleted, err)
	}
}

func TestPipelineRunSaveLoadRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)
	started := now.Add(time.Second)

	run := pipeline.RunState{
		RunID:                  "run-1",
		PipelineID:             "pl-review",
		PipelineName:           "review",
		SessionID:              "mer-1",
		PipelineConfigSnapshot: samplePipeline("review"),
		HeadSHA:                "abc123",
		LoopState:              pipeline.LoopRunning,
		LoopRounds:             2,
		Stages: map[string]pipeline.StageState{
			"lint": {StageRunID: "sr-1", Status: pipeline.StageStatusRunning, Attempt: 1, StartedAt: &started},
		},
		Fingerprints: []string{"fp-b", "fp-a"},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.SavePipelineRun(ctx, "mer", run); err != nil {
		t.Fatalf("save: %v", err)
	}

	got, ok, err := s.GetPipelineRun(ctx, "run-1")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.PipelineName != "review" || got.SessionID != "mer-1" || got.HeadSHA != "abc123" ||
		got.LoopState != pipeline.LoopRunning || got.LoopRounds != 2 {
		t.Fatalf("run scalars not round-tripped: %+v", got)
	}
	if got.PipelineConfigSnapshot.Stages[0].Executor.Command != "golangci-lint" {
		t.Fatalf("config snapshot not round-tripped: %+v", got.PipelineConfigSnapshot)
	}
	// Fingerprints keep insertion order (dedup+sort only happens in summaries).
	if len(got.Fingerprints) != 2 || got.Fingerprints[0] != "fp-b" || got.Fingerprints[1] != "fp-a" {
		t.Fatalf("fingerprints = %v", got.Fingerprints)
	}
	st, ok := got.Stages["lint"]
	if !ok || st.StageRunID != "sr-1" || st.Status != pipeline.StageStatusRunning || st.Attempt != 1 {
		t.Fatalf("stage not round-tripped: %+v ok=%v", st, ok)
	}
	if st.StartedAt == nil || !st.StartedAt.Equal(started) {
		t.Fatalf("stage startedAt = %v, want %v", st.StartedAt, started)
	}

	// Re-saving with a terminal transition updates in place.
	run.LoopState = pipeline.LoopDone
	run.TerminationReason = pipeline.TerminationCompleted
	completed := now.Add(2 * time.Second)
	run.Stages["lint"] = pipeline.StageState{StageRunID: "sr-1", Status: pipeline.StageStatusSucceeded, Attempt: 1, Verdict: pipeline.VerdictPass, StartedAt: &started, CompletedAt: &completed}
	run.UpdatedAt = now.Add(3 * time.Second)
	if err := s.SavePipelineRun(ctx, "mer", run); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	got, _, _ = s.GetPipelineRun(ctx, "run-1")
	if got.LoopState != pipeline.LoopDone || got.TerminationReason != pipeline.TerminationCompleted {
		t.Fatalf("terminal transition not persisted: %+v", got)
	}
	if st := got.Stages["lint"]; st.Status != pipeline.StageStatusSucceeded || st.Verdict != pipeline.VerdictPass || st.CompletedAt == nil {
		t.Fatalf("stage transition not persisted: %+v", st)
	}
	if list, err := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{}); err != nil || len(list) != 1 {
		t.Fatalf("list = %d err=%v, want 1 (upsert, not duplicate)", len(list), err)
	}
}

func TestPipelineArtifactAppendStatusAndRunMirror(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	run := pipeline.RunState{
		RunID: "run-1", PipelineID: "pl-review", PipelineName: "review", SessionID: "mer-1",
		PipelineConfigSnapshot: samplePipeline("review"), LoopState: pipeline.LoopRunning,
		Stages:    map[string]pipeline.StageState{"lint": {StageRunID: "sr-1", Status: pipeline.StageStatusRunning}},
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.SavePipelineRun(ctx, "mer", run); err != nil {
		t.Fatalf("save run: %v", err)
	}

	finding := pipeline.Artifact{
		ArtifactInput: pipeline.ArtifactInput{
			Kind: pipeline.ArtifactKindFinding, FilePath: "main.go", StartLine: 10, EndLine: 12,
			Title: "nil deref", Description: "possible nil", Category: "correctness",
			Severity: pipeline.SeverityError, Confidence: 0.9,
		},
		ArtifactID: "art-1", PipelineRunID: "run-1", StageRunID: "sr-1", StageName: "lint",
		Fingerprint: "fp-x", Status: pipeline.ArtifactStatusOpen, CreatedAt: now,
	}
	jsonArt := pipeline.Artifact{
		ArtifactInput: pipeline.ArtifactInput{Kind: pipeline.ArtifactKindJSON, Data: map[string]any{"score": float64(3)}},
		ArtifactID:    "art-2", PipelineRunID: "run-1", StageRunID: "sr-1", StageName: "lint",
		Status: pipeline.ArtifactStatusOpen, CreatedAt: now.Add(time.Second),
	}
	if err := s.AppendPipelineArtifacts(ctx, "mer", []pipeline.Artifact{finding, jsonArt}); err != nil {
		t.Fatalf("append: %v", err)
	}
	// Appending an empty batch is a no-op.
	if err := s.AppendPipelineArtifacts(ctx, "mer", nil); err != nil {
		t.Fatalf("append empty: %v", err)
	}

	got, ok, err := s.GetPipelineArtifact(ctx, "art-1")
	if err != nil || !ok {
		t.Fatalf("get artifact: ok=%v err=%v", ok, err)
	}
	if got.FilePath != "main.go" || got.Severity != pipeline.SeverityError || got.Confidence != 0.9 || got.Fingerprint != "fp-x" {
		t.Fatalf("artifact payload not round-tripped: %+v", got)
	}

	// Status update (open -> sent_to_agent) is authoritative over the blob.
	sentAt := now.Add(time.Minute)
	updated, err := s.UpdatePipelineArtifactStatus(ctx, "art-1", pipeline.ArtifactStatusSentToAgent, &sentAt)
	if err != nil || !updated {
		t.Fatalf("update status: ok=%v err=%v", updated, err)
	}
	got, _, _ = s.GetPipelineArtifact(ctx, "art-1")
	if got.Status != pipeline.ArtifactStatusSentToAgent || got.SentToAgentAt == nil || !got.SentToAgentAt.Equal(sentAt) {
		t.Fatalf("status/sentToAgentAt not persisted: status=%s sent=%v", got.Status, got.SentToAgentAt)
	}
	if updated, err := s.UpdatePipelineArtifactStatus(ctx, "missing", pipeline.ArtifactStatusResolved, nil); err != nil || updated {
		t.Fatalf("update missing = %v %v, want false nil", updated, err)
	}

	// Run reconstruction mirrors findings (kind=finding only) and lists every
	// artifact id on the owning stage.
	runGot, _, _ := s.GetPipelineRun(ctx, "run-1")
	if len(runGot.Findings) != 1 || runGot.Findings[0].ArtifactID != "art-1" {
		t.Fatalf("findings mirror = %+v, want only the finding artifact", runGot.Findings)
	}
	if runGot.Findings[0].Status != pipeline.ArtifactStatusSentToAgent {
		t.Fatalf("mirrored finding status stale: %s", runGot.Findings[0].Status)
	}
	stageArts := runGot.Stages["lint"].Artifacts
	if len(stageArts) != 2 || stageArts[0] != "art-1" || stageArts[1] != "art-2" {
		t.Fatalf("stage artifact ids = %v, want [art-1 art-2]", stageArts)
	}
}

func TestPipelineHydrateEngineState(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	base := time.Now().UTC().Truncate(time.Second)

	// Two runs on one loop (mer-1:review): an older terminal run and a newer
	// live one. Plus a run on a different loop (mer-2:review).
	saveRun := func(id, session string, state pipeline.LoopStateName, createdAt time.Time, fps []string) {
		run := pipeline.RunState{
			RunID: pipeline.RunID(id), PipelineID: "pl-review", PipelineName: "review", SessionID: session,
			PipelineConfigSnapshot: samplePipeline("review"), LoopState: state,
			Stages:       map[string]pipeline.StageState{"lint": {StageRunID: pipeline.StageRunID("sr-" + id), Status: pipeline.StageStatusSucceeded}},
			Fingerprints: fps, CreatedAt: createdAt, UpdatedAt: createdAt,
		}
		if state.IsTerminal() {
			run.TerminationReason = pipeline.TerminationStageFailure
		}
		if err := s.SavePipelineRun(ctx, "mer", run); err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
	}
	saveRun("run-old", "mer-1", pipeline.LoopStalled, base, []string{"fp2", "fp1", "fp2"})
	saveRun("run-live", "mer-1", pipeline.LoopRunning, base.Add(time.Minute), nil)
	saveRun("run-other", "mer-2", pipeline.LoopRunning, base.Add(2*time.Minute), nil)

	state, err := s.HydratePipelineEngineState(ctx, "mer")
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if len(state.Runs) != 3 {
		t.Fatalf("runs = %d, want 3", len(state.Runs))
	}
	if state.CurrentRunByLoop[pipeline.LoopKey("mer-1", "review")] != "run-live" {
		t.Fatalf("current run for mer-1:review = %q, want run-live", state.CurrentRunByLoop[pipeline.LoopKey("mer-1", "review")])
	}
	if state.CurrentRunByLoop[pipeline.LoopKey("mer-2", "review")] != "run-other" {
		t.Fatalf("current run for mer-2:review = %q, want run-other", state.CurrentRunByLoop[pipeline.LoopKey("mer-2", "review")])
	}
	hist := state.HistorySummaries[pipeline.LoopKey("mer-1", "review")]
	if len(hist) != 1 || hist[0].RunID != "run-old" || hist[0].LoopState != pipeline.LoopStalled {
		t.Fatalf("history for mer-1:review = %+v, want one stalled run-old", hist)
	}
	// Summary fingerprints are deduped + sorted.
	if len(hist[0].Fingerprints) != 2 || hist[0].Fingerprints[0] != "fp1" || hist[0].Fingerprints[1] != "fp2" {
		t.Fatalf("summary fingerprints = %v, want sorted deduped [fp1 fp2]", hist[0].Fingerprints)
	}
	// The live run must not appear in history.
	if _, ok := state.HistorySummaries[pipeline.LoopKey("mer-2", "review")]; ok {
		t.Fatalf("live-only loop should have no history: %+v", state.HistorySummaries)
	}
}

func TestPipelineRunListFilterAndOrder(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	base := time.Now().UTC().Truncate(time.Second)

	mk := func(id, name string, state pipeline.LoopStateName, createdAt time.Time) {
		run := pipeline.RunState{
			RunID: pipeline.RunID(id), PipelineID: pipeline.ID("pl-" + name), PipelineName: name, SessionID: "mer-1",
			PipelineConfigSnapshot: samplePipeline(name), LoopState: state,
			Stages:    map[string]pipeline.StageState{},
			CreatedAt: createdAt, UpdatedAt: createdAt,
		}
		if err := s.SavePipelineRun(ctx, "mer", run); err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
	}
	mk("r1", "review", pipeline.LoopDone, base)
	mk("r2", "review", pipeline.LoopRunning, base.Add(time.Minute))
	mk("r3", "build", pipeline.LoopRunning, base.Add(2*time.Minute))

	all, _ := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{})
	if len(all) != 3 || all[0].RunID != "r3" || all[2].RunID != "r1" {
		t.Fatalf("newest-first order wrong: %v", runIDs(all))
	}
	byName, _ := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{PipelineName: "review"})
	if len(byName) != 2 {
		t.Fatalf("filter by name = %d, want 2", len(byName))
	}
	byStatus, _ := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{Status: pipeline.LoopRunning})
	if len(byStatus) != 2 {
		t.Fatalf("filter by status = %d, want 2", len(byStatus))
	}
	limited, _ := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{Limit: 1})
	if len(limited) != 1 || limited[0].RunID != "r3" {
		t.Fatalf("limit=1 = %v, want [r3]", runIDs(limited))
	}
}

func runIDs(runs []pipeline.RunState) []pipeline.RunID {
	out := make([]pipeline.RunID, 0, len(runs))
	for _, r := range runs {
		out = append(out, r.RunID)
	}
	return out
}

// TestPipelineCDCTriggersEmitProjectLevelEvents asserts each pipeline_* row
// change writes the expected change_log entry: right type, project-scoped
// (session_id NULL), and the payload shape live clients key off.
func TestPipelineCDCTriggersEmitProjectLevelEvents(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	if err := s.CreatePipelineDefinition(ctx, sampleDefinition("mer", "review", now)); err != nil {
		t.Fatalf("create def: %v", err)
	}
	run := pipeline.RunState{
		RunID: "run-1", PipelineID: "pl-review", PipelineName: "review", SessionID: "mer-1",
		PipelineConfigSnapshot: samplePipeline("review"), HeadSHA: "abc", LoopState: pipeline.LoopRunning, LoopRounds: 1,
		Stages:    map[string]pipeline.StageState{"lint": {StageRunID: "sr-1", Status: pipeline.StageStatusRunning}},
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.SavePipelineRun(ctx, "mer", run); err != nil {
		t.Fatalf("save run: %v", err)
	}
	art := pipeline.Artifact{
		ArtifactInput: pipeline.ArtifactInput{Kind: pipeline.ArtifactKindFinding, Title: "x"},
		ArtifactID:    "art-1", PipelineRunID: "run-1", StageRunID: "sr-1", StageName: "lint",
		Fingerprint: "fp-x", Status: pipeline.ArtifactStatusOpen, CreatedAt: now,
	}
	if err := s.AppendPipelineArtifacts(ctx, "mer", []pipeline.Artifact{art}); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := s.UpdatePipelineArtifactStatus(ctx, "art-1", pipeline.ArtifactStatusDismissed, nil); err != nil {
		t.Fatalf("update status: %v", err)
	}

	evs, err := s.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	byType := map[cdc.EventType][]cdc.Event{}
	for _, e := range evs {
		if e.Type != cdc.EventPipelineDefinitionChanged && e.Type != cdc.EventPipelineRunUpdated &&
			e.Type != cdc.EventPipelineStageRunUpdated && e.Type != cdc.EventPipelineArtifactUpdated {
			continue
		}
		if e.ProjectID != "mer" {
			t.Fatalf("pipeline event project = %q, want mer", e.ProjectID)
		}
		if e.SessionID != "" {
			t.Fatalf("pipeline event must be project-level (empty session), got %q", e.SessionID)
		}
		byType[e.Type] = append(byType[e.Type], e)
	}

	if len(byType[cdc.EventPipelineDefinitionChanged]) != 1 {
		t.Fatalf("definition events = %d, want 1", len(byType[cdc.EventPipelineDefinitionChanged]))
	}
	assertPayload(t, byType[cdc.EventPipelineDefinitionChanged][0], map[string]any{"name": "review", "change": "created"})

	if len(byType[cdc.EventPipelineRunUpdated]) != 1 {
		t.Fatalf("run events = %d, want 1 (insert)", len(byType[cdc.EventPipelineRunUpdated]))
	}
	assertPayload(t, byType[cdc.EventPipelineRunUpdated][0], map[string]any{
		"runId": "run-1", "pipelineName": "review", "loopState": "running", "loopRounds": float64(1),
	})

	if len(byType[cdc.EventPipelineStageRunUpdated]) != 1 {
		t.Fatalf("stage events = %d, want 1 (insert)", len(byType[cdc.EventPipelineStageRunUpdated]))
	}
	assertPayload(t, byType[cdc.EventPipelineStageRunUpdated][0], map[string]any{
		"runId": "run-1", "stageName": "lint", "stageRunId": "sr-1", "status": "running",
	})

	// One insert + one status-change update.
	if len(byType[cdc.EventPipelineArtifactUpdated]) != 2 {
		t.Fatalf("artifact events = %d, want 2 (insert + status update)", len(byType[cdc.EventPipelineArtifactUpdated]))
	}
	assertPayload(t, byType[cdc.EventPipelineArtifactUpdated][0], map[string]any{
		"artifactId": "art-1", "runId": "run-1", "kind": "finding", "status": "open",
	})
	assertPayload(t, byType[cdc.EventPipelineArtifactUpdated][1], map[string]any{"status": "dismissed"})
}

func assertPayload(t *testing.T, e cdc.Event, want map[string]any) {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(e.Payload, &got); err != nil {
		t.Fatalf("payload JSON for %s: %v", e.Type, err)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s payload[%q] = %#v, want %#v (full: %s)", e.Type, k, got[k], v, e.Payload)
		}
	}
}
