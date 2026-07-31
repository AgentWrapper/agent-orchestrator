package store_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// samplePipelineV2 returns a small but real-shaped v2 definition: one agent
// stage with a produces contract routing to one command stage, so the frozen
// definition column is exercised with nested content rather than a stub.
func samplePipelineV2(name string) pipeline.Pipeline {
	return pipeline.Pipeline{
		Name: name,
		On:   pipeline.TriggerSpec{PR: []pipeline.PREvent{pipeline.PREventCreated}},
		Defaults: pipeline.DefaultsSpec{
			Deadline:  20 * time.Minute,
			OnFailure: "notify",
		},
		Stages: []pipeline.Stage{
			{
				ID:        "review",
				Executor:  pipeline.ExecutorAgent,
				Agent:     "claude-code",
				Produces:  "review.md",
				Prompt:    "review the diff",
				Session:   &pipeline.SessionSpec{KillOn: []pipeline.Outcome{pipeline.OutcomeSucceeded}},
				OnSuccess: pipeline.StageList{"publish"},
			},
			{
				ID:          "publish",
				Executor:    pipeline.ExecutorCommand,
				Run:         "gh release create",
				Credentials: []string{"gh-release"},
				Workspace:   pipeline.WorkspaceRun,
			},
			{ID: "notify", Executor: pipeline.ExecutorCommand, Run: "echo failed"},
		},
	}
}

