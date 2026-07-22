// Package engine is the pipeline runtime: a per-project, actor-style event loop
// that drives the pure pipeline reducer, executes its effects against the store
// and executors, polls inflight stages, and hydrates on boot.
//
// The single-writer invariant is the core correctness property (spec §9 note 4):
// ALL EngineState mutation happens on one goroutine, serialized through the
// engine's mailbox channel. This replaces the old TypeScript engine's `lockTail`
// promise chain. Public entry points (TriggerRun, Cancel, Resume, ...) post a
// closure onto the mailbox and block until the actor runs it; effect execution
// feeds follow-up events back into the reducer synchronously on the same
// goroutine (the Go analogue of the old `dispatchInline`), never through the
// channel, so there is no re-entrancy deadlock and no interleaving.
//
// Ported behaviourally from packages/core/src/pipeline/engine.ts on the
// origin/legacy-pipelines branch, minus the deferred follow-up delivery
// (SEND_FOLLOWUP / FOLLOWUP_REPLY) which is phase 2.
package engine

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
)

// defaultTickInterval is how often the engine polls inflight stage handles when
// no interval is configured. Agent/command stages finish asynchronously, so the
// loop needs a heartbeat to make progress; 2s balances latency against churn.
const defaultTickInterval = 2 * time.Second

// Store is the persistence surface the engine drives via the reducer's PERSIST_*
// and artifact effects. It is deliberately a subset of the sqlite store so the
// engine unit-tests against an in-memory fake; *store.Store satisfies it.
type Store interface {
	SavePipelineRun(ctx context.Context, projectID domain.ProjectID, run pipeline.RunState) error
	AppendPipelineArtifacts(ctx context.Context, projectID domain.ProjectID, artifacts []pipeline.Artifact) error
	UpdatePipelineArtifactStatus(ctx context.Context, id pipeline.ArtifactID, status pipeline.ArtifactStatus, sentToAgentAt *time.Time) (bool, error)
	HydratePipelineEngineState(ctx context.Context, projectID domain.ProjectID) (pipeline.EngineState, error)
}

// ObservationSink receives every EMIT_OBSERVATION effect and every executor-side
// observation. It is always wired, never nil, never silently drops (spec §9
// note 8). The default implementation logs structured slog at the daemon logger.
type ObservationSink interface {
	Observe(name string, data map[string]any)
}

// Config constructs an Engine. Only ProjectID, Store, and Executors are
// required; the rest default sensibly.
type Config struct {
	ProjectID domain.ProjectID
	Store     Store
	Executors *executors.Set

	// Sink receives observations. Defaults to a slog sink over Logger.
	Sink ObservationSink
	// Logger backs the default observation sink and internal warnings.
	Logger *slog.Logger
	// Clock is the driver clock stamped onto every event. Defaults to
	// time.Now().UTC.
	Clock func() time.Time
	// NewRunID / NewStageRunID allocate identity for triggered runs and resumed
	// stages. Default to a "run-"/"sr-"-prefixed uuid, mirroring internal/review.
	NewRunID      func() pipeline.RunID
	NewStageRunID func() pipeline.StageRunID
	// TickInterval overrides the inflight-poll heartbeat. <=0 uses the default.
	TickInterval time.Duration
}

// Engine is one project's pipeline runtime. All exported methods are safe to
// call from any goroutine; each serializes onto the actor loop.
type Engine struct {
	projectID     domain.ProjectID
	store         Store
	execs         *executors.Set
	sink          ObservationSink
	log           *slog.Logger
	now           func() time.Time
	newRunID      func() pipeline.RunID
	newStageRunID func() pipeline.StageRunID
	tickInterval  time.Duration

	mailbox  chan func()
	quit     chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup
	baseCtx  context.Context
	cancel   context.CancelFunc

	// The fields below are owned exclusively by the actor goroutine and need no
	// lock: only the mailbox closures (which run on that goroutine) touch them.
	state    pipeline.EngineState
	inflight map[pipeline.StageRunID]executors.Handle
}

