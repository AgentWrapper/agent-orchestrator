package review

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeStore struct {
	run       domain.ReviewRun
	ok        bool
	batchRuns []domain.ReviewRun
	prs       []domain.PullRequest

	updateCalls int
	markCalls   int
	markedIDs   []string
}

func (f *fakeStore) GetReviewRun(_ context.Context, id string) (domain.ReviewRun, bool, error) {
	for _, run := range f.batchRuns {
		if run.ID == id {
			return run, true, nil
		}
	}
	if f.ok && f.run.ID == id {
		return f.run, true, nil
	}
	return domain.ReviewRun{}, false, nil
}

func (f *fakeStore) UpdateReviewRunResult(_ context.Context, id string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string) (bool, error) {
	for i := range f.batchRuns {
		if f.batchRuns[i].ID == id {
			if f.batchRuns[i].Status != domain.ReviewRunRunning {
				return false, nil
			}
			f.updateCalls++
			f.batchRuns[i].Status = status
			f.batchRuns[i].Verdict = verdict
			f.batchRuns[i].Body = body
			f.batchRuns[i].GithubReviewID = githubReviewID
			if f.run.ID == id {
				f.run = f.batchRuns[i]
			}
			return true, nil
		}
	}
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

func (f *fakeStore) MarkReviewRunDelivered(_ context.Context, id string, deliveredAt time.Time) (bool, error) {
	f.markCalls++
	f.markedIDs = append(f.markedIDs, id)
	if f.run.ID == id && f.run.Status == domain.ReviewRunComplete && f.run.DeliveredAt == nil {
		f.run.Status = domain.ReviewRunDelivered
		f.run.DeliveredAt = &deliveredAt
	}
	for i := range f.batchRuns {
		if f.batchRuns[i].ID == id && f.batchRuns[i].Status == domain.ReviewRunComplete && f.batchRuns[i].DeliveredAt == nil {
			f.batchRuns[i].Status = domain.ReviewRunDelivered
			f.batchRuns[i].DeliveredAt = &deliveredAt
			return true, nil
		}
	}
	if f.run.ID != id || f.run.Status != domain.ReviewRunDelivered {
		return false, nil
	}
	return true, nil
}

func (f *fakeStore) ListReviewRunsByBatch(context.Context, domain.SessionID, string) ([]domain.ReviewRun, error) {
	out := append([]domain.ReviewRun(nil), f.batchRuns...)
	return out, nil
}

func (f *fakeStore) ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error) {
	out := append([]domain.PullRequest(nil), f.prs...)
	return out, nil
}

type fakeReducer struct {
	outcome    lifecycle.ReviewDeliveryOutcome
	err        error
	calls      int
	batchCalls int
	got        lifecycle.ReviewResult
	gotBatchID string
	gotBatch   []lifecycle.ReviewResult
}

type fakePublisher struct {
	result       ports.ReviewPublicationResult
	err          error
	refs         []ports.SCMPRRef
	publications []ports.ReviewPublication
}

func (f *fakePublisher) PublishReview(_ context.Context, ref ports.SCMPRRef, publication ports.ReviewPublication) (ports.ReviewPublicationResult, error) {
	f.refs = append(f.refs, ref)
	f.publications = append(f.publications, publication)
	return f.result, f.err
}

type fakePublisherResolver struct {
	publisher ports.SCMReviewPublisher
	err       error
	workers   []domain.SessionID
}

func (f *fakePublisherResolver) ResolveReviewPublisher(_ context.Context, workerID domain.SessionID) (ports.SCMReviewPublisher, error) {
	f.workers = append(f.workers, workerID)
	return f.publisher, f.err
}

func (f *fakeReducer) ApplyReviewResult(_ context.Context, _ domain.SessionID, result lifecycle.ReviewResult) (lifecycle.ReviewDeliveryOutcome, error) {
	f.calls++
	f.got = result
	return f.outcome, f.err
}

func (f *fakeReducer) ApplyReviewBatch(_ context.Context, _ domain.SessionID, batchID string, results []lifecycle.ReviewResult) (lifecycle.ReviewDeliveryOutcome, error) {
	f.batchCalls++
	f.gotBatchID = batchID
	f.gotBatch = append([]lifecycle.ReviewResult(nil), results...)
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

func TestSubmitBatchRunDoesNotWaitForOtherRunningRuns(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeStore{
		ok:  true,
		run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
		batchRuns: []domain.ReviewRun{
			{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
			{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunRunning},
		},
		prs: []domain.PullRequest{{URL: "pr1", HeadSHA: "sha1"}, {URL: "pr2", HeadSHA: "sha2"}},
	}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithClock(func() time.Time { return now }))

	run, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix pr1", "101")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if run.Status != domain.ReviewRunDelivered || run.DeliveredAt == nil || !run.DeliveredAt.Equal(now) {
		t.Fatalf("first submit status = %+v, want delivered", run)
	}
	if reducer.batchCalls != 1 || len(reducer.gotBatch) != 1 || reducer.gotBatch[0].RunID != "run-1" || st.markCalls != 1 {
		t.Fatalf("submitted run should deliver independently: batchCalls=%d got=%+v markCalls=%d", reducer.batchCalls, reducer.gotBatch, st.markCalls)
	}
}