func sampleDefinitionV2(project, name string, now time.Time) pipeline.Definition {
	return pipeline.Definition{
		ID:         pipeline.ID("pl-" + name),
		ProjectID:  project,
		Name:       name,
		YAMLSource: "name: " + name + "\nstages:\n  - id: review\n    executor: agent\n",
		Config:     samplePipelineV2(name),
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}

func TestPipelineDefinitionCRUDRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	def := sampleDefinitionV2("mer", "review", now)
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
	if !reflect.DeepEqual(got.Config, def.Config) {
		t.Fatalf("config column not round-tripped:\n got %+v\nwant %+v", got.Config, def.Config)
	}

	byName, ok, err := s.GetPipelineDefinitionByName(ctx, "mer", "review")
	if err != nil || !ok || byName.ID != def.ID {
		t.Fatalf("get by name: ok=%v err=%v id=%v", ok, err, byName.ID)
	}

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

// prRun builds a settled PR-subject run whose stages cover every outcome in the
// taxonomy, so no column is exercised only by its zero value.
func prRun(now time.Time) pipeline.RunState {
	started := now.Add(time.Second)
	settled := now.Add(time.Minute)
	stages := make(map[string]*pipeline.StageState, len(pipeline.AllOutcomes))
	for i, outcome := range pipeline.AllOutcomes {
		st := &pipeline.StageState{
			ID:            string(outcome),
			Outcome:       outcome,
			Attempt:       i % 3,
			EnteredVia:    pipeline.EntrySuccess,
			PrevStage:     "review",
			SessionID:     "mer-1",
			WorkspaceKind: pipeline.WorkspaceRun,
			WorkspacePath: "/runs/run-1/workspace",
			DeadlineAt:    now.Add(20 * time.Minute),
			StartedAt:     started,
			PGID:          9000 + i,
			Reason:        "because " + string(outcome),
			OutputTail:    "tail for " + string(outcome),
		}
		if outcome.IsSettled() {
			st.SettledAt = settled
		}
		if outcome.RoutesToFailure() {
			st.EnteredVia = pipeline.EntryFailure
			st.PrevStage = ""
			st.FailedStage = "review"
			st.FailedOutcome = pipeline.OutcomeTimedOut
		}
		stages[st.ID] = st
	}
	stages["entry"] = &pipeline.StageState{
		ID: "entry", Outcome: pipeline.OutcomeSucceeded, Attempt: 1,
		EnteredVia: pipeline.EntryTrigger, StartedAt: started, SettledAt: settled,
	}
	return pipeline.RunState{
		RunID:        "run-1",
		ProjectID:    "mer",
		PipelineID:   "pl-review",
		PipelineName: "review",
		Subject: pipeline.Subject{
			Kind:      pipeline.SubjectPR,
			ProjectID: "mer",
			SessionID: "mer-1",
			PR: &pipeline.PRRef{
				Number: 412, Repo: "o/r", URL: "https://github.com/o/r/pull/412",
				HeadSHA: "abc123", HeadBranch: "feat/x", BaseBranch: "main", FromFork: true,
			},
		},
		Status:       pipeline.RunFailed,
		RunDir:       "/data/pipelines/mer/run-1",
		Def:          samplePipelineV2("review"),
		Stages:       stages,
		Nudged:       map[string]bool{"no_signal": true},
		CancelReason: "",
		CreatedAt:    now,
		UpdatedAt:    now.Add(2 * time.Minute),
		SettledAt:    settled,
	}
}

func TestPipelineRunSaveGetRoundTripPRSubject(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	want := prRun(now)
	if err := s.SavePipelineRun(ctx, &want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, ok, err := s.GetPipelineRun(ctx, want.RunID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("run did not round-trip:\n got %s\nwant %s", mustJSON(t, got), mustJSON(t, want))
	}

	// Save is an upsert: re-saving a mutated run overwrites in place, and a
	// stage that changed outcome carries its new columns.
	want.Status = pipeline.RunCancelled
	want.CancelReason = "superseded by concurrency"
	want.Stages["pending"].Outcome = pipeline.OutcomeCancelled
	want.Stages["pending"].SettledAt = now.Add(3 * time.Minute)
	want.UpdatedAt = now.Add(3 * time.Minute)
	if err := s.SavePipelineRun(ctx, &want); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	got, _, _ = s.GetPipelineRun(ctx, want.RunID)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("upsert did not round-trip:\n got %s\nwant %s", mustJSON(t, got), mustJSON(t, want))
	}

	if _, ok, err := s.GetPipelineRun(ctx, "nope"); err != nil || ok {
		t.Fatalf("get missing = %v %v, want false nil", ok, err)
	}
}

// A session subject and a project subject carry no PR, and must not come back
// with a zero-valued PRRef attached.
func TestPipelineRunSaveGetRoundTripSessionAndProjectSubjects(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	subjects := map[string]pipeline.Subject{
		"session": {Kind: pipeline.SubjectSession, ProjectID: "mer", SessionID: "mer-7"},
		"project": {Kind: pipeline.SubjectProject, ProjectID: "mer"},
	}
	for id, subject := range subjects {
		want := pipeline.RunState{
			RunID: pipeline.RunID("run-" + id), ProjectID: "mer", PipelineID: "pl-review",
			PipelineName: "review", Subject: subject, Status: pipeline.RunRunning,
			RunDir: "/data/pipelines/mer/run-" + id, Def: samplePipelineV2("review"),
			Stages: map[string]*pipeline.StageState{
				"entry": {ID: "entry", Outcome: pipeline.OutcomeRunning, Attempt: 1, EnteredVia: pipeline.EntryTrigger, StartedAt: now},
			},
			CreatedAt: now, UpdatedAt: now,
		}
		if err := s.SavePipelineRun(ctx, &want); err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
		got, ok, err := s.GetPipelineRun(ctx, want.RunID)
		if err != nil || !ok {
			t.Fatalf("get %s: ok=%v err=%v", id, ok, err)
		}
		if got.Subject.PR != nil {
			t.Fatalf("%s subject came back with a PR: %+v", id, got.Subject.PR)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s run did not round-trip:\n got %s\nwant %s", id, mustJSON(t, got), mustJSON(t, want))
		}
	}
}

// numberedRun is the smallest run that can carry a run number: the counter is
// keyed by (project, pipeline name), so those and the run id are all that
// varies between the cases below.
func numberedRun(id, project, name string, at time.Time) pipeline.RunState {
	return pipeline.RunState{
		RunID: pipeline.RunID(id), ProjectID: project, PipelineID: pipeline.ID("pl-" + name),
		PipelineName: name, Subject: pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: project},
		Status: pipeline.RunPending, Def: samplePipelineV2(name),
		Stages:    map[string]*pipeline.StageState{"entry": {ID: "entry", Outcome: pipeline.OutcomePending}},
		CreatedAt: at, UpdatedAt: at,
	}
}