// New builds an Engine. It does not touch the store or start any goroutine;
// call Start for that.
func New(cfg Config) *Engine {
	e := &Engine{
		projectID:     cfg.ProjectID,
		store:         cfg.Store,
		execs:         cfg.Executors,
		sink:          cfg.Sink,
		log:           cfg.Logger,
		now:           cfg.Clock,
		newRunID:      cfg.NewRunID,
		newStageRunID: cfg.NewStageRunID,
		tickInterval:  cfg.TickInterval,
		mailbox:       make(chan func()),
		quit:          make(chan struct{}),
		state:         pipeline.EmptyEngineState(),
		inflight:      map[pipeline.StageRunID]executors.Handle{},
	}
	if e.log == nil {
		e.log = slog.Default()
	}
	if e.sink == nil {
		e.sink = slogSink{log: e.log}
	}
	if e.now == nil {
		e.now = func() time.Time { return time.Now().UTC() }
	}
	if e.newRunID == nil {
		e.newRunID = func() pipeline.RunID { return pipeline.RunID("run-" + uuid.NewString()) }
	}
	if e.newStageRunID == nil {
		e.newStageRunID = func() pipeline.StageRunID { return pipeline.StageRunID("sr-" + uuid.NewString()) }
	}
	if e.tickInterval <= 0 {
		e.tickInterval = defaultTickInterval
	}
	return e
}

// Start hydrates the engine's state from the store, launches the actor loop, and
// reconciles any stages left running by a previous process. It returns an error
// only if hydration fails; after Start the engine serves entry points until Stop.
func (e *Engine) Start(ctx context.Context) error {
	e.baseCtx, e.cancel = context.WithCancel(context.Background())

	// Hydrate before the actor serves. Nothing else touches e.state yet, so this
	// direct assignment is race-free.
	state, err := e.store.HydratePipelineEngineState(ctx, e.projectID)
	if err != nil {
		e.cancel()
		return fmt.Errorf("pipeline engine %s: hydrate: %w", e.projectID, err)
	}
	e.state = state

	e.wg.Add(1)
	go e.runLoop()

	// Stages persisted as "running" have no live executor handle in this process.
	// Fail them so their runs advance (recovery branch) or terminate as stalled,
	// exactly as the old engine's reconcileInflightStages did on hydrate.
	e.do(e.reconcileInflight)
	return nil
}

// Stop cancels every non-terminal run (tearing down its inflight stages and
// reclaiming session-owned worktrees), stops the actor loop, and waits for it to
// drain. Idempotent. After Stop the engine must not be used.
func (e *Engine) Stop(ctx context.Context) error {
	e.stopOnce.Do(func() {
		// Cancel in-flight work on the actor so teardown is serialized with any
		// in-progress reduce, then stop the loop and cancel base I/O.
		e.do(e.shutdown)
		close(e.quit)
		if e.cancel != nil {
			e.cancel()
		}
	})
	e.wg.Wait()
	return nil
}

// runLoop is the single actor goroutine: the only place e.state and e.inflight
// are read or written after Start.
func (e *Engine) runLoop() {
	defer e.wg.Done()
	ticker := time.NewTicker(e.tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-e.quit:
			return
		case fn := <-e.mailbox:
			fn()
		case <-ticker.C:
			e.tick()
		}
	}
}

// do runs fn on the actor goroutine and blocks until it completes. If the engine
// has stopped, fn is dropped and do returns immediately.
func (e *Engine) do(fn func()) {
	done := make(chan struct{})
	select {
	case e.mailbox <- func() { defer close(done); fn() }:
		<-done
	case <-e.quit:
	}
}

// ---------------------------------------------------------------------------
// Public entry points (each serialized onto the actor)
// ---------------------------------------------------------------------------

// TriggerRequest describes a run to start. IDs are allocated by TriggerRun.
type TriggerRequest struct {
	Pipeline  pipeline.Pipeline
	SessionID string
	// Trigger defaults to pipeline.TriggerManual when empty.
	Trigger pipeline.StageTriggerEvent
	HeadSHA string
	// Context carries PR identity, issue id, and session facts threaded into
	// the run and its stage executors. PR fields are empty for manual triggers.
	Context pipeline.RunContext
}

