package pipeline

import "testing"

func TestOutcome_Predicates(t *testing.T) {
	tests := []struct {
		outcome         Outcome
		settled         bool
		success         bool
		routesToFailure bool
	}{
		{OutcomePending, false, false, false},
		{OutcomeRunning, false, false, false},
		{OutcomeSucceeded, true, true, false},
		{OutcomeSucceededUnverified, true, true, false},
		{OutcomeFailed, true, false, true},
		{OutcomeNoOutput, true, false, true},
		{OutcomeNoSignal, true, false, true},
		{OutcomeTimedOut, true, false, true},
		{OutcomeCancelled, true, false, false},
		{OutcomeSkipped, true, false, false},
	}
	if len(tests) != len(AllOutcomes) {
		t.Fatalf("table covers %d outcomes, AllOutcomes has %d", len(tests), len(AllOutcomes))
	}
	for _, tc := range tests {
		t.Run(string(tc.outcome), func(t *testing.T) {
			if !tc.outcome.IsKnown() {
				t.Error("IsKnown() = false, want true")
			}
			if got := tc.outcome.IsSettled(); got != tc.settled {
				t.Errorf("IsSettled() = %v, want %v", got, tc.settled)
			}
			if got := tc.outcome.IsSuccess(); got != tc.success {
				t.Errorf("IsSuccess() = %v, want %v", got, tc.success)
			}
			if got := tc.outcome.RoutesToFailure(); got != tc.routesToFailure {
				t.Errorf("RoutesToFailure() = %v, want %v", got, tc.routesToFailure)
			}
		})
	}
}

// A cancelled run is torn down, not routed, and a skipped stage cascades its
// skip. Neither takes a failure edge (spec section 13.2, section 9.2).
func TestOutcome_CancelledAndSkippedDoNotRoute(t *testing.T) {
	for _, o := range []Outcome{OutcomeCancelled, OutcomeSkipped} {
		if o.RoutesToFailure() {
			t.Errorf("%q routes to failure, want it not to", o)
		}
	}
}

func TestOutcome_UnknownIsNotKnown(t *testing.T) {
	if Outcome("exploded").IsKnown() {
		t.Error("IsKnown() = true for an undefined outcome")
	}
	if Outcome("exploded").IsSuccess() || Outcome("exploded").RoutesToFailure() {
		t.Error("an undefined outcome must not count as success or route to failure")
	}
}

func TestRunStatus_IsKnown(t *testing.T) {
	for _, s := range AllRunStatuses {
		if !s.IsKnown() {
			t.Errorf("%q IsKnown() = false", s)
		}
	}
	if RunStatus("stuck").IsKnown() {
		t.Error("IsKnown() = true for an undefined run status")
	}
}
