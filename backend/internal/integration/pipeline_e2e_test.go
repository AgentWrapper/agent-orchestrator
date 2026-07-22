// This file is the end-to-end integration guard for the pipelines v1 subsystem
// (spec §8 T11). It wires the REAL components the daemon wires when AO_PIPELINES
// is on: a real sqlite.Store (temp dir), the real CDC pipeline (SQLite triggers
// -> change_log -> poller -> broadcaster), the real per-project engine
// Supervisor, and the real CDC trigger Bridge, with the only stub at the
// executor Set seam (a real agent session is impractical in CI; the executor
// interface is designed for exactly this substitution).
//
// It drives the full loop: a definition is saved; a PR row is written through
// the store, firing the real pr_created trigger; the poller fans the event out;
// the bridge derives pr.opened and triggers a run; the engine runs the stage;
// the stub executor completes with a finding; the default exit predicate
// resolves the run to done. It then asserts the run persisted with its
// fingerprinted finding, the loop history rebuilt on a fresh hydrate, and -- the
// UI's liveness contract -- that the pipeline_* CDC events landed in change_log.
//
// The flag-off case is covered too: without the bridge/engine wired (what the
// daemon does when the flag is off), the same PR row change produces no
// pipeline runs and no pipeline_* CDC events.
package integration

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/engine"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/triggers"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

const (
	plProject = "mer"
	plPRURL   = "https://github.com/o/r/pull/7"
)

// stubExecutor stands in for all three kind executors at the executors.Set seam.
// Every polled stage completes immediately with a pass verdict and one finding,
// so a triggered run self-drives to done under the engine's heartbeat.
type stubExecutor struct{}

func (stubExecutor) Start(_ context.Context, in executors.StartInput) (executors.Handle, error) {
	return stubHandle{runID: in.RunID, stageRunID: in.StageRunID, stageName: in.Stage.Name}, nil
}

func (stubExecutor) Poll(_ context.Context, h executors.Handle) (executors.Outcome, error) {
	return executors.Outcome{
		Status:  executors.OutcomeCompleted,
		Verdict: pipeline.VerdictPass,
		Artifacts: []pipeline.ArtifactInput{{
			Kind: pipeline.ArtifactKindFinding, FilePath: "main.go", StartLine: 1, EndLine: 2,
			Title: "bug", Category: "correctness", Severity: pipeline.SeverityError,
		}},
	}, nil
}

func (stubExecutor) Cancel(context.Context, executors.Handle) error { return nil }

type stubHandle struct {
	runID      pipeline.RunID
	stageRunID pipeline.StageRunID
	stageName  string
}

func (h stubHandle) RunID() pipeline.RunID           { return h.runID }
func (h stubHandle) StageRunID() pipeline.StageRunID { return h.stageRunID }
func (h stubHandle) StageName() string               { return h.stageName }

// bridgeEngines adapts the concrete engine Supervisor to the bridge's
// EngineProvider, exactly as the daemon's supervisorEngines does.
type bridgeEngines struct{ sup *engine.Supervisor }

func (b bridgeEngines) For(ctx context.Context, projectID domain.ProjectID) (triggers.Engine, error) {
	return b.sup.For(ctx, projectID)
}

// prOpenedDefinition is a stored definition whose single agent stage fires on
// pr.opened, matching the pr_created event the bridge derives.
func prOpenedDefinition() pipeline.Definition {
	stage := pipeline.Stage{
		Name:     "review",
		Trigger:  pipeline.StageTrigger{On: []pipeline.StageTriggerEvent{pipeline.TriggerPROpened}},
		Executor: pipeline.StageExecutor{Kind: pipeline.ExecutorAgent, Plugin: "claude-code", Mode: pipeline.ModeReview},
	}
	now := time.Now().UTC()
	return pipeline.Definition{
		ID:        pipeline.ID("def-review"),
		ProjectID: plProject,
		Name:      "review",
		Config:    pipeline.Pipeline{Name: "review", Scope: pipeline.ScopeWorker, Stages: []pipeline.Stage{stage}},
		CreatedAt: now,
		UpdatedAt: now,
	}
}