// Run numbers are what a human says out loud ("review #3 failed"), so they
// count per pipeline rather than per project, and each pipeline's sequence
// starts at 1 regardless of what the others have done.
func TestPipelineRunNumberIsPerPipelineAndMonotonic(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	seedProject(t, s, "other")
	now := time.Now().UTC().Truncate(time.Second)

	cases := []struct {
		id, project, name string
		want              int
	}{
		{"run-a1", "mer", "review", 1},
		{"run-a2", "mer", "review", 2},
		{"run-b1", "mer", "audit", 1},
		{"run-a3", "mer", "review", 3},
		{"run-b2", "mer", "audit", 2},
		// Same pipeline name, different project: a separate sequence.
		{"run-c1", "other", "review", 1},
	}
	for _, c := range cases {
		run := numberedRun(c.id, c.project, c.name, now)
		if err := s.SavePipelineRun(ctx, &run); err != nil {
			t.Fatalf("save %s: %v", c.id, err)
		}
		if run.RunNumber != c.want {
			t.Fatalf("%s/%s %s run number = %d, want %d", c.project, c.name, c.id, run.RunNumber, c.want)
		}
	}
}

// The number is assigned once. Every later save of the same run is an upsert
// that must leave it alone, and hydration must read back the number the row
// holds rather than an engine's in-memory guess.
func TestPipelineRunNumberIsStableAcrossResavesAndHydration(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	first := numberedRun("run-1", "mer", "review", now)
	if err := s.SavePipelineRun(ctx, &first); err != nil {
		t.Fatalf("save run-1: %v", err)
	}
	second := numberedRun("run-2", "mer", "review", now)
	if err := s.SavePipelineRun(ctx, &second); err != nil {
		t.Fatalf("save run-2: %v", err)
	}
	if first.RunNumber != 1 || second.RunNumber != 2 {
		t.Fatalf("run numbers = %d, %d, want 1, 2", first.RunNumber, second.RunNumber)
	}

	// Re-save run-1 the way the engine does on every state change, including
	// one that lies about the number. The row wins.
	first.Status = pipeline.RunSucceeded
	first.SettledAt = now.Add(time.Minute)
	first.RunNumber = 99
	if err := s.SavePipelineRun(ctx, &first); err != nil {
		t.Fatalf("re-save run-1: %v", err)
	}
	if first.RunNumber != 1 {
		t.Fatalf("re-save changed the run number to %d, want 1", first.RunNumber)
	}

	got, ok, err := s.GetPipelineRun(ctx, "run-1")
	if err != nil || !ok {
		t.Fatalf("get run-1: ok=%v err=%v", ok, err)
	}
	if got.RunNumber != 1 {
		t.Fatalf("hydrated run number = %d, want 1", got.RunNumber)
	}
	// And a fresh run after the re-save still gets 3, not 100: the bogus 99
	// never reached the column the allocator maxes over.
	third := numberedRun("run-3", "mer", "review", now)
	if err := s.SavePipelineRun(ctx, &third); err != nil {
		t.Fatalf("save run-3: %v", err)
	}
	if third.RunNumber != 3 {
		t.Fatalf("run-3 number = %d, want 3", third.RunNumber)
	}
}