// TriggerRun allocates a RunID plus one StageRunID per stage, then dispatches
// TRIGGER_FIRED. The pipeline is validated for DAG cycles first (defense in
// depth; definitions are validated at author time by the CRUD layer). Returns
// the allocated RunID, or an error if the config is structurally invalid.
func (e *Engine) TriggerRun(req TriggerRequest) (pipeline.RunID, error) {
	if err := pipeline.ValidateDAG(&req.Pipeline); err != nil {
		return "", fmt.Errorf("pipeline engine %s: reject trigger for %q: %w", e.projectID, req.Pipeline.Name, err)
	}

	trigger := req.Trigger
	if trigger == "" {
		trigger = pipeline.TriggerManual
	}
	runID := e.newRunID()
	stageRunIDs := make(map[string]pipeline.StageRunID, len(req.Pipeline.Stages))
	for _, s := range req.Pipeline.Stages {
		stageRunIDs[s.Name] = e.newStageRunID()
	}

	e.do(func() {
		e.reduceAndExecute(pipeline.TriggerFired{
			Now:         e.now(),
			Trigger:     trigger,
			SessionID:   req.SessionID,
			Pipeline:    req.Pipeline,
			HeadSHA:     req.HeadSHA,
			Context:     req.Context,
			RunID:       runID,
			StageRunIDs: stageRunIDs,
		})
	})
	return runID, nil
}

// Cancel terminates an in-flight run. Unknown runs are a no-op. reason defaults
// to manual_cancel.
func (e *Engine) Cancel(runID pipeline.RunID, reason pipeline.RunTerminationReason) {
	if reason == "" {
		reason = pipeline.TerminationManualCancel
	}
	e.do(func() {
		run, ok := e.state.Runs[runID]
		if !ok {
			return
		}
		// The reducer's RUN_CANCELLED guard rejects already-terminal runs; skip
		// them here so a redundant cancel stays a clean no-op rather than an
		// invalid-transition observation.
		if run.LoopState.IsTerminal() {
			return
		}
		e.reduceAndExecute(pipeline.RunCancelled{Now: e.now(), RunID: runID, Reason: reason})
	})
}

// Resume re-arms a terminal (stalled/failed) run: failed and externally-cancelled
// stages get fresh StageRunIDs and the loop restarts. Unknown or non-terminal
// runs are a no-op.
func (e *Engine) Resume(runID pipeline.RunID) {
	e.do(func() {
		run, ok := e.state.Runs[runID]
		if !ok || !run.LoopState.IsTerminal() {
			return
		}
		ids := map[string]pipeline.StageRunID{}
		hasResumable := false
		for name, st := range run.Stages {
			if st.Status == pipeline.StageStatusFailed || st.Status == pipeline.StageStatusOutdated {
				ids[name] = e.newStageRunID()
				hasResumable = true
			}
		}
		// A stalled run with no failed/outdated stages (every stage
		// succeeded/skipped, e.g. a loop_rounds_at_least stall or an unmet `done`
		// predicate) can still be resumed to grant a genuine extra round. The
		// reducer re-pends ALL stages in that case, so allocate a fresh id per
		// stage here.
		if !hasResumable && run.LoopState == pipeline.LoopStalled {
			for name := range run.Stages {
				ids[name] = e.newStageRunID()
			}
		}
		e.reduceAndExecute(pipeline.RunResumed{Now: e.now(), RunID: runID, StageRunIDs: ids})
	})
}

// ArtifactStatusRequest changes one artifact's status (e.g. dismissing a
// finding) on a run.
type ArtifactStatusRequest struct {
	RunID      pipeline.RunID
	StageRunID pipeline.StageRunID
	ArtifactID pipeline.ArtifactID
	Status     pipeline.ArtifactStatus
	// Actor is an optional audit label.
	Actor string
}

// ChangeArtifactStatus dispatches ARTIFACT_STATUS_CHANGED.
func (e *Engine) ChangeArtifactStatus(req ArtifactStatusRequest) {
	e.do(func() {
		e.reduceAndExecute(pipeline.ArtifactStatusChanged{
			Now:        e.now(),
			RunID:      req.RunID,
			StageRunID: req.StageRunID,
			ArtifactID: req.ArtifactID,
			Status:     req.Status,
			Actor:      req.Actor,
		})
	})
}

