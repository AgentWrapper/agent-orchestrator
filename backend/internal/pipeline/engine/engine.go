// Package engine runs pipelines. This file is the per-project actor: one
// goroutine owns every run's state, feeds events into the pure reducer, and
// executes the effects it hands back.
//
// The single-writer invariant is the correctness property the whole design
// rests on: nothing outside the actor goroutine reads or writes the run map or
// the inflight handle map. Public entry points post a closure onto the mailbox
// and block until it runs; effect execution feeds follow-up events back through
// the reducer synchronously on the same goroutine, so there is no re-entrancy
// deadlock and no interleaving.
//
// The actor shape (mailbox, 2s ticker, inflight handles, hydrate on boot) is
// ported from the v1 engine because it was proven; everything inside it is v2.
package engine

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/triggers"
)

// defaultTickInterval is how often the engine polls inflight stages and feeds a
// Tick for deadline enforcement. Stages settle asynchronously, so the loop needs
// a heartbeat to make progress; 2s balances latency against churn.
const defaultTickInterval = 2 * time.Second

// Store is the persistence surface the engine drives. It is a subset of the
// sqlite store so the engine unit-tests against a fake; *store.Store satisfies
// it. SQLite stays the store of record (decision D2); run.json in the run
// folder is a projection written alongside every save.
type Store interface {
	// SavePipelineRun takes a pointer because the store assigns the run's
	// per-pipeline RunNumber on insert and hands it back through the argument.
	SavePipelineRun(ctx context.Context, run *pipeline.RunState) error
	HydratePipelineEngineState(ctx context.Context, projectID domain.ProjectID) ([]pipeline.RunState, error)
}

// Credentials is the engine's view of a project's engine-held credentials
// (decision D13). Names feeds the plan-time unknown-credential check; Resolve
// produces the values a command stage's process env gets at exec time. Nothing
// here ever reaches an agent.
type Credentials interface {
	Resolve(ctx context.Context, projectID string, names []string) (map[string]string, error)
	Names(ctx context.Context, projectID string) ([]string, error)
}

// SessionDisposer kills a stage's session when the stage's kill-on rule says so
// (spec section 7.2). executors.SessionSpawner satisfies it.
type SessionDisposer interface {
	Kill(ctx context.Context, sessionID string) error
}

// Config constructs an Engine. ProjectID, Store, Executors, Workspaces and
// BaseDir are required; everything else defaults.
type Config struct {
	ProjectID domain.ProjectID
	Store     Store
	// Executors routes a stage to the executor for its kind. Production wires
	// an *executors.Set.
	Executors executors.StageExecutor
	// Workspaces provisions a stage's tree lazily, when its StartStage effect
	// executes (decision D8).
	Workspaces executors.WorkspaceProvisioner
	// Sessions applies the kill half of the kill-on rule. Optional: without it
	// a session is always kept.
	Sessions SessionDisposer
	// Orphans marks and bounds the sessions the kill-on rule spares. Optional:
	// a nil registry keeps every spared session forever and unmarked, which is
	// what a test engine wants and what production must never be.
	Orphans *OrphanRegistry
	// Messenger delivers the one nudge a stage may get. Optional: without it a
	// nudge cannot be delivered and the stage settles on its next poll.
	Messenger executors.SessionMessenger
	// Credentials resolves engine-held credentials. Optional: without it the
	// plan-time unknown-name check is skipped and a stage declaring
	// credentials fails to launch.
	Credentials Credentials
	// ProcessGroups reaps the process group of a command stage a previous
	// daemon left running, so restart reconciliation does not settle a stage
	// and leak its work. Defaults to the OS reaper: a nil here would make the
	// leak come back silently, and the OS reaper is safe to run against a
	// stage that recorded no group.
	ProcessGroups executors.ProcessGroupReaper
	// BaseDir is the run-folder root, <AO_DATA_DIR>/pipelines. No app state
	// ever lands anywhere else.
	BaseDir string
	// Concurrency is the table the supervisor shares across its engines. A nil
	// table gets a private one, which is what a single-engine test wants.
	Concurrency *ConcurrencyTable
	// StartQueued starts a trigger that was waiting on a concurrency key and
	// just got it. The supervisor routes it to the right project's engine; a
	// nil value starts it on this engine.
	StartQueued func(pendingTrigger)

	Logger *slog.Logger
	// Clock is the driver clock stamped onto every event. The reducer never
	// reads a clock of its own, which is what makes it testable.
	Clock        func() time.Time
	NewRunID     func() pipeline.RunID
	TickInterval time.Duration
}

// stageKey identifies one running stage across the runs the engine holds.
type stageKey struct {
	RunID pipeline.RunID
	Stage string
}