// The engine actor is per project, but one project has many pipelines and the
// concurrency table admits runs in parallel, so two triggers for one definition
// really can land at the same time. Allocation happens inside the insert, so
// they cannot both compute the same next number.
//
// The writers are split across two Store handles on one database on purpose:
// a single Store serializes its writes behind a mutex, which would let a
// read-max-then-add-one implementation pass. Two handles put the guarantee
// where it belongs, in SQLite.
func TestPipelineRunNumberConcurrentTriggersGetDistinctNumbers(t *testing.T) {
	dir := t.TempDir()
	writers := make([]*sqlite.Store, 2)
	for i := range writers {
		s, err := sqlite.Open(dir)
		if err != nil {
			t.Fatalf("open store %d: %v", i, err)
		}
		t.Cleanup(func() { _ = s.Close() })
		writers[i] = s
	}
	ctx := context.Background()
	seedProject(t, writers[0], "mer")
	now := time.Now().UTC().Truncate(time.Second)

	const n = 24
	numbers := make([]int, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			run := numberedRun(fmt.Sprintf("run-%02d", i), "mer", "review", now)
			<-start
			errs[i] = writers[i%len(writers)].SavePipelineRun(ctx, &run)
			numbers[i] = run.RunNumber
		}()
	}
	close(start)
	wg.Wait()

	seen := make(map[int]int, n)
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent save %d: %v", i, err)
		}
		if prev, dup := seen[numbers[i]]; dup {
			t.Fatalf("runs %d and %d were both numbered #%d", prev, i, numbers[i])
		}
		seen[numbers[i]] = i
	}
	for want := 1; want <= n; want++ {
		if _, ok := seen[want]; !ok {
			t.Fatalf("run number %d was never handed out (got %v)", want, seen)
		}
	}
}

func TestPipelineListRunsFilters(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	seedProject(t, s, "other")
	base := time.Now().UTC().Truncate(time.Second)

	save := func(id, project, name string, status pipeline.RunStatus, at time.Time) {
		t.Helper()
		run := pipeline.RunState{
			RunID: pipeline.RunID(id), ProjectID: project, PipelineID: pipeline.ID("pl-" + name),
			PipelineName: name, Subject: pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: project},
			Status: status, Def: samplePipelineV2(name),
			Stages:    map[string]*pipeline.StageState{"entry": {ID: "entry", Outcome: pipeline.OutcomePending}},
			CreatedAt: at, UpdatedAt: at,
		}
		if err := s.SavePipelineRun(ctx, &run); err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
	}
	save("r1", "mer", "review", pipeline.RunSucceeded, base)
	save("r2", "mer", "review", pipeline.RunRunning, base.Add(time.Minute))
	save("r3", "mer", "release", pipeline.RunFailed, base.Add(2*time.Minute))
	save("r4", "other", "review", pipeline.RunRunning, base.Add(3*time.Minute))

	// Unfiltered: this project only, newest first.
	all, err := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got := runIDs(all); !reflect.DeepEqual(got, []pipeline.RunID{"r3", "r2", "r1"}) {
		t.Fatalf("unfiltered = %v, want [r3 r2 r1]", got)
	}
	// Stages come back on listed runs, not just on Get.
	if len(all[0].Stages) != 1 {
		t.Fatalf("listed run has %d stages, want 1", len(all[0].Stages))
	}

	byPipeline, _ := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{PipelineName: "review"})
	if got := runIDs(byPipeline); !reflect.DeepEqual(got, []pipeline.RunID{"r2", "r1"}) {
		t.Fatalf("by pipeline = %v, want [r2 r1]", got)
	}

	byStatus, _ := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{Status: string(pipeline.RunRunning)})
	if got := runIDs(byStatus); !reflect.DeepEqual(got, []pipeline.RunID{"r2"}) {
		t.Fatalf("by status = %v, want [r2]", got)
	}

	both, _ := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{PipelineName: "review", Status: string(pipeline.RunSucceeded)})
	if got := runIDs(both); !reflect.DeepEqual(got, []pipeline.RunID{"r1"}) {
		t.Fatalf("by pipeline+status = %v, want [r1]", got)
	}

	limited, _ := s.ListPipelineRuns(ctx, "mer", pipeline.RunFilter{Limit: 2})
	if got := runIDs(limited); !reflect.DeepEqual(got, []pipeline.RunID{"r3", "r2"}) {
		t.Fatalf("limited = %v, want [r3 r2]", got)
	}
}