// Dispatch feeds a pre-formed event through the reducer. It is the seam for T6
// trigger bridging (NEW_SHA_DETECTED, CONFIG_CHANGED) and any caller that builds
// its own event. Prefer TriggerRun for starting runs so IDs are allocated.
func (e *Engine) Dispatch(event pipeline.Event) {
	e.do(func() { e.reduceAndExecute(event) })
}

// Tick polls inflight stage handles once, synchronously. Production drives this
// on an internal heartbeat; tests call it for determinism.
func (e *Engine) Tick() {
	e.do(e.tick)
}

// State returns a snapshot of the engine's current EngineState. The reducer is
// copy-on-write, so the returned value is safe to read.
func (e *Engine) State() pipeline.EngineState {
	snap := pipeline.EmptyEngineState()
	e.do(func() { snap = e.state })
	return snap
}

// ---------------------------------------------------------------------------
// Actor-goroutine internals (never call these off the actor)
// ---------------------------------------------------------------------------

// reduceAndExecute is the Go analogue of the old dispatchInline: reduce, then
// execute each effect (which may recurse back through here for follow-up events),
// then prune terminated run metadata. Runs only on the actor goroutine.
func (e *Engine) reduceAndExecute(event pipeline.Event) {
	var effects []pipeline.Effect
	e.state, effects = pipeline.Reduce(e.state, event)
	for _, eff := range effects {
		e.executeEffect(eff)
	}
}

func (e *Engine) executeEffect(eff pipeline.Effect) {
	switch ef := eff.(type) {
	case pipeline.PersistRun:
		if err := e.store.SavePipelineRun(e.baseCtx, e.projectID, ef.RunState); err != nil {
			e.observe("pipeline.persist.failed", map[string]any{"effect": "PERSIST_RUN", "runId": string(ef.RunState.RunID), "error": err.Error()})
		}
	case pipeline.PersistLoopState:
		// ponytail: no-op in v1. T3 has no loop table; loop pointers and history
		// are derived on hydrate from the runs themselves. This arm is a
		// documented seam so a phase-2 loop table slots in without touching the
		// reducer's effect contract.
	case pipeline.AppendArtifacts:
		if err := e.store.AppendPipelineArtifacts(e.baseCtx, e.projectID, ef.Artifacts); err != nil {
			e.observe("pipeline.persist.failed", map[string]any{"effect": "APPEND_ARTIFACTS", "runId": string(ef.RunID), "error": err.Error()})
		}
	case pipeline.UpdateArtifactStatus:
		var sentAt *time.Time
		if ef.Status == pipeline.ArtifactStatusSentToAgent {
			t := e.now()
			sentAt = &t
		}
		if _, err := e.store.UpdatePipelineArtifactStatus(e.baseCtx, ef.ArtifactID, ef.Status, sentAt); err != nil {
			e.observe("pipeline.persist.failed", map[string]any{"effect": "UPDATE_ARTIFACT_STATUS", "artifactId": string(ef.ArtifactID), "error": err.Error()})
		}
	case pipeline.EmitObservation:
		e.observe(ef.Name, ef.Data)
	case pipeline.StartStage:
		e.startStage(ef)
	case pipeline.CancelStage:
		e.cancelStage(ef)
	default:
		e.observe("pipeline.effect.unknown", map[string]any{"type": string(eff.Type())})
	}
}

// startStage begins a stage's executor, then feeds STAGE_STARTED (on success) or
// STAGE_FAILED (on a start error) back through the reducer. Following the task
// contract: Start first, then STAGE_STARTED. The reducer allows STAGE_FAILED from
// pending, so a start error still lands cleanly.
func (e *Engine) startStage(eff pipeline.StartStage) {
	run, ok := e.state.Runs[eff.RunID]
	if !ok {
		return
	}
	h, err := e.execs.Start(e.baseCtx, e.startInput(run, eff))
	if err != nil {
		e.reduceAndExecute(pipeline.StageFailed{Now: e.now(), RunID: eff.RunID, StageName: eff.Stage.Name, ErrorMessage: err.Error()})
		return
	}
	e.inflight[eff.StageRunID] = h
	e.reduceAndExecute(pipeline.StageStarted{Now: e.now(), RunID: eff.RunID, StageName: eff.Stage.Name})
}

