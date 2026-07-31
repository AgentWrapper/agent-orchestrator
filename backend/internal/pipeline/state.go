package pipeline

import "time"

// EntryEdge records how a stage was entered, which decides its workspace
// default and which ambient failure variables resolve.
type EntryEdge string

// Every entry edge.
const (
	// EntryTrigger is the entry stage, started by the trigger itself.
	EntryTrigger EntryEdge = "trigger"
	// EntrySuccess means a predecessor's on_success routed here.
	EntrySuccess EntryEdge = "success"
	// EntryFailure means a predecessor's on_failure (or defaults.on_failure)
	// routed here.
	EntryFailure EntryEdge = "failure"
)

// StageState is one stage's slice of a run. It is a value carried in RunState
// and rewritten copy-on-write by the reducer, never mutated in place.
type StageState struct {
	ID      string  `json:"id"`
	Outcome Outcome `json:"outcome"`
	// Attempt is 0 until the stage starts, 1 normally, and 2 after a nudge.
	// It surfaces to the stage as AO_ATTEMPT so a prompt can branch on being
	// nudged.
	Attempt    int       `json:"attempt"`
	EnteredVia EntryEdge `json:"enteredVia"`
	// PrevStage is the sole success predecessor, and is empty at a join or at
	// the entry stage. AO_PREV_* is unset where this is empty, because at a
	// join it would be ambiguous (spec section 12.2).
	PrevStage string `json:"prevStage,omitempty"`
	// FailedStage and FailedOutcome are set when EnteredVia is EntryFailure,
	// and surface as AO_FAILED_STAGE / AO_FAILED_OUTCOME.
	FailedStage   string  `json:"failedStage,omitempty"`
	FailedOutcome Outcome `json:"failedOutcome,omitempty"`

	SessionID string `json:"sessionId,omitempty"`
	// PGID is the OS process group a command stage was launched in, 0 for an
	// agent stage and on a platform that gives a command none. It is persisted
	// because a daemon restart drops the handle that could stop the work:
	// without the group id, reconciliation settles the stage and leaves its
	// process running. Read together with StartedAt, which the same event
	// stamps: the pair is what makes a reap safe against pid reuse.
	PGID int `json:"pgid,omitempty"`
	// WorkspaceKind is the resolved tree kind, never "auto", "inherit" or
	// unset: those are plan-time symbols, resolved to a concrete kind by the
	// time the stage launches.
	WorkspaceKind WorkspaceKind `json:"workspaceKind,omitempty"`
	WorkspacePath string        `json:"workspacePath,omitempty"`

	DeadlineAt time.Time `json:"deadlineAt,omitempty"`
	StartedAt  time.Time `json:"startedAt,omitempty"`
	SettledAt  time.Time `json:"settledAt,omitempty"`

	// Reason carries the fail reason, cancel reason, or plan-failure reason.
	Reason string `json:"reason,omitempty"`
	// OutputTail is the capped tail of the stage's captured stdout+stderr,
	// kept so run detail can show why a command failed without fetching the
	// full log from the run folder. The executor caps it; the store persists
	// whatever it is handed.
	OutputTail string `json:"outputTail,omitempty"`
}

// RunState is one run, in full. SQLite stays the store of record; run.json in
// the run folder is a projection of this for humans and debugging.
//
// Def is a frozen snapshot taken when the run was triggered: editing the
// definition mid-run never changes a run in flight.
type RunState struct {
	RunID      RunID  `json:"runId"`
	ProjectID  string `json:"projectId"`
	PipelineID ID     `json:"pipelineId"`
	// RunNumber is the per-pipeline counter humans refer to a run by,
	// GitHub Actions style: "inform #3 failed". The store allocates it in the
	// insert that creates the run and never reassigns it, so the reducer never
	// touches it and a run built in memory carries 0 until it is first saved.
	RunNumber    int       `json:"runNumber,omitempty"`
	PipelineName string    `json:"pipelineName"`
	Subject      Subject   `json:"subject"`
	Status       RunStatus `json:"status"`
	RunDir       string    `json:"runDir"`
	Def          Pipeline  `json:"definition"`

	Stages map[string]*StageState `json:"stages"`
	// Nudged records the one nudge each stage is allowed. Two attempts total,
	// not configurable: if a second nudge would help, the prompt is wrong.
	Nudged map[string]bool `json:"nudged,omitempty"`

	CancelReason string `json:"cancelReason,omitempty"`

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	SettledAt time.Time `json:"settledAt,omitempty"`
}
