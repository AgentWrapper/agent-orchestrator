package review

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
)

// Delivery is what "auto-inject" means: handing a completed review's findings to
// the worker agent. It has always been unconditional, so the session flag is an
// opt-out and its absence must keep the old behaviour.
func TestSubmitDeliveryHonoursTheSessionAutoInjectSetting(t *testing.T) {
	for _, tc := range []struct {
		name         string
		off          bool
		wantDelivery bool
	}{
		{name: "delivers by default", off: false, wantDelivery: true},
		{name: "withholds when the project opted out", off: true, wantDelivery: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := &fakeStore{
				ok:      true,
				run:     domain.ReviewRun{ID: "run-1", SessionID: "w-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
				prs:     []domain.PullRequest{{URL: "pr1", HeadSHA: "sha1"}},
				session: domain.SessionRecord{ReviewAutoInjectOff: tc.off},
			}
			red := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
			svc := New(nil, st, WithLifecycleReducer(red), WithClock(func() time.Time { return time.Unix(10, 0).UTC() }))

			runs, err := svc.SubmitMany(context.Background(), "w-1", []SubmittedReview{{
				RunID:   "run-1",
				Verdict: domain.VerdictChangesRequested,
				Body:    "please fix the leak",
			}})
			if err != nil {
				t.Fatalf("SubmitMany: %v", err)
			}
			if len(runs) != 1 {
				t.Fatalf("runs = %d, want 1", len(runs))
			}
			gotDelivery := red.calls > 0 || red.batchCalls > 0
			if gotDelivery != tc.wantDelivery {
				t.Fatalf("lifecycle delivery = %v, want %v", gotDelivery, tc.wantDelivery)
			}
			// The run is recorded either way — only the nudge is withheld.
			if st.updateCalls == 0 {
				t.Fatal("want the review result persisted regardless of the setting")
			}
			if !tc.wantDelivery && len(st.markedIDs) != 0 {
				t.Fatalf("want the run left undelivered, marked %v", st.markedIDs)
			}
		})
	}
}