func TestPipelineHydrateReturnsUnsettledRunsOnly(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	seedProject(t, s, "other")
	base := time.Now().UTC().Truncate(time.Second)

	save := func(id, project string, status pipeline.RunStatus, at time.Time) {
		t.Helper()
		run := pipeline.RunState{
			RunID: pipeline.RunID(id), ProjectID: project, PipelineID: "pl-review", PipelineName: "review",
			Subject: pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: project},
			Status:  status, Def: samplePipelineV2("review"),
			Stages:    map[string]*pipeline.StageState{"entry": {ID: "entry", Outcome: pipeline.OutcomeRunning}},
			CreatedAt: at, UpdatedAt: at,
		}
		if status == pipeline.RunSucceeded || status == pipeline.RunFailed || status == pipeline.RunCancelled {
			run.SettledAt = at
		}
		if err := s.SavePipelineRun(ctx, &run); err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
	}
	save("live-1", "mer", pipeline.RunRunning, base)
	save("live-2", "mer", pipeline.RunPending, base.Add(time.Minute))
	save("done", "mer", pipeline.RunSucceeded, base.Add(2*time.Minute))
	save("failed", "mer", pipeline.RunFailed, base.Add(3*time.Minute))
	save("cancelled", "mer", pipeline.RunCancelled, base.Add(4*time.Minute))
	save("other-live", "other", pipeline.RunRunning, base.Add(5*time.Minute))

	runs, err := s.HydratePipelineEngineState(ctx, "mer")
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	// Oldest first, so the engine replays them in the order they were created.
	if got := runIDs(runs); !reflect.DeepEqual(got, []pipeline.RunID{"live-1", "live-2"}) {
		t.Fatalf("hydrated = %v, want [live-1 live-2]", got)
	}
	if len(runs[0].Stages) != 1 || runs[0].Stages["entry"].Outcome != pipeline.OutcomeRunning {
		t.Fatalf("hydrated run lost its stages: %+v", runs[0].Stages)
	}
}

// A restart is the only reader of a stage's pgid, and by then the engine has
// nothing but the row: if hydration drops it, reconciliation settles the stage
// and leaks the process it was still running.
func TestPipelineStageRunRoundTripsPGID(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	run := pipeline.RunState{
		RunID: "run-pgid", ProjectID: "mer", PipelineID: "pl-review", PipelineName: "review",
		Subject: pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "mer"},
		Status:  pipeline.RunRunning, Def: samplePipelineV2("review"),
		Stages: map[string]*pipeline.StageState{
			"build":  {ID: "build", Outcome: pipeline.OutcomeRunning, Attempt: 1, StartedAt: now, PGID: 48211},
			"review": {ID: "review", Outcome: pipeline.OutcomeRunning, Attempt: 1, StartedAt: now, SessionID: "mer-1"},
		},
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.SavePipelineRun(ctx, &run); err != nil {
		t.Fatalf("save: %v", err)
	}

	hydrated, err := s.HydratePipelineEngineState(ctx, "mer")
	if err != nil || len(hydrated) != 1 {
		t.Fatalf("hydrate: %d runs, err=%v", len(hydrated), err)
	}
	if got := hydrated[0].Stages["build"].PGID; got != 48211 {
		t.Fatalf("build pgid = %d, want 48211", got)
	}
	// An agent stage records none, and a zero must stay a zero: a reap keyed on
	// a bogus group id is exactly what the identity check exists to prevent.
	if got := hydrated[0].Stages["review"].PGID; got != 0 {
		t.Fatalf("review pgid = %d, want 0 for a stage that runs in a session", got)
	}
}