// Engine is one project's pipeline runtime. Every exported method is safe to
// call from any goroutine; each serializes onto the actor loop.
type Engine struct {
	projectID   domain.ProjectID
	store       Store
	execs       executors.StageExecutor
	workspaces  executors.WorkspaceProvisioner
	sessions    SessionDisposer
	orphans     *OrphanRegistry
	messenger   executors.SessionMessenger
	creds       Credentials
	procGroups  executors.ProcessGroupReaper
	baseDir     string
	concurrency *ConcurrencyTable
	startQueued func(pendingTrigger)

	log          *slog.Logger
	now          func() time.Time
	newRunID     func() pipeline.RunID
	tickInterval time.Duration

	mailbox  chan func()
	quit     chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup
	baseCtx  context.Context
	cancel   context.CancelFunc

	// The fields below are owned exclusively by the actor goroutine and need no
	// lock: only mailbox closures touch them.
	runs     map[pipeline.RunID]pipeline.RunState
	inflight map[stageKey]executors.Handle
	// keys remembers which concurrency key a run holds, so the run can release
	// exactly what it took when it settles.
	keys map[pipeline.RunID]groupKey
	// owned lists the workspaces a run created and may therefore destroy.
	owned map[pipeline.RunID][]string
	// occupied lists owned workspaces a spared session is still living in.
	// Agent stages run in the resolved tree, so destroying one of these would
	// delete the working directory of a pane the kill-on rule kept on purpose.
	occupied map[pipeline.RunID][]string
}

// New builds an Engine. It touches neither the store nor any goroutine; call
// Start.
func New(cfg Config) *Engine {
	e := &Engine{
		projectID:    cfg.ProjectID,
		store:        cfg.Store,
		execs:        cfg.Executors,
		workspaces:   cfg.Workspaces,
		sessions:     cfg.Sessions,
		orphans:      cfg.Orphans,
		messenger:    cfg.Messenger,
		creds:        cfg.Credentials,
		procGroups:   cfg.ProcessGroups,
		baseDir:      cfg.BaseDir,
		concurrency:  cfg.Concurrency,
		startQueued:  cfg.StartQueued,
		log:          cfg.Logger,
		now:          cfg.Clock,
		newRunID:     cfg.NewRunID,
		tickInterval: cfg.TickInterval,
		mailbox:      make(chan func()),
		quit:         make(chan struct{}),
		runs:         map[pipeline.RunID]pipeline.RunState{},
		inflight:     map[stageKey]executors.Handle{},
		keys:         map[pipeline.RunID]groupKey{},
		owned:        map[pipeline.RunID][]string{},
		occupied:     map[pipeline.RunID][]string{},
	}
	if e.log == nil {
		e.log = slog.Default()
	}
	if e.now == nil {
		e.now = func() time.Time { return time.Now().UTC() }
	}
	if e.newRunID == nil {
		e.newRunID = func() pipeline.RunID { return pipeline.RunID("run-" + uuid.NewString()) }
	}
	if e.concurrency == nil {
		e.concurrency = &ConcurrencyTable{}
	}
	if e.procGroups == nil {
		e.procGroups = executors.NewProcessGroupReaper()
	}
	if e.tickInterval <= 0 {
		e.tickInterval = defaultTickInterval
	}
	return e
}

var _ triggers.Engine = (*Engine)(nil)

// Start hydrates unsettled runs from the store, launches the actor loop, and
// reconciles the stages a previous process left running. It fails only when
// hydration does.
func (e *Engine) Start(ctx context.Context) error {
	e.baseCtx, e.cancel = context.WithCancel(context.Background())

	// Hydrate before the actor serves: nothing else touches e.runs yet, so the
	// direct assignment is race-free.
	runs, err := e.store.HydratePipelineEngineState(ctx, e.projectID)
	if err != nil {
		e.cancel()
		return fmt.Errorf("pipeline engine %s: hydrate: %w", e.projectID, err)
	}
	for _, run := range runs {
		e.runs[run.RunID] = run
	}

	e.wg.Add(1)
	go e.runLoop()

	// A daemon restart cannot resume a Poll loop, so a stage persisted running
	// has no handle anywhere and can never settle on its own (decision D16).
	e.do(e.reconcileLostStages)
	return nil
}

// Stop halts the actor loop and cancels in-flight I/O. Idempotent. Runs are
// left as they are: sessions and worktrees outlive the daemon, and the next
// Start reconciles whatever was running.
func (e *Engine) Stop(context.Context) error {
	e.stopOnce.Do(func() {
		close(e.quit)
		if e.cancel != nil {
			e.cancel()
		}
	})
	e.wg.Wait()
	return nil
}

// runLoop is the single actor goroutine: the only place e.runs and e.inflight
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

// do runs fn on the actor goroutine and blocks until it completes. A stopped
// engine drops fn and returns.
func (e *Engine) do(fn func()) {
	done := make(chan struct{})
	select {
	case e.mailbox <- func() { defer close(done); fn() }:
		<-done
	case <-e.quit:
	}
}

// ---------------------------------------------------------------------------
// Entry points (each serialized onto the actor)
// ---------------------------------------------------------------------------