func (e *Engine) startInput(run pipeline.RunState, eff pipeline.StartStage) executors.StartInput {
	loopRound := run.LoopRounds
	allowFork := run.PipelineConfigSnapshot.AllowForkPRs != nil && *run.PipelineConfigSnapshot.AllowForkPRs
	return executors.StartInput{
		PipelineName:     run.PipelineName,
		ProjectID:        string(e.projectID),
		RunID:            eff.RunID,
		StageRunID:       eff.StageRunID,
		Stage:            eff.Stage,
		IssueID:          run.Context.IssueID,
		LoopRound:        &loopRound,
		LinkedSessionID:  run.SessionID,
		AllowForkPRs:     allowFork,
		Context:          run.Context,
		UpstreamFindings: upstreamFindings(run, eff.Stage.DependsOn),
	}
}

// upstreamFindings resolves the finding artifacts produced by a stage's
// dependsOn stages, read from the run's in-memory materialized findings (the
// same set the builtin dispatcher fetches from the store, but already
// denormalized: finding artifacts are mirrored onto run.Findings by
// finalizeStageCompletion, so no store round-trip is needed here).
// The result is a flat slice sorted by stage name then fingerprint so the agent
// prompt is deterministic. Returns nil when the stage has no dependsOn or no
// upstream findings exist yet.
func upstreamFindings(run pipeline.RunState, dependsOn []string) []pipeline.Artifact {
	if len(dependsOn) == 0 || len(run.Findings) == 0 {
		return nil
	}
	deps := make(map[string]bool, len(dependsOn))
	for _, d := range dependsOn {
		deps[d] = true
	}
	var out []pipeline.Artifact
	for _, f := range run.Findings {
		if f.Kind == pipeline.ArtifactKindFinding && deps[f.StageName] {
			out = append(out, f)
		}
	}
	if len(out) == 0 {
		return nil
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StageName != out[j].StageName {
			return out[i].StageName < out[j].StageName
		}
		return out[i].Fingerprint < out[j].Fingerprint
	})
	return out
}

func (e *Engine) cancelStage(eff pipeline.CancelStage) {
	h, ok := e.inflight[eff.StageRunID]
	if !ok {
		return
	}
	delete(e.inflight, eff.StageRunID)
	if err := e.execs.Cancel(e.baseCtx, h); err != nil {
		e.observe("pipeline.cancel.failed", map[string]any{
			"runId": string(eff.RunID), "stageRunId": string(eff.StageRunID),
			"stageName": eff.StageName, "error": err.Error(),
		})
	}
}

// tick advances the engine one heartbeat: it polls every inflight handle for a
// terminal outcome, then dispatches pipeline.Tick so the reducer can fail any
// running stage whose deadline has passed (an executor that never reports
// terminal would otherwise wedge the run in `running` forever). Polling runs
// first so a stage that completed on its own is finalized normally rather than
// timed out.
func (e *Engine) tick() {
	e.pollInflight()
	// Deadline enforcement. Cheap no-op when no stage is running past its
	// deadline; the reducer's Tick arm is pure and only reads event.Now.
	e.reduceAndExecute(pipeline.Tick{Now: e.now()})
}