// seedPipelineFixture opens a store, seeds the project + a session (the pr CDC
// trigger derives project_id from the PR's session), and returns the store and
// the assigned session id.
func seedPipelineFixture(t *testing.T) (*sqlite.Store, domain.SessionID) {
	t.Helper()
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.UpsertProject(ctx, domain.ProjectRecord{
		ID: plProject, Path: "/tmp/" + plProject, RegisteredAt: time.Now().UTC().Truncate(time.Second),
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	now := time.Now().UTC()
	sess, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: plProject, Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		Metadata:  domain.SessionMetadata{Branch: "ao/mer-1/root", WorkspacePath: "/ws/mer-1"},
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("seed session: %v", err)
	}
	return store, sess.ID
}

// writeOpenPR upserts an open PR row for the session via the SCM-observation
// write path (which persists head_sha, unlike the legacy WritePR), firing the
// pr_created (or pr_updated on a subsequent write) CDC trigger.
func writeOpenPR(t *testing.T, store *sqlite.Store, sessionID domain.SessionID, sha string) {
	t.Helper()
	if err := store.WriteSCMObservation(context.Background(), domain.PullRequest{
		URL: plPRURL, SessionID: sessionID, Number: 7,
		CI: domain.CIPassing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable,
		Provider: "github", Host: "github.com", Repo: "o/r",
		SourceBranch: "ao/mer-1/root", TargetBranch: "main", HeadSHA: sha,
		UpdatedAt: time.Now().UTC(),
	}, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatalf("write pr: %v", err)
	}
}

// countPipelineEvents scans the whole change_log and tallies the pipeline_*
// event types by kind.
func countPipelineEvents(t *testing.T, store *sqlite.Store) map[cdc.EventType]int {
	t.Helper()
	events, err := store.EventsAfter(context.Background(), 0, 10000)
	if err != nil {
		t.Fatalf("read change_log: %v", err)
	}
	counts := map[cdc.EventType]int{}
	for _, e := range events {
		switch e.Type {
		case cdc.EventPipelineRunUpdated, cdc.EventPipelineStageRunUpdated,
			cdc.EventPipelineArtifactUpdated, cdc.EventPipelineDefinitionChanged:
			counts[e.Type]++
		}
	}
	return counts
}

// TestPipelineEndToEndFlagOn drives a PR row through the real CDC pipeline, the
// bridge, the engine, and a stub executor, all the way to a persisted done run,
// then asserts the pipeline_* CDC liveness events landed.
func TestPipelineEndToEndFlagOn(t *testing.T) {
	// A cancelable context tears the poller/bridge goroutines down before the
	// store closes (t.Cleanup is LIFO; store Close is registered first).
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	store, sessionID := seedPipelineFixture(t)

	if err := store.CreatePipelineDefinition(ctx, prOpenedDefinition()); err != nil {
		t.Fatalf("create definition: %v", err)
	}

	// Real CDC pipeline: the poller tails change_log and fans events out through
	// the broadcaster, exactly as the daemon wires it.
	bcast := cdc.NewBroadcaster()
	poller := cdc.NewPoller(store, bcast, cdc.PollerConfig{})
	poller.Start(ctx)

	// Real per-project engine Supervisor over the store, with the only stub at
	// the executor seam. A short tick lets a started run self-drive to done.
	sup := engine.NewSupervisor(engine.SupervisorConfig{
		Store:        store,
		Executors:    executors.NewSet(stubExecutor{}, stubExecutor{}, stubExecutor{}),
		Projects:     store,
		TickInterval: 10 * time.Millisecond,
	})
	if err := sup.Start(ctx); err != nil {
		t.Fatalf("supervisor start: %v", err)
	}
	t.Cleanup(func() { _ = sup.Stop(ctx) })

	// Real trigger bridge over the shared broadcaster + store, exactly as the
	// daemon wires it.
	bridge := triggers.New(triggers.Config{
		Broadcaster: bcast,
		Defs:        store,
		PRs:         store,
		Engines:     bridgeEngines{sup: sup},
	})
	bridge.Start(ctx)
	t.Cleanup(bridge.Stop)

	// Fire the whole loop: an open PR row -> pr_created -> pr.opened -> run.
	writeOpenPR(t, store, sessionID, "sha1")

	// The run is created and driven asynchronously; wait for it to converge.
	run := waitForDoneRun(t, sup, plProject)

	if got := run.Stages["review"]; got.Status != pipeline.StageStatusSucceeded || got.Verdict != pipeline.VerdictPass {
		t.Fatalf("review stage = %+v, want succeeded/pass", got)
	}
	if run.SessionID != string(sessionID) || run.HeadSHA != "sha1" {
		t.Fatalf("run = session %q sha %q, want %q sha1", run.SessionID, run.HeadSHA, sessionID)
	}

	// Persisted run + fingerprinted finding.
	persisted, ok, err := store.GetPipelineRun(ctx, run.RunID)
	if err != nil || !ok {
		t.Fatalf("get persisted run: ok=%v err=%v", ok, err)
	}
	if persisted.LoopState != pipeline.LoopDone {
		t.Fatalf("persisted loop state = %s, want done", persisted.LoopState)
	}
	if len(persisted.Findings) != 1 || persisted.Findings[0].Title != "bug" || persisted.Findings[0].Fingerprint == "" {
		t.Fatalf("persisted findings = %+v, want one fingerprinted finding", persisted.Findings)
	}

	// Loop history is rebuilt on a fresh hydrate with the loop pointer freed.
	hydrated, err := store.HydratePipelineEngineState(ctx, plProject)
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	// The run is PR-backed, so it keys per PR (session:pipeline:prURL), not by the
	// bare session+pipeline key. Derive the key from the run's persisted Context.
	key := pipeline.LoopKeyFor(run.Context, run.SessionID, "review", run.RunID)
	if _, live := hydrated.CurrentRunByLoop[key]; live {
		t.Fatalf("terminal run must not hold a live loop pointer")
	}
	if h := hydrated.HistorySummaries[key]; len(h) != 1 || h[0].RunID != run.RunID || h[0].LoopState != pipeline.LoopDone {
		t.Fatalf("history summaries = %+v, want one done run", h)
	}

	// UI liveness contract: the pipeline_* CDC events rode the change_log stream.
	counts := countPipelineEvents(t, store)
	if counts[cdc.EventPipelineRunUpdated] == 0 {
		t.Fatalf("no pipeline_run_updated CDC events; change_log liveness broken")
	}
	if counts[cdc.EventPipelineArtifactUpdated] == 0 {
		t.Fatalf("no pipeline_artifact_updated CDC events; findings never surfaced to the UI")
	}
	if counts[cdc.EventPipelineDefinitionChanged] == 0 {
		t.Fatalf("no pipeline_definition_changed CDC events; definition CRUD not observable")
	}
}

// TestPipelineFlagOffNoRuns is the flag-off contract: with no bridge and no
// engine wired (what the daemon does when AO_PIPELINES is off), the same PR row
// change produces no pipeline runs and no pipeline_* run/artifact CDC events.
func TestPipelineFlagOffNoRuns(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	store, sessionID := seedPipelineFixture(t)

	if err := store.CreatePipelineDefinition(ctx, prOpenedDefinition()); err != nil {
		t.Fatalf("create definition: %v", err)
	}

	// Flag off: the daemon starts neither the CDC trigger bridge nor any engine.
	// The CDC substrate itself still runs (it is not pipeline-specific), so a PR
	// write still fires pr_created -- but with nothing subscribed, no run starts.
	bcast := cdc.NewBroadcaster()
	_ = cdc.NewPoller(store, bcast, cdc.PollerConfig{}).Start(ctx)

	writeOpenPR(t, store, sessionID, "sha1")

	// Give any (absent) async trigger path time to misfire.
	time.Sleep(200 * time.Millisecond)

	hydrated, err := store.HydratePipelineEngineState(ctx, plProject)
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if len(hydrated.Runs) != 0 {
		t.Fatalf("runs with flag off = %d, want 0", len(hydrated.Runs))
	}
	counts := countPipelineEvents(t, store)
	if counts[cdc.EventPipelineRunUpdated] != 0 || counts[cdc.EventPipelineArtifactUpdated] != 0 {
		t.Fatalf("pipeline run/artifact CDC events with flag off = %+v, want none", counts)
	}
}

// waitForDoneRun polls the project engine until exactly one run has converged to
// done, or fails on deadline.
func waitForDoneRun(t *testing.T, sup *engine.Supervisor, projectID string) pipeline.RunState {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		eng, err := sup.For(ctx, domain.ProjectID(projectID))
		if err != nil {
			t.Fatalf("engine for project: %v", err)
		}
		for _, r := range eng.State().Runs {
			if r.LoopState == pipeline.LoopDone {
				return r
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no done run within deadline; end-to-end loop did not converge")
	return pipeline.RunState{}
}