// TriggerRun admits a trigger against the concurrency table and, when it holds
// the key, starts the run: allocate the id, create the run folder, freeze the
// definition, plan, then feed TriggerFired.
//
// The returned run id is allocated before admission, so a queued trigger still
// names the run it will become. A queued trigger has no run in the store yet:
// the id is a promise, not a row.
func (e *Engine) TriggerRun(req triggers.TriggerRequest) (pipeline.RunID, error) {
	if req.Definition.Config.EntryStage() == nil {
		return "", fmt.Errorf("pipeline engine %s: pipeline %q declares no stages", e.projectID, req.Definition.Name)
	}

	trigger := pendingTrigger{
		Definition: req.Definition,
		Event:      req.Event,
		Subject:    req.Subject,
		RunID:      e.newRunID(),
	}
	key := keyFor(req.Definition, req.Subject)
	admission := e.concurrency.Admit(key, req.Definition.Config.Concurrency.CancelInProgress, trigger)

	switch admission.Kind {
	case Queued:
		e.log.Info("pipeline run queued behind its concurrency key",
			"project", e.projectID, "pipeline", req.Definition.Name, "group", key.Group, "scope", key.ScopeIdentity)
		return trigger.RunID, nil
	case CancelThenStart:
		// cancel-in-progress: the newcomer already holds the key, so the victim
		// is torn down and its release is a no-op.
		e.Cancel(admission.Victim, fmt.Sprintf("superseded by a newer run of %q", req.Definition.Name))
	case StartNow:
	}

	e.do(func() { e.startTrigger(trigger, key) })
	return trigger.RunID, nil
}

// Cancel tears an in-flight run down. Unknown or settled runs are a no-op.
func (e *Engine) Cancel(runID pipeline.RunID, reason string) {
	if reason == "" {
		reason = "cancelled"
	}
	e.do(func() {
		run, ok := e.runs[runID]
		if !ok || runSettled(run.Status) {
			return
		}
		e.dispatch(runID, pipeline.CancelRequested{Reason: reason, Now: e.now()})
	})
}

// Tick polls every inflight stage once and enforces deadlines, synchronously.
// Production drives this on the heartbeat; tests call it for determinism.
func (e *Engine) Tick() { e.do(e.tick) }

// Run returns one run's current state. The reducer is copy-on-write, so the
// returned value is safe to read off the actor.
func (e *Engine) Run(id pipeline.RunID) (pipeline.RunState, bool) {
	var (
		run pipeline.RunState
		ok  bool
	)
	e.do(func() { run, ok = e.runs[id] })
	return run, ok
}

// Runs returns every run the engine holds, oldest id first.
func (e *Engine) Runs() []pipeline.RunState {
	var out []pipeline.RunState
	e.do(func() {
		out = make([]pipeline.RunState, 0, len(e.runs))
		for _, run := range e.runs {
			out = append(out, run)
		}
	})
	sort.Slice(out, func(i, j int) bool { return out[i].RunID < out[j].RunID })
	return out
}

// ---------------------------------------------------------------------------
// Actor internals (never call these off the actor goroutine)
// ---------------------------------------------------------------------------