func TestPipelineStageSignalLatestWins(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	run := prRun(now)
	if err := s.SavePipelineRun(ctx, &run); err != nil {
		t.Fatalf("save run: %v", err)
	}

	if _, ok, err := s.LatestPipelineStageSignal(ctx, "run-1", "review"); err != nil || ok {
		t.Fatalf("no signal yet = %v %v, want false nil", ok, err)
	}

	first := pipeline.StageSignal{RunID: "run-1", StageID: "review", Kind: pipeline.SignalFail, Reason: "impossible", CreatedAt: now}
	if err := s.AppendPipelineStageSignal(ctx, first); err != nil {
		t.Fatalf("append first: %v", err)
	}
	got, ok, err := s.LatestPipelineStageSignal(ctx, "run-1", "review")
	if err != nil || !ok || !reflect.DeepEqual(got, first) {
		t.Fatalf("first signal = %+v ok=%v err=%v", got, ok, err)
	}

	// A second signal (the nudged attempt) supersedes the first without
	// deleting it: latest-wins on read.
	second := pipeline.StageSignal{RunID: "run-1", StageID: "review", Kind: pipeline.SignalDone, CreatedAt: now.Add(time.Minute)}
	if err := s.AppendPipelineStageSignal(ctx, second); err != nil {
		t.Fatalf("append second: %v", err)
	}
	got, ok, _ = s.LatestPipelineStageSignal(ctx, "run-1", "review")
	if !ok || !reflect.DeepEqual(got, second) {
		t.Fatalf("latest signal = %+v, want %+v", got, second)
	}

	// Another stage in the same run is unaffected.
	if _, ok, _ := s.LatestPipelineStageSignal(ctx, "run-1", "publish"); ok {
		t.Fatal("signal leaked across stages")
	}
}

func TestPipelineCredentialRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	seedProject(t, s, "other")
	now := time.Now().UTC().Truncate(time.Second)

	env := map[string]string{"GH_TOKEN": "ghp_secret", "NPM_TOKEN": "npm_secret"}
	if err := s.SetPipelineCredential(ctx, "mer", "gh-release", env, now); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, ok, err := s.GetPipelineCredential(ctx, "mer", "gh-release")
	if err != nil || !ok || !reflect.DeepEqual(got, env) {
		t.Fatalf("get = %v ok=%v err=%v, want %v", got, ok, err, env)
	}

	// Set is an upsert: the same name overwrites its env wholesale.
	next := map[string]string{"GH_TOKEN": "ghp_rotated"}
	if err := s.SetPipelineCredential(ctx, "mer", "gh-release", next, now.Add(time.Minute)); err != nil {
		t.Fatalf("re-set: %v", err)
	}
	got, _, _ = s.GetPipelineCredential(ctx, "mer", "gh-release")
	if !reflect.DeepEqual(got, next) {
		t.Fatalf("upsert = %v, want %v", got, next)
	}

	if err := s.SetPipelineCredential(ctx, "mer", "apple-signing", map[string]string{"A": "b"}, now); err != nil {
		t.Fatalf("set second: %v", err)
	}
	if err := s.SetPipelineCredential(ctx, "other", "gh-release", map[string]string{"A": "b"}, now); err != nil {
		t.Fatalf("set other project: %v", err)
	}

	// The list path is names only: values never leave the daemon on a read a
	// human can reach (decision D13).
	names, err := s.ListPipelineCredentialNames(ctx, "mer")
	if err != nil || !reflect.DeepEqual(names, []string{"apple-signing", "gh-release"}) {
		t.Fatalf("list = %v err=%v, want [apple-signing gh-release]", names, err)
	}

	deleted, err := s.DeletePipelineCredential(ctx, "mer", "gh-release")
	if err != nil || !deleted {
		t.Fatalf("delete: ok=%v err=%v", deleted, err)
	}
	if _, ok, _ := s.GetPipelineCredential(ctx, "mer", "gh-release"); ok {
		t.Fatal("credential still present after delete")
	}
	// The other project's same-named credential survives.
	if _, ok, _ := s.GetPipelineCredential(ctx, "other", "gh-release"); !ok {
		t.Fatal("delete crossed the project boundary")
	}
	if deleted, err := s.DeletePipelineCredential(ctx, "mer", "gh-release"); err != nil || deleted {
		t.Fatalf("delete missing = %v %v, want false nil", deleted, err)
	}
}