func TestSubmitManySendsCombinedChangesRequested(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeStore{
		ok: true,
		batchRuns: []domain.ReviewRun{
			{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
			{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunRunning},
			{ID: "run-3", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr3", TargetSHA: "sha3", Status: domain.ReviewRunComplete, Verdict: domain.VerdictApproved},
			{ID: "run-4", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr4", TargetSHA: "old", Status: domain.ReviewRunComplete, Verdict: domain.VerdictChangesRequested, Body: "stale"},
			{ID: "run-5", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr5", TargetSHA: "sha5", Status: domain.ReviewRunFailed},
		},
		prs: []domain.PullRequest{
			{URL: "pr1", HeadSHA: "sha1"},
			{URL: "pr2", HeadSHA: "sha2"},
			{URL: "pr3", HeadSHA: "sha3"},
			{URL: "pr4", HeadSHA: "new"},
			{URL: "pr5", HeadSHA: "sha5"},
		},
	}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithClock(func() time.Time { return now }))

	runs, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{
		{RunID: "run-1", Verdict: domain.VerdictChangesRequested, Body: "fix pr1", GithubReviewID: "101"},
		{RunID: "run-2", Verdict: domain.VerdictChangesRequested, Body: "fix pr2", GithubReviewID: "102"},
		{RunID: "run-3", Verdict: domain.VerdictApproved},
	})
	if err != nil {
		t.Fatalf("SubmitMany: %v", err)
	}
	if reducer.batchCalls != 1 || reducer.gotBatchID != "batch-1" {
		t.Fatalf("batch delivery calls/id = %d/%q", reducer.batchCalls, reducer.gotBatchID)
	}
	if len(reducer.gotBatch) != 2 || reducer.gotBatch[0].RunID != "run-1" || reducer.gotBatch[1].RunID != "run-2" {
		t.Fatalf("delivered batch = %+v, want run-1 and run-2 only", reducer.gotBatch)
	}
	if st.markCalls != 2 {
		t.Fatalf("markCalls = %d, want 2", st.markCalls)
	}
	if runs[0].Status != domain.ReviewRunDelivered || runs[0].DeliveredAt == nil || !runs[0].DeliveredAt.Equal(now) ||
		runs[1].Status != domain.ReviewRunDelivered || runs[1].DeliveredAt == nil || !runs[1].DeliveredAt.Equal(now) {
		t.Fatalf("submitted runs not stamped delivered: %+v", runs)
	}
}

func TestSubmitBatchApprovedOnlySendsNothing(t *testing.T) {
	st := &fakeStore{
		ok:  true,
		run: domain.ReviewRun{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunRunning},
		batchRuns: []domain.ReviewRun{
			{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunComplete, Verdict: domain.VerdictApproved},
			{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunRunning},
		},
		prs: []domain.PullRequest{{URL: "pr1", HeadSHA: "sha1"}, {URL: "pr2", HeadSHA: "sha2"}},
	}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	svc := New(nil, st, WithLifecycleReducer(reducer))

	if _, err := svc.Submit(context.Background(), "mer-1", "run-2", domain.VerdictApproved, "", "102"); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if reducer.batchCalls != 0 || st.markCalls != 0 {
		t.Fatalf("approved-only batch should not deliver: batchCalls=%d markCalls=%d", reducer.batchCalls, st.markCalls)
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

func TestPublishManyPublishesThenRecordsProviderReference(t *testing.T) {
	st := &fakeStore{
		ok: true,
		run: domain.ReviewRun{
			ID: "run-1", SessionID: "mer-1", PRURL: "https://gitlab.example.com/group/subgroup/repo/-/merge_requests/7",
			TargetSHA: "head-7", Status: domain.ReviewRunRunning,
		},
		prs: []domain.PullRequest{{
			URL: "https://gitlab.example.com/group/subgroup/repo/-/merge_requests/7", Number: 7,
			Provider: "gitlab", Host: "gitlab.example.com", Repo: "group/subgroup/repo", HeadSHA: "head-7",
		}},
	}
	publisher := &fakePublisher{result: ports.ReviewPublicationResult{Reference: "discussion-42"}}
	resolver := &fakePublisherResolver{publisher: publisher}
	svc := New(nil, st, WithPublisherResolver(resolver))

	runs, err := svc.PublishMany(context.Background(), "mer-1", []PublishReview{{
		RunID: "run-1", Verdict: domain.VerdictChangesRequested, Body: "fix auth",
		Findings: []ports.ReviewFinding{{Path: "auth.go", Line: 42, Body: "nil dereference"}},
	}})
	if err != nil {
		t.Fatalf("PublishMany: %v", err)
	}
	if len(resolver.workers) != 1 || resolver.workers[0] != "mer-1" {
		t.Fatalf("resolved workers = %v", resolver.workers)
	}
	if len(publisher.refs) != 1 {
		t.Fatalf("publish calls = %d, want 1", len(publisher.refs))
	}
	ref := publisher.refs[0]
	if ref.Repo.Provider != "gitlab" || ref.Repo.Host != "gitlab.example.com" || ref.Repo.Owner != "group/subgroup" || ref.Repo.Name != "repo" || ref.Repo.Repo != "group/subgroup/repo" || ref.Number != 7 || ref.URL != st.run.PRURL {
		t.Fatalf("publish ref = %+v", ref)
	}
	publication := publisher.publications[0]
	if publication.IdempotencyKey != "run-1" || publication.TargetSHA != "head-7" || publication.Verdict != "changes_requested" || publication.Body != "fix auth" || len(publication.Findings) != 1 || publication.Findings[0].Path != "auth.go" {
		t.Fatalf("publication = %+v", publication)
	}
	if len(runs) != 1 || runs[0].Status != domain.ReviewRunComplete || runs[0].GithubReviewID != "discussion-42" || st.updateCalls != 1 {
		t.Fatalf("runs/store = %+v updateCalls=%d", runs, st.updateCalls)
	}
}

func TestPublishManyProviderFailureLeavesRunRunning(t *testing.T) {
	publishErr := errors.New("provider unavailable")
	st := &fakeStore{
		ok:  true,
		run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
		prs: []domain.PullRequest{{URL: "pr1", Number: 1, Provider: "github", Host: "github.com", Repo: "o/r", HeadSHA: "sha1"}},
	}
	publisher := &fakePublisher{err: publishErr}
	svc := New(nil, st, WithPublisherResolver(&fakePublisherResolver{publisher: publisher}))

	_, err := svc.PublishMany(context.Background(), "mer-1", []PublishReview{{RunID: "run-1", Verdict: domain.VerdictApproved, Body: "ready"}})
	if !errors.Is(err, publishErr) {
		t.Fatalf("err = %v, want publishErr", err)
	}
	if st.run.Status != domain.ReviewRunRunning || st.updateCalls != 0 {
		t.Fatalf("failed publication changed run: %+v updateCalls=%d", st.run, st.updateCalls)
	}
}

func TestPublishManyRejectsEmptyReviewBodyBeforeResolvingProvider(t *testing.T) {
	resolver := &fakePublisherResolver{publisher: &fakePublisher{}}
	svc := New(nil, &fakeStore{}, WithPublisherResolver(resolver))

	_, err := svc.PublishMany(context.Background(), "mer-1", []PublishReview{{
		RunID: "run-1", Verdict: domain.VerdictApproved, Body: "  ",
	}})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if len(resolver.workers) != 0 {
		t.Fatalf("provider resolved for invalid review: %v", resolver.workers)
	}
}

func TestPublishManyRetryDoesNotRepublishRecordedRun(t *testing.T) {
	st := &fakeStore{
		ok: true,
		run: domain.ReviewRun{
			ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunComplete,
			Verdict: domain.VerdictChangesRequested, Body: "fix it", GithubReviewID: "review-7",
		},
		prs: []domain.PullRequest{{URL: "pr1", Number: 1, Provider: "github", Host: "github.com", Repo: "o/r", HeadSHA: "sha1"}},
	}
	publisher := &fakePublisher{}
	svc := New(nil, st, WithPublisherResolver(&fakePublisherResolver{publisher: publisher}))

	runs, err := svc.PublishMany(context.Background(), "mer-1", []PublishReview{{RunID: "run-1", Verdict: domain.VerdictChangesRequested, Body: "fix it"}})
	if err != nil {
		t.Fatalf("PublishMany retry: %v", err)
	}
	if len(publisher.refs) != 0 || st.updateCalls != 0 || len(runs) != 1 || runs[0].GithubReviewID != "review-7" {
		t.Fatalf("retry republished or rewrote: calls=%d update=%d runs=%+v", len(publisher.refs), st.updateCalls, runs)
	}
}

func TestPublishManyValidatesWholeBatchBeforePublishing(t *testing.T) {
	st := &fakeStore{
		batchRuns: []domain.ReviewRun{
			{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
			{ID: "run-2", SessionID: "mer-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunComplete, Verdict: domain.VerdictApproved, Body: "recorded"},
		},
		prs: []domain.PullRequest{
			{URL: "pr1", Number: 1, Provider: "github", Host: "github.com", Repo: "o/r", HeadSHA: "sha1"},
			{URL: "pr2", Number: 2, Provider: "github", Host: "github.com", Repo: "o/r", HeadSHA: "sha2"},
		},
	}
	publisher := &fakePublisher{}
	svc := New(nil, st, WithPublisherResolver(&fakePublisherResolver{publisher: publisher}))

	_, err := svc.PublishMany(context.Background(), "mer-1", []PublishReview{
		{RunID: "run-1", Verdict: domain.VerdictApproved, Body: "ready"},
		{RunID: "run-2", Verdict: domain.VerdictChangesRequested, Body: "different"},
	})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if len(publisher.refs) != 0 || st.updateCalls != 0 {
		t.Fatalf("invalid batch published or recorded: calls=%d update=%d", len(publisher.refs), st.updateCalls)
	}
}