// startTrigger materialises a run: the folder first (so the frozen definition
// exists before anything reads it), then the reducer's TriggerFired, which
// plans and either starts the entry stage or settles the run failed with the
// plan's reason.
func (e *Engine) startTrigger(trigger pendingTrigger, key groupKey) {
	now := e.now()
	def := trigger.Definition
	subject := trigger.Subject
	if subject.ProjectID == "" {
		subject.ProjectID = string(e.projectID)
	}

	folder, err := pipeline.CreateRunFolder(e.baseDir, subject.ProjectID, trigger.RunID, []byte(def.YAMLSource))
	if err != nil {
		// Without a folder the run has nowhere to write, so it never starts. It
		// is still recorded as failed: a trigger that vanished silently is worse
		// than a red card with a reason.
		e.log.Error("pipeline run folder", "project", e.projectID, "run", trigger.RunID, "err", err)
		e.persistFolderlessFailure(trigger, subject, err, now)
		e.releaseKey(trigger.RunID, key)
		return
	}

	e.runs[trigger.RunID] = pipeline.RunState{
		RunID:        trigger.RunID,
		ProjectID:    subject.ProjectID,
		PipelineID:   def.ID,
		PipelineName: def.Config.Name,
		Subject:      subject,
		Status:       pipeline.RunPending,
		RunDir:       folder.Dir,
		Def:          def.Config,
		Stages:       map[string]*pipeline.StageState{},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	e.keys[trigger.RunID] = key

	e.dispatch(trigger.RunID, pipeline.TriggerFired{
		Def:              def.Config,
		Subject:          subject,
		RunID:            trigger.RunID,
		RunDir:           folder.Dir,
		KnownCredentials: e.knownCredentials(subject.ProjectID),
		Now:              now,
	})
}

// persistFolderlessFailure records a run that could not even be created. There
// is no run folder, so this writes the store row directly rather than going
// through the reducer, whose every effect wants a folder to write into.
func (e *Engine) persistFolderlessFailure(trigger pendingTrigger, subject pipeline.Subject, cause error, now time.Time) {
	run := pipeline.RunState{
		RunID:        trigger.RunID,
		ProjectID:    subject.ProjectID,
		PipelineID:   trigger.Definition.ID,
		PipelineName: trigger.Definition.Config.Name,
		Subject:      subject,
		Status:       pipeline.RunFailed,
		Stages:       map[string]*pipeline.StageState{},
		CreatedAt:    now,
		UpdatedAt:    now,
		SettledAt:    now,
	}
	if entry := trigger.Definition.Config.EntryStage(); entry != nil {
		run.Stages[entry.ID] = &pipeline.StageState{
			ID:         entry.ID,
			Outcome:    pipeline.OutcomeFailed,
			EnteredVia: pipeline.EntryTrigger,
			SettledAt:  now,
			Reason:     fmt.Sprintf("create run folder: %v", cause),
		}
	}
	if err := e.store.SavePipelineRun(e.baseCtx, &run); err != nil {
		e.log.Error("pipeline persist run", "run", run.RunID, "err", err)
	}
}

// knownCredentials stamps the project's declared credential names onto
// TriggerFired the same way the clock is stamped, so the pure reducer can plan
// without a credential store.
//
// A read failure yields nil, which tells ComputePlan to skip the unknown-name
// check: a store hiccup must not fail a run for a credential that is fine. A
// name that really is missing still fails the stage at resolve time.
func (e *Engine) knownCredentials(projectID string) []string {
	if e.creds == nil {
		return nil
	}
	names, err := e.creds.Names(e.baseCtx, projectID)
	if err != nil {
		e.log.Warn("pipeline credential names", "project", projectID, "err", err)
		return nil
	}
	return names
}

// dispatch is the reduce-then-execute cycle. Effect execution can feed further
// events back through here, synchronously, on this goroutine.
func (e *Engine) dispatch(runID pipeline.RunID, ev pipeline.Event) {
	run, ok := e.runs[runID]
	if !ok {
		return
	}
	next, effects := pipeline.Reduce(run, ev)
	e.runs[runID] = next
	for _, eff := range effects {
		e.execute(runID, eff)
	}
	e.pruneInflight(runID)
}

func (e *Engine) execute(runID pipeline.RunID, eff pipeline.Effect) {
	switch ef := eff.(type) {
	case pipeline.PersistRun:
		e.persist(runID)
	case pipeline.AppendContext:
		e.appendContext(runID, ef.Line)
	case pipeline.StartStage:
		e.startStage(runID, ef)
	case pipeline.NudgeStage:
		e.nudge(runID, ef)
	case pipeline.InterruptStage:
		e.teardownStage(runID, ef.Stage, false)
	case pipeline.CancelStageExec:
		e.teardownStage(runID, ef.Stage, true)
	case pipeline.SettleSession:
		e.settleSession(runID, ef)
	case pipeline.RunSettled:
		e.runSettled(runID, ef)
	default:
		e.log.Warn("pipeline effect not handled", "run", runID, "effect", fmt.Sprintf("%T", eff))
	}
}

// persist writes the run to the store of record and rewrites run.json, the
// projection humans read (decision D2).
func (e *Engine) persist(runID pipeline.RunID) {
	run, ok := e.runs[runID]
	if !ok {
		return
	}
	if err := e.store.SavePipelineRun(e.baseCtx, &run); err != nil {
		e.log.Error("pipeline persist run", "run", runID, "err", err)
	}
	// The first save is where the store hands back the run number, so keep it:
	// everything downstream of here (run.json, the DTOs, the CLI) reads it, and
	// re-reading it from the row on every persist would be a query per save.
	if current, ok := e.runs[runID]; ok && current.RunNumber != run.RunNumber {
		current.RunNumber = run.RunNumber
		e.runs[runID] = current
	}
	if run.RunDir == "" {
		return
	}
	if err := (pipeline.RunFolder{Dir: run.RunDir}).WriteRunJSON(run); err != nil {
		e.log.Warn("pipeline write run.json", "run", runID, "err", err)
	}
}

func (e *Engine) appendContext(runID pipeline.RunID, line string) {
	run, ok := e.runs[runID]
	if !ok || run.RunDir == "" {
		return
	}
	if err := (pipeline.RunFolder{Dir: run.RunDir}).AppendContext(line); err != nil {
		e.log.Warn("pipeline append Context.md", "run", runID, "err", err)
	}
}

// startStage provisions the stage's tree, builds the ambient environment,
// resolves credentials for a command stage, and launches the executor. Any
// failure before the stage is actually running comes back as StageLaunchFailed,
// which settles the stage and routes it like any other failure.
func (e *Engine) startStage(runID pipeline.RunID, eff pipeline.StartStage) {
	run, ok := e.runs[runID]
	if !ok {
		return
	}
	st := run.Stages[eff.Stage]
	def := run.Def.StageByID(eff.Stage)
	if st == nil || def == nil {
		return
	}

	path, owned, err := e.provision(run, st, def)
	if err != nil {
		e.dispatch(runID, pipeline.StageLaunchFailed{Stage: eff.Stage, Reason: err.Error(), Now: e.now()})
		return
	}
	if owned {
		e.owned[runID] = appendUnique(e.owned[runID], path)
	}

	creds, err := e.resolveCredentials(run, def)
	if err != nil {
		e.dispatch(runID, pipeline.StageLaunchFailed{Stage: eff.Stage, Reason: err.Error(), Now: e.now()})
		return
	}

	attempt := eff.Attempt
	if attempt < 1 {
		attempt = 1
	}
	folder := pipeline.RunFolder{Dir: run.RunDir}
	handle, err := e.execs.Start(e.baseCtx, executors.StartInput{
		ProjectID:     run.ProjectID,
		RunID:         run.RunID,
		RunDir:        run.RunDir,
		Stage:         *def,
		Attempt:       attempt,
		Subject:       run.Subject,
		WorkspacePath: path,
		Env:           ambientEnv(run, st, def, path, attempt),
		Credentials:   creds,
		LogPath:       folder.LogPath(def.ID),
	})
	if err != nil {
		e.dispatch(runID, pipeline.StageLaunchFailed{Stage: eff.Stage, Reason: err.Error(), Now: e.now()})
		return
	}

	e.inflight[stageKey{RunID: runID, Stage: eff.Stage}] = handle
	sessionID := ""
	if holder, ok := handle.(executors.SessionHolder); ok {
		sessionID = holder.SessionID()
	}
	// The process group is what a later daemon reaps by: this handle is the
	// only other thing that can stop the work, and it dies with this process.
	pgid := 0
	if holder, ok := handle.(executors.ProcessGroupHolder); ok {
		pgid = holder.ProcessGroup()
	}
	e.dispatch(runID, pipeline.StageLaunched{
		Stage:         eff.Stage,
		SessionID:     sessionID,
		PGID:          pgid,
		WorkspacePath: path,
		Now:           e.now(),
	})
}

// provision resolves the stage's tree. `inherit` is handed the tree of the
// stage that routed here, which is the whole point of the failure-entry default
// (spec section 5.4).
func (e *Engine) provision(run pipeline.RunState, st *pipeline.StageState, def *pipeline.Stage) (string, bool, error) {
	inherit := ""
	if st.FailedStage != "" {
		if from := run.Stages[st.FailedStage]; from != nil {
			inherit = from.WorkspacePath
		}
	}
	return e.workspaces.Provision(e.baseCtx, executors.WorkspaceRequest{
		Kind:        st.WorkspaceKind,
		ProjectID:   run.ProjectID,
		RunID:       run.RunID,
		StageID:     def.ID,
		Subject:     run.Subject,
		InheritPath: inherit,
		BaseRef:     baseRef(run.Subject),
		RunDir:      run.RunDir,
	})
}

// baseRef is the ref a run or stage worktree starts from: the PR's head branch
// for a PR subject, and otherwise nothing, which lets the workspace adapter
// fall back to the project's default branch.
func baseRef(subject pipeline.Subject) string {
	if subject.PR != nil {
		return subject.PR.HeadBranch
	}
	return ""
}

// resolveCredentials resolves the stage's engine-held credentials. Command
// stages only: values never enter an agent's environment, and the schema
// forbids `credentials:` on an agent stage so the two rules enforce each other
// (spec section 8).
func (e *Engine) resolveCredentials(run pipeline.RunState, def *pipeline.Stage) (map[string]string, error) {
	if len(def.Credentials) == 0 || def.Executor != pipeline.ExecutorCommand {
		return nil, nil
	}
	if e.creds == nil {
		return nil, fmt.Errorf("stage %q declares credentials %v but this daemon has no credential store wired", def.ID, def.Credentials)
	}
	env, err := e.creds.Resolve(e.baseCtx, run.ProjectID, def.Credentials)
	if err != nil {
		return nil, fmt.Errorf("resolve credentials for stage %q: %w", def.ID, err)
	}
	return env, nil
}

// ambientEnv is the spec section 12.2 table, built here because the driver is
// the only place that knows all of it: the resolved tree, the attempt, and the
// stage's entry edge.
//
// AO_RUN_ID and AO_STAGE are the two that must never be absent: they are what
// `ao pipeline done|fail` resolves itself from (spec section 6.3).
//
// AO_ATTEMPT is stamped at launch. A nudge does not relaunch the stage, so a
// nudged agent reads 1 from its environment and learns it is on the second
// attempt from the nudge message itself.
func ambientEnv(run pipeline.RunState, st *pipeline.StageState, def *pipeline.Stage, workspacePath string, attempt int) map[string]string {
	folder := pipeline.RunFolder{Dir: run.RunDir}
	env := map[string]string{
		"AO_PROJECT":   run.ProjectID,
		"AO_RUN_ID":    string(run.RunID),
		"AO_RUN_DIR":   run.RunDir,
		"AO_STAGE":     def.ID,
		"AO_ATTEMPT":   strconv.Itoa(attempt),
		"AO_CONTEXT":   folder.ContextPath(),
		"AO_WORKSPACE": workspacePath,
	}
	if run.Subject.SessionID != "" {
		env["AO_SESSION_ID"] = run.Subject.SessionID
	}
	if pr := run.Subject.PR; pr != nil {
		env["AO_PR_NUMBER"] = strconv.Itoa(pr.Number)
		env["AO_PR_REPO"] = pr.Repo
		env["AO_PR_HEAD"] = pr.HeadSHA
	}
	// OutputPath is empty unless the stage declares `produces`, and validation
	// only allows that on an agent stage.
	if out := folder.OutputPath(def); out != "" {
		env["AO_OUTPUT"] = out
	}
	// AO_PREV_* is unset at a join, where it would be ambiguous: PrevStage is
	// empty exactly there (and at the entry stage).
	if st.PrevStage != "" {
		env["AO_PREV_STAGE"] = st.PrevStage
		if prev := run.Stages[st.PrevStage]; prev != nil {
			env["AO_PREV_OUTCOME"] = string(prev.Outcome)
		}
	}
	if st.EnteredVia == pipeline.EntryFailure && st.FailedStage != "" {
		env["AO_FAILED_STAGE"] = st.FailedStage
		env["AO_FAILED_OUTCOME"] = string(st.FailedOutcome)
	}
	return env
}

// nudge delivers the stage's one nudge and reports it back, which is what moves
// the stage to its second and last attempt. A delivery failure is not fatal: the
// stage stays running and settles on its next poll, because the reducer already
// recorded the nudge as spent.
func (e *Engine) nudge(runID pipeline.RunID, eff pipeline.NudgeStage) {
	if e.messenger == nil || eff.SessionID == "" {
		e.log.Warn("pipeline nudge undeliverable", "run", runID, "stage", eff.Stage, "session", eff.SessionID)
		return
	}
	if err := e.messenger.Send(e.baseCtx, eff.SessionID, eff.Message); err != nil {
		e.log.Warn("pipeline nudge send", "run", runID, "stage", eff.Stage, "err", err)
		return
	}
	e.dispatch(runID, pipeline.NudgeDelivered{Stage: eff.Stage, Now: e.now()})
}

// teardownStage stops a stage's work. kill true is run cancellation (tear the
// session down with it); kill false is the deadline path, which stops the work
// and leaves the session alive so a human can see what it was doing (spec
// section 7.2).
func (e *Engine) teardownStage(runID pipeline.RunID, stage string, kill bool) {
	key := stageKey{RunID: runID, Stage: stage}
	handle, ok := e.inflight[key]
	if !ok {
		return
	}
	delete(e.inflight, key)
	var err error
	if kill {
		err = e.execs.Cancel(e.baseCtx, handle)
	} else {
		err = e.execs.Interrupt(e.baseCtx, handle)
	}
	if err != nil {
		e.log.Warn("pipeline stage teardown", "run", runID, "stage", stage, "kill", kill, "err", err)
	}
}

// settleSession applies the stage's kill-on rule. An outcome in the list kills
// the session; anything else keeps it, because no_output, no_signal and
// timed_out are precisely the cases where a human needs to see what the agent
// was doing (spec section 7.2). A kept session is handed to the orphan registry,
// which marks it pipeline-orphaned in the session list and bounds the leak (cap
// 3 per pipeline, 24h TTL).
func (e *Engine) settleSession(runID pipeline.RunID, eff pipeline.SettleSession) {
	if eff.SessionID == "" {
		return
	}
	run, ok := e.runs[runID]
	if !ok {
		return
	}
	def := run.Def.StageByID(eff.Stage)
	if def == nil {
		return
	}
	if def.KillsOn(eff.Outcome) {
		if e.sessions == nil {
			e.log.Warn("pipeline session kill skipped: no session seam wired", "run", runID, "stage", eff.Stage)
			return
		}
		if err := e.sessions.Kill(e.baseCtx, eff.SessionID); err != nil {
			e.log.Warn("pipeline session kill", "run", runID, "stage", eff.Stage, "err", err)
		}
		return
	}

	// Kept: the outcomes that get here (no_output, no_signal, timed_out) are
	// exactly the ones a human may want to inspect, which is the whole point of
	// the feature, so the session survives and gets a badge instead. The stage's
	// tree is pinned with it: the session runs in that tree, so a kept session in
	// a destroyed workspace is a pane with no working directory.
	if st := run.Stages[eff.Stage]; st != nil && st.WorkspacePath != "" {
		e.occupied[runID] = appendUnique(e.occupied[runID], st.WorkspacePath)
	}
	e.orphans.Keep(e.baseCtx, orphanKey(string(e.projectID), run.PipelineName), domain.PipelineOrphanInfo{
		RunID:    string(runID),
		Stage:    eff.Stage,
		Outcome:  string(eff.Outcome),
		KeptAt:   e.now(),
		Pipeline: run.PipelineName,
	}, eff.SessionID)
}

// runSettled tears down what the run owns and hands its concurrency key on.
// Owned trees are destroyed on success and kept on failure, the same rule as
// sessions and for the same reason (spec section 5.5).
func (e *Engine) runSettled(runID pipeline.RunID, eff pipeline.RunSettled) {
	for _, path := range e.owned[runID] {
		if eff.Status != pipeline.RunSucceeded {
			e.log.Info("pipeline workspace kept", "run", runID, "path", path, "status", eff.Status)
			continue
		}
		if slices.Contains(e.occupied[runID], path) {
			e.log.Info("pipeline workspace kept: a spared session is still in it", "run", runID, "path", path)
			continue
		}
		if err := e.workspaces.Destroy(e.baseCtx, path); err != nil {
			e.log.Warn("pipeline workspace destroy", "run", runID, "path", path, "err", err)
		}
	}
	delete(e.owned, runID)
	delete(e.occupied, runID)

	for key := range e.inflight {
		if key.RunID == runID {
			delete(e.inflight, key)
		}
	}
	if key, ok := e.keys[runID]; ok {
		e.releaseKey(runID, key)
	}
}

// releaseKey gives up a run's concurrency key and starts whatever was waiting
// for it. The queued trigger starts on another goroutine: it may belong to this
// engine, and posting onto our own mailbox from the actor would deadlock.
func (e *Engine) releaseKey(runID pipeline.RunID, key groupKey) {
	delete(e.keys, runID)
	next, queued := e.concurrency.Release(key, runID)
	if !queued {
		return
	}
	start := e.startQueued
	if start == nil {
		start = func(pt pendingTrigger) { e.do(func() { e.startTrigger(pt, key) }) }
	}
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		start(next)
	}()
}

