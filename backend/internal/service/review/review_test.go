package review

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
)

type fakeStore struct {
	run domain.ReviewRun
	ok  bool

	updateCalls int
	markCalls   int
}

func (f *fakeStore) GetReviewRun(context.Context, string) (domain.ReviewRun, bool, error) {
	return f.run, f.ok, nil
}

func (f *fakeStore) UpdateReviewRunResult(_ context.Context, _ string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string) (bool, error) {
	if f.run.Status != domain.ReviewRunRunning {
		return false, nil
	}
	f.updateCalls++
	f.run.Status = status
	f.run.Verdict = verdict
	f.run.Body = body
	f.run.GithubReviewID = githubReviewID
	return true, nil
}

func (f *fakeStore) MarkReviewRunDelivered(_ context.Context, _ string, deliveredAt time.Time) (bool, error) {
	f.markCalls++
	if f.run.Status != domain.ReviewRunComplete || f.run.DeliveredAt != nil {
		return false, nil
	}
	f.run.Status = domain.ReviewRunDelivered
	f.run.DeliveredAt = &deliveredAt
	return true, nil
}

type fakeReducer struct {
	outcome lifecycle.ReviewDeliveryOutcome
	err     error
	calls   int
	got     lifecycle.ReviewResult
}

func (f *fakeReducer) ApplyReviewResult(_ context.Context, _ domain.SessionID, result lifecycle.ReviewResult) (lifecycle.ReviewDeliveryOutcome, error) {
	f.calls++
	f.got = result
	return f.outcome, f.err
}

func TestSubmitPersistsThenAppliesThenStampsDelivered(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithClock(func() time.Time { return now }))

	run, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix it", "987")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if st.updateCalls != 1 || reducer.calls != 1 || st.markCalls != 1 {
		t.Fatalf("calls update/reducer/mark = %d/%d/%d", st.updateCalls, reducer.calls, st.markCalls)
	}
	if reducer.got.Verdict != domain.VerdictChangesRequested || reducer.got.Body != "fix it" || reducer.got.GithubReviewID != "987" {
		t.Fatalf("reducer saw wrong result: %+v", reducer.got)
	}
	if run.Status != domain.ReviewRunDelivered || run.DeliveredAt == nil || !run.DeliveredAt.Equal(now) {
		t.Fatalf("run not stamped delivered: %+v", run)
	}
}

func TestSubmitDeliveryFailureLeavesCompletedUndeliveredForRetry(t *testing.T) {
	sendErr := errors.New("dead pane")
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	reducer := &fakeReducer{err: sendErr}
	svc := New(nil, st, WithLifecycleReducer(reducer))

	if _, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix it", "987"); !errors.Is(err, sendErr) {
		t.Fatalf("err = %v, want sendErr", err)
	}
	if st.run.Status != domain.ReviewRunComplete || st.run.DeliveredAt != nil || st.markCalls != 0 {
		t.Fatalf("failed delivery should leave completed/undelivered without stamp: %+v markCalls=%d", st.run, st.markCalls)
	}

	reducer.err = nil
	reducer.outcome = lifecycle.ReviewDeliverySent
	if _, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix it", "987"); err != nil {
		t.Fatalf("retry Submit: %v", err)
	}
	if st.updateCalls != 1 || reducer.calls != 2 || st.run.Status != domain.ReviewRunDelivered || st.run.DeliveredAt == nil {
		t.Fatalf("retry should not rewrite result and should stamp delivery: update=%d reducer=%d run=%+v", st.updateCalls, reducer.calls, st.run)
	}
}

func TestSubmitCompletedRetryRejectsDifferentRecordedFields(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		githubReviewID string
	}{
		{name: "different body", body: "different", githubReviewID: "987"},
		{name: "different review id", body: "fix it", githubReviewID: "654"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := &fakeStore{ok: true, run: domain.ReviewRun{
				ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1",
				Status: domain.ReviewRunComplete, Verdict: domain.VerdictChangesRequested,
				Body: "fix it", GithubReviewID: "987",
			}}
			reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
			svc := New(nil, st, WithLifecycleReducer(reducer))

			if _, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, tt.body, tt.githubReviewID); !errors.Is(err, ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
			if st.updateCalls != 0 || st.markCalls != 0 || reducer.calls != 0 {
				t.Fatalf("mismatched retry should not rewrite or deliver: update=%d mark=%d reducer=%d", st.updateCalls, st.markCalls, reducer.calls)
			}
		})
	}
}

func TestSubmitRejectsFailedRun(t *testing.T) {
	st := &fakeStore{ok: true, run: domain.ReviewRun{
		ID: "run-1", SessionID: "mer-1", Status: domain.ReviewRunFailed,
	}}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	svc := New(nil, st, WithLifecycleReducer(reducer))

	if _, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictApproved, "", "987"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if st.updateCalls != 0 || st.markCalls != 0 || reducer.calls != 0 {
		t.Fatalf("failed run should not update or deliver: update=%d mark=%d reducer=%d", st.updateCalls, st.markCalls, reducer.calls)
	}
}
