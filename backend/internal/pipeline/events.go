package pipeline

import "time"

// Event and Effect are the input and output of the per-run reducer. Neither is
// ever parsed from YAML or JSON: they are constructed in-process by the engine
// driver.
//
// Both are sealed interfaces (an unexported marker method), so the union of
// concrete types is closed to this package and a type switch over it is
// exhaustive by construction.
//
// Every Event carries a driver-stamped Now and the reducer never reads the
// clock itself, which is what makes the whole transition core testable without
// a fake clock.
type Event interface {
	// When reports the driver-stamped time the event happened.
	When() time.Time
	// isEvent seals the interface to this package.
	isEvent()
}

// TriggerFired starts a run: a trigger resolved a subject and the driver has
// allocated the run id and created the run folder. Def is the frozen
// definition snapshot the run executes, so editing the definition mid-run
// cannot change a run in flight.
type TriggerFired struct {
	Def     Pipeline
	Subject Subject
	RunID   RunID
	RunDir  string
	// KnownCredentials names the credentials the project defines, stamped by
	// the driver the same way Now is, so the pure reducer can plan without
	// reaching for the credential store. Nil means the driver did not supply
	// them and the plan-time unknown-credential check is skipped.
	KnownCredentials []string
	Now              time.Time
}

// When implements Event.
func (e TriggerFired) When() time.Time { return e.Now }
func (TriggerFired) isEvent()          {}

// StageLaunched reports that the driver provisioned the stage's workspace and
// started its executor.
type StageLaunched struct {
	Stage     string
	SessionID string
	// PGID is the process group a command stage was started in, 0 when it has
	// none. It is carried on the same event as Now so the stage's recorded
	// start time always describes the process the group id names.
	PGID          int
	WorkspacePath string
	Now           time.Time
}

// When implements Event.
func (e StageLaunched) When() time.Time { return e.Now }
func (StageLaunched) isEvent()          {}

// StageLaunchFailed reports that the driver could not provision or start the
// stage at all, for instance because its workspace could not be created.
type StageLaunchFailed struct {
	Stage  string
	Reason string
	Now    time.Time
}

// When implements Event.
func (e StageLaunchFailed) When() time.Time { return e.Now }
func (StageLaunchFailed) isEvent()          {}

// AgentSignaled reports an `ao pipeline done|fail` from an agent stage.
//
// ArtifactOK is the driver's verification of the declared artifact: it stat'd
// $AO_OUTPUT and found it non-empty. It is true when the stage declares no
// produces, because then there is nothing to verify.
type AgentSignaled struct {
	Stage      string
	Done       bool
	Reason     string
	ArtifactOK bool
	Now        time.Time
}

// When implements Event.
func (e AgentSignaled) When() time.Time { return e.Now }
func (AgentSignaled) isEvent()          {}

// CommandExited reports that a command stage's process exited. The exit code
// is the whole outcome: a command stage has no artifact contract.
type CommandExited struct {
	Stage    string
	ExitCode int
	Now      time.Time
}

// When implements Event.
func (e CommandExited) When() time.Time { return e.Now }
func (CommandExited) isEvent()          {}

// SessionIdle reports that an agent stage's session went idle without
// signalling. This is the disambiguation the nudge exists for: "finished and
// forgot to call the CLI" versus "stuck waiting".
type SessionIdle struct {
	Stage      string
	ArtifactOK bool
	Now        time.Time
}

// When implements Event.
func (e SessionIdle) When() time.Time { return e.Now }
func (SessionIdle) isEvent()          {}

// SessionGone reports that an agent stage's session exited without
// signalling. There is nothing left to nudge.
type SessionGone struct {
	Stage string
	Now   time.Time
}

// When implements Event.
func (e SessionGone) When() time.Time { return e.Now }
func (SessionGone) isEvent()          {}

// NudgeDelivered reports that the driver delivered the stage's one nudge, so
// the stage is on its second and last attempt.
type NudgeDelivered struct {
	Stage string
	Now   time.Time
}

// When implements Event.
func (e NudgeDelivered) When() time.Time { return e.Now }
func (NudgeDelivered) isEvent()          {}

// Tick is the driver heartbeat, letting the reducer enforce deadlines without
// a state-changing input.
type Tick struct {
	Now time.Time
}

// When implements Event.
func (e Tick) When() time.Time { return e.Now }
func (Tick) isEvent()          {}

// CancelRequested tears the run down: superseded by concurrency, or killed by
// a human.
type CancelRequested struct {
	Reason string
	Now    time.Time
}

// When implements Event.
func (e CancelRequested) When() time.Time { return e.Now }
func (CancelRequested) isEvent()          {}

// Effect is a command the reducer hands back for the engine driver to execute
// after the reduction. The reducer decides; the driver touches the world.
type Effect interface {
	// isEffect seals the interface to this package.
	isEffect()
}

// StartStage instructs the driver to provision the stage's workspace and
// launch its executor. Workspaces are provisioned lazily, here, so a branch
// that never runs never pays for a checkout.
type StartStage struct {
	Stage   string
	Attempt int
}

func (StartStage) isEffect() {}

// NudgeStage instructs the driver to send the stage's one nudge message into
// its live session.
type NudgeStage struct {
	Stage     string
	SessionID string
	Message   string
}

func (NudgeStage) isEffect() {}

// InterruptStage instructs the driver to kill a timed-out stage's process
// while keeping its session: a timed-out agent may still be running, and the
// scrollback is the point.
type InterruptStage struct {
	Stage string
}

func (InterruptStage) isEffect() {}

// CancelStageExec instructs the driver to tear down a running stage as part of
// cancelling the run.
type CancelStageExec struct {
	Stage string
}

func (CancelStageExec) isEffect() {}

// SettleSession hands the driver an agent stage's settled outcome so it can
// apply the stage's kill-on rule: kill the session, or keep it and mark it
// pipeline-orphaned.
type SettleSession struct {
	Stage     string
	SessionID string
	Outcome   Outcome
}

func (SettleSession) isEffect() {}

// AppendContext instructs the driver to append one pointer line to the run's
// Context.md. Pointer lines, never content: Context.md is an index.
type AppendContext struct {
	Line string
}

func (AppendContext) isEffect() {}

// PersistRun instructs the driver to durably write the run state the reduction
// returned (SQLite is the store of record; run.json in the run folder is a
// projection of the same state).
type PersistRun struct{}

func (PersistRun) isEffect() {}

// RunSettled reports the run reached a terminal status, so the driver can tear
// down the workspaces the run owns (destroyed on success, kept on failure) and
// release its concurrency slot.
type RunSettled struct {
	Status RunStatus
}

func (RunSettled) isEffect() {}