// tick polls every inflight stage, then feeds Tick so the reducer can time out
// anything past its deadline. Polling runs first, so a stage that settled on
// its own is finalized normally rather than timed out.
func (e *Engine) tick() {
	e.pollInflight()
	for _, runID := range e.runIDs() {
		e.dispatch(runID, pipeline.Tick{Now: e.now()})
	}
}

// pollInflight polls each running stage once and turns the observation into the
// event the reducer expects. Keys are snapshotted and sorted first: a settling
// stage can start or cancel siblings, and the walk has to be deterministic.
func (e *Engine) pollInflight() {
	keys := make([]stageKey, 0, len(e.inflight))
	for key := range e.inflight {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].RunID != keys[j].RunID {
			return keys[i].RunID < keys[j].RunID
		}
		return keys[i].Stage < keys[j].Stage
	})

	for _, key := range keys {
		handle, ok := e.inflight[key]
		if !ok {
			// Removed by an earlier iteration's cascade; nothing to poll.
			continue
		}
		out, err := e.execs.Poll(e.baseCtx, handle)
		if err != nil {
			// A handle that cannot be polled will never settle on its own, so
			// the stage fails with the reason rather than burning its deadline.
			delete(e.inflight, key)
			e.dispatch(key.RunID, pipeline.StageLaunchFailed{
				Stage:  key.Stage,
				Reason: fmt.Sprintf("stage poll failed: %v", err),
				Now:    e.now(),
			})
			continue
		}
		if out.State == executors.PollRunning {
			continue
		}
		e.recordOutputTail(key, handle)
		// The handle is dropped by pruneInflight, and only once the stage has
		// actually settled: a nudged stage keeps running against the same
		// session, and it still has to be polled for the answer.
		if ev := e.pollEvent(key, out); ev != nil {
			e.dispatch(key.RunID, ev)
		}
	}
}