// pollInflight polls every inflight handle. A terminal outcome is removed from
// the inflight set and fed back as STAGE_COMPLETED / STAGE_FAILED. Handles are
// snapshotted first because a completing stage can, via the reducer, cancel a
// sibling (removing it from inflight) or start a new stage (adding one).
func (e *Engine) pollInflight() {
	if len(e.inflight) == 0 {
		return
	}
	keys := make([]pipeline.StageRunID, 0, len(e.inflight))
	for k := range e.inflight {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })

	for _, k := range keys {
		h, ok := e.inflight[k]
		if !ok {
			// Removed by a prior iteration's cascade (e.g. a sibling completing
			// terminated the run and cancelled this stage). Nothing to poll.
			continue
		}
		outcome, err := e.execs.Poll(e.baseCtx, h)
		if err != nil {
			delete(e.inflight, k)
			e.reduceAndExecute(pipeline.StageFailed{Now: e.now(), RunID: h.RunID(), StageName: h.StageName(), ErrorMessage: fmt.Sprintf("stage poll error: %v", err)})
			continue
		}
		if outcome.Status == executors.OutcomeRunning {
			continue
		}
		delete(e.inflight, k)
		notes := observationNotes(outcome.Observations)
		if outcome.Status == executors.OutcomeCompleted {
			// StatusChanges ride the event so the reducer applies them (to
			// run.Findings and the store) before the exit decision, letting a
			// last-stage resolve/reopen change whether the run is done.
			e.reduceAndExecute(pipeline.StageCompleted{Now: e.now(), RunID: h.RunID(), StageName: h.StageName(), Verdict: outcome.Verdict, Artifacts: outcome.Artifacts, StatusChanges: outcome.StatusChanges, Output: outcome.Output, SessionID: outcome.SessionID, Notes: notes})
		} else {
			e.reduceAndExecute(pipeline.StageFailed{Now: e.now(), RunID: h.RunID(), StageName: h.StageName(), ErrorMessage: outcome.ErrorMessage, Output: outcome.Output, SessionID: outcome.SessionID, Notes: notes})
		}
		e.routeObservations(outcome.Observations)
	}
}

// reconcileInflight fails every stage a previous process left running: the
// in-memory executor handle is gone, so the stage can never complete on its own.
func (e *Engine) reconcileInflight() {
	type candidate struct {
		runID pipeline.RunID
		stage string
	}
	var candidates []candidate
	for _, run := range e.state.Runs {
		if run.LoopState.IsTerminal() {
			continue
		}
		for name, st := range run.Stages {
			if st.Status == pipeline.StageStatusRunning {
				candidates = append(candidates, candidate{run.RunID, name})
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].runID != candidates[j].runID {
			return candidates[i].runID < candidates[j].runID
		}
		return candidates[i].stage < candidates[j].stage
	})
	for _, c := range candidates {
		e.reduceAndExecute(pipeline.StageFailed{
			Now:          e.now(),
			RunID:        c.runID,
			StageName:    c.stage,
			ErrorMessage: "pipeline engine restarted while stage was running; in-flight executor handle is lost",
		})
	}
}

// shutdown cancels every non-terminal run so in-flight stages tear down (killing
// session-owned worktrees, spec §9 note 9) and final state is persisted.
func (e *Engine) shutdown() {
	var ids []pipeline.RunID
	for id, run := range e.state.Runs {
		if !run.LoopState.IsTerminal() {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		e.reduceAndExecute(pipeline.RunCancelled{Now: e.now(), RunID: id, Reason: pipeline.TerminationManualCancel})
	}
}

func (e *Engine) routeObservations(obs []executors.Observation) {
	for _, o := range obs {
		e.observe(o.Name, o.Data)
	}
}

// observationNotes extracts the human-readable one-line notes an outcome's
// observations carry, in order, so the reducer can persist them onto the stage
// state for the run detail. Observations with no Note (telemetry-only) are
// skipped; the reducer caps the total.
func observationNotes(obs []executors.Observation) []string {
	notes := make([]string, 0, len(obs))
	for _, o := range obs {
		if o.Note != "" {
			notes = append(notes, o.Note)
		}
	}
	return notes
}

// observe forwards an observation to the sink, enriching it with the project id
// when the caller did not already set one.
func (e *Engine) observe(name string, data map[string]any) {
	if _, ok := data["projectId"]; !ok {
		enriched := make(map[string]any, len(data)+1)
		for k, v := range data {
			enriched[k] = v
		}
		enriched["projectId"] = string(e.projectID)
		data = enriched
	}
	e.sink.Observe(name, data)
}

// slogSink is the default ObservationSink: structured logging that never drops.
type slogSink struct{ log *slog.Logger }

func (s slogSink) Observe(name string, data map[string]any) {
	attrs := make([]any, 0, len(data)+1)
	attrs = append(attrs, slog.String("observation", name))
	for k, v := range data {
		attrs = append(attrs, slog.Any(k, v))
	}
	s.log.Info("pipeline observation", attrs...)
}