func runIDs(runs []pipeline.RunState) []pipeline.RunID {
	out := make([]pipeline.RunID, 0, len(runs))
	for _, r := range runs {
		out = append(out, r.RunID)
	}
	return out
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// TestPipelineCDCTriggersEmitProjectLevelEvents asserts each pipeline_* row
// change writes the expected change_log entry: right type, project-scoped
// (session_id NULL), and the payload shape live clients key off.
func TestPipelineCDCTriggersEmitProjectLevelEvents(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)

	if err := s.CreatePipelineDefinition(ctx, sampleDefinitionV2("mer", "review", now)); err != nil {
		t.Fatalf("create def: %v", err)
	}
	run := pipeline.RunState{
		RunID: "run-1", ProjectID: "mer", PipelineID: "pl-review", PipelineName: "review",
		Subject: pipeline.Subject{Kind: pipeline.SubjectSession, ProjectID: "mer", SessionID: "mer-1"},
		Status:  pipeline.RunRunning, RunDir: "/data/pipelines/mer/run-1", Def: samplePipelineV2("review"),
		Stages: map[string]*pipeline.StageState{
			"review": {ID: "review", Outcome: pipeline.OutcomeRunning, Attempt: 1, EnteredVia: pipeline.EntryTrigger},
		},
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.SavePipelineRun(ctx, &run); err != nil {
		t.Fatalf("save run: %v", err)
	}

	// Settling the run and its stage must fire an update event for each.
	run.Status = pipeline.RunSucceeded
	run.SettledAt = now.Add(time.Minute)
	run.UpdatedAt = now.Add(time.Minute)
	run.Stages["review"].Outcome = pipeline.OutcomeSucceeded
	run.Stages["review"].Attempt = 2
	if err := s.SavePipelineRun(ctx, &run); err != nil {
		t.Fatalf("settle run: %v", err)
	}

	evs, err := s.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	byType := map[cdc.EventType][]cdc.Event{}
	for _, e := range evs {
		switch e.Type {
		case cdc.EventPipelineDefinitionChanged, cdc.EventPipelineRunUpdated, cdc.EventPipelineStageRunUpdated:
		default:
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

	if len(byType[cdc.EventPipelineRunUpdated]) != 2 {
		t.Fatalf("run events = %d, want 2 (insert + settle)", len(byType[cdc.EventPipelineRunUpdated]))
	}
	assertPayload(t, byType[cdc.EventPipelineRunUpdated][0], map[string]any{
		"runId": "run-1", "pipelineId": "pl-review", "pipelineName": "review",
		"status": "running", "subjectKind": "session", "sessionId": "mer-1",
	})
	assertPayload(t, byType[cdc.EventPipelineRunUpdated][1], map[string]any{"runId": "run-1", "status": "succeeded"})

	if len(byType[cdc.EventPipelineStageRunUpdated]) != 2 {
		t.Fatalf("stage events = %d, want 2 (insert + settle)", len(byType[cdc.EventPipelineStageRunUpdated]))
	}
	assertPayload(t, byType[cdc.EventPipelineStageRunUpdated][0], map[string]any{
		"runId": "run-1", "stageId": "review", "outcome": "running", "attempt": float64(1),
	})
	assertPayload(t, byType[cdc.EventPipelineStageRunUpdated][1], map[string]any{
		"runId": "run-1", "stageId": "review", "outcome": "succeeded", "attempt": float64(2),
	})
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