// pollEvent maps one terminal observation onto the reducer's vocabulary. The
// artifact check happens here because the driver is what stats the file: the
// reducer only ever reads the answer (spec section 6.2).
func (e *Engine) pollEvent(key stageKey, out executors.Poll) pipeline.Event {
	now := e.now()
	run, ok := e.runs[key.RunID]
	if !ok {
		return nil
	}
	artifactOK := (pipeline.RunFolder{Dir: run.RunDir}).VerifyArtifact(run.Def.StageByID(key.Stage))

	switch out.State {
	case executors.PollSignaledDone:
		return pipeline.AgentSignaled{Stage: key.Stage, Done: true, ArtifactOK: artifactOK, Now: now}
	case executors.PollSignaledFail:
		return pipeline.AgentSignaled{Stage: key.Stage, Done: false, Reason: out.Reason, Now: now}
	case executors.PollExited:
		return pipeline.CommandExited{Stage: key.Stage, ExitCode: out.ExitCode, Now: now}
	case executors.PollIdle:
		return pipeline.SessionIdle{Stage: key.Stage, ArtifactOK: artifactOK, Now: now}
	case executors.PollGone:
		return pipeline.SessionGone{Stage: key.Stage, Now: now}
	default:
		return nil
	}
}

// recordOutputTail copies the executor's capped output onto the stage before it
// settles, so run detail can show why a command failed without opening the log
// file. The full stream is always on disk.
//
// The reducer has no event carrying output, so the driver writes it: the engine
// owns the run map, and the write is copy-on-write like every other, so the
// state the reducer is handed next is still a value nobody else holds.
func (e *Engine) recordOutputTail(key stageKey, handle executors.Handle) {
	tailer, ok := handle.(executors.OutputTailer)
	if !ok {
		return
	}
	text, _ := tailer.OutputTail()
	if text == "" {
		return
	}
	run, ok := e.runs[key.RunID]
	if !ok {
		return
	}
	st, ok := run.Stages[key.Stage]
	if !ok || st == nil {
		return
	}
	updated := *st
	updated.OutputTail = text
	stages := make(map[string]*pipeline.StageState, len(run.Stages))
	for id, s := range run.Stages {
		stages[id] = s
	}
	stages[key.Stage] = &updated
	run.Stages = stages
	e.runs[key.RunID] = run
}

