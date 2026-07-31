package pipeline

// Outcome is the settled (or in-flight) state of a single stage run. The
// taxonomy is spec section 7: eight settled outcomes plus the two in-flight
// ones. It is deliberately wider than a success/failure boolean because the
// session disposition rules (kill-on) and the run board both need to tell
// "the agent said it failed" apart from "the agent never said anything".
type Outcome string

// Every stage outcome. pending and running are in-flight; the rest are
// settled.
const (
	// OutcomePending means the stage is reachable and seeded but not started.
	OutcomePending Outcome = "pending"
	// OutcomeRunning means the executor has been launched and has not settled.
	OutcomeRunning Outcome = "running"
	// OutcomeSucceeded means signalled done (or exit 0) with the declared
	// artifact present and non-empty.
	OutcomeSucceeded Outcome = "succeeded"
	// OutcomeSucceededUnverified means signalled done with no produces
	// declared, so there was nothing for the engine to verify.
	OutcomeSucceededUnverified Outcome = "succeeded_unverified"
	// OutcomeFailed means an explicit `ao pipeline fail`, or a non-zero exit.
	OutcomeFailed Outcome = "failed"
	// OutcomeNoOutput means signalled done, but the declared artifact is
	// missing or empty.
	OutcomeNoOutput Outcome = "no_output"
	// OutcomeNoSignal means the session exited or went idle without
	// signalling.
	OutcomeNoSignal Outcome = "no_signal"
	// OutcomeTimedOut means the stage deadline was hit.
	OutcomeTimedOut Outcome = "timed_out"
	// OutcomeCancelled means the run was torn down (superseded by concurrency,
	// or killed).
	OutcomeCancelled Outcome = "cancelled"
	// OutcomeSkipped means a predecessor did not succeed. Skipped is not
	// failed, and it cascades.
	OutcomeSkipped Outcome = "skipped"
)

// AllOutcomes lists every outcome, in taxonomy order. Validation of
// `session.kill-on` and the schema enum-coverage test are both driven off this
// table, so adding an outcome is a one-line change here plus the schema.
var AllOutcomes = []Outcome{
	OutcomePending,
	OutcomeRunning,
	OutcomeSucceeded,
	OutcomeSucceededUnverified,
	OutcomeFailed,
	OutcomeNoOutput,
	OutcomeNoSignal,
	OutcomeTimedOut,
	OutcomeCancelled,
	OutcomeSkipped,
}

// IsKnown reports whether o is one of the defined outcomes.
func (o Outcome) IsKnown() bool {
	for _, k := range AllOutcomes {
		if o == k {
			return true
		}
	}
	return false
}

// IsSettled reports whether the stage has reached a terminal outcome, i.e.
// anything other than pending or running.
func (o Outcome) IsSettled() bool {
	return o != OutcomePending && o != OutcomeRunning
}

// IsSuccess reports whether the outcome counts as a success for the purposes
// of taking an on_success edge. `succeeded (unverified)` counts: the stage
// declared no artifact contract, so the signal was the whole contract.
func (o Outcome) IsSuccess() bool {
	return o == OutcomeSucceeded || o == OutcomeSucceededUnverified
}

// RoutesToFailure reports whether the outcome takes the stage's on_failure
// edge. Notably cancelled and skipped do not: a cancelled run is being torn
// down rather than routed (spec section 13.2), and a skipped stage cascades
// its skip instead.
func (o Outcome) RoutesToFailure() bool {
	switch o {
	case OutcomeFailed, OutcomeNoOutput, OutcomeNoSignal, OutcomeTimedOut:
		return true
	default:
		return false
	}
}

// RunStatus is the run-level rollup shown as a column on the Kanban board.
// The mapping from the eight stage outcomes is owned by the reducer: cancelled
// if the run was cancelled, else failed if any stage settled in
// {failed, no_output, no_signal, timed_out}, else succeeded.
type RunStatus string

// Every run status.
const (
	RunPending   RunStatus = "pending"
	RunRunning   RunStatus = "running"
	RunSucceeded RunStatus = "succeeded"
	RunFailed    RunStatus = "failed"
	RunCancelled RunStatus = "cancelled"
)

// AllRunStatuses lists every run status, in board-column order.
var AllRunStatuses = []RunStatus{RunPending, RunRunning, RunSucceeded, RunFailed, RunCancelled}

// IsKnown reports whether s is one of the defined run statuses.
func (s RunStatus) IsKnown() bool {
	for _, k := range AllRunStatuses {
		if s == k {
			return true
		}
	}
	return false
}