// reconcileLostStages settles every stage a previous process left in flight
// (decision D16). An agent stage settles no_signal and a command stage failed,
// then both route their failure edge normally: a daemon restart cannot resume a
// Poll loop, and an honest settle beats a stuck board.
func (e *Engine) reconcileLostStages() {
	for _, runID := range e.runIDs() {
		run := e.runs[runID]
		if runSettled(run.Status) {
			continue
		}
		for i := range run.Def.Stages {
			stageID := run.Def.Stages[i].ID
			st := e.runs[runID].Stages[stageID]
			if st == nil || st.Outcome.IsSettled() {
				continue
			}
			// Pending with an attempt recorded is a launch that was committed
			// and never reported: the same lost-handle case.
			if st.Outcome != pipeline.OutcomeRunning && st.Attempt == 0 {
				continue
			}
			if _, live := e.inflight[stageKey{RunID: runID, Stage: stageID}]; live {
				continue
			}
			e.dispatch(runID, e.lostStageEvent(run.Def.StageByID(stageID), stageID, st))
		}
	}
}

// lostStageEvent is the honest settlement for a stage whose handle died with
// the previous process. A command stage's process group is reaped before it
// settles, because settling a stage while its work keeps running is the one
// outcome worse than either: the reap's finding goes into the reason so the
// stage says what actually happened to its process.
func (e *Engine) lostStageEvent(def *pipeline.Stage, stageID string, st *pipeline.StageState) pipeline.Event {
	now := e.now()
	if def != nil && def.Executor == pipeline.ExecutorAgent {
		// no_signal: the session may well still be alive, but nothing in this
		// process is listening to it any more. Agent stages are not reaped
		// here; session teardown owns them.
		return pipeline.SessionGone{Stage: stageID, Now: now}
	}
	reason := "the pipeline engine restarted while this stage was running; its process handle is lost"
	if clause, leaked := e.procGroups.Reap(st.PGID, st.StartedAt); clause != "" {
		reason += "; " + clause
		if leaked {
			e.log.Error("pipeline stage process group left running", "stage", stageID, "pgid", st.PGID, "detail", clause)
		}
	}
	return pipeline.StageLaunchFailed{Stage: stageID, Reason: reason, Now: now}
}

// pruneInflight drops handles for stages that have settled, so a later poll
// never touches a stage the reducer already closed.
func (e *Engine) pruneInflight(runID pipeline.RunID) {
	run, ok := e.runs[runID]
	if !ok {
		return
	}
	for key := range e.inflight {
		if key.RunID != runID {
			continue
		}
		if st := run.Stages[key.Stage]; st == nil || st.Outcome.IsSettled() {
			delete(e.inflight, key)
		}
	}
}

// runIDs lists the engine's runs in a stable order, so every walk over them is
// deterministic.
func (e *Engine) runIDs() []pipeline.RunID {
	ids := make([]pipeline.RunID, 0, len(e.runs))
	for id := range e.runs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// runSettled reports whether a run reached a terminal status. The pipeline
// package keeps its own copy of this unexported, and the driver needs it to
// tell a live run from a closed one.
func runSettled(status pipeline.RunStatus) bool {
	return status == pipeline.RunSucceeded || status == pipeline.RunFailed || status == pipeline.RunCancelled
}

// appendUnique adds path once, keeping the teardown list free of the duplicates
// a memoized `workspace: run` tree would otherwise produce.
func appendUnique(paths []string, path string) []string {
	for _, existing := range paths {
		if existing == path {
			return paths
		}
	}
	return append(paths, path)
}
