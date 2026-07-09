package pr

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ---- fakes ----

type fakePRStore struct {
	byURL    map[string]domain.PullRequest
	byNumber map[int]domain.PullRequest
	checks   map[string][]domain.PullRequestCheck
	comments map[string][]domain.PullRequestComment
	threads  map[string][]domain.PullRequestReviewThread
	reviews  map[string][]domain.PullRequestReview

	// written captures the last WritePR / WriteSCMObservation call.
	wrotePR       *domain.PullRequest
	wroteComments []domain.PullRequestComment
	wroteThreads  []domain.PullRequestReviewThread
	writeErr      error
	writeCalls    int
}

func newFakePRStore() *fakePRStore {
	return &fakePRStore{
		byURL:    map[string]domain.PullRequest{},
		byNumber: map[int]domain.PullRequest{},
		checks:   map[string][]domain.PullRequestCheck{},
		comments: map[string][]domain.PullRequestComment{},
		threads:  map[string][]domain.PullRequestReviewThread{},
		reviews:  map[string][]domain.PullRequestReview{},
	}
}

func (f *fakePRStore) put(pr domain.PullRequest) {
	f.byURL[pr.URL] = pr
	f.byNumber[pr.Number] = pr
}

func (f *fakePRStore) GetPR(_ context.Context, url string) (domain.PullRequest, bool, error) {
	pr, ok := f.byURL[url]
	return pr, ok, nil
}

func (f *fakePRStore) GetPRByNumber(_ context.Context, number int) (domain.PullRequest, bool, error) {
	pr, ok := f.byNumber[number]
	return pr, ok, nil
}

func (f *fakePRStore) ListChecks(_ context.Context, prURL string) ([]domain.PullRequestCheck, error) {
	return append([]domain.PullRequestCheck(nil), f.checks[prURL]...), nil
}

func (f *fakePRStore) ListPRComments(_ context.Context, prURL string) ([]domain.PullRequestComment, error) {
	return append([]domain.PullRequestComment(nil), f.comments[prURL]...), nil
}

func (f *fakePRStore) ListPRReviewThreads(_ context.Context, prURL string) ([]domain.PullRequestReviewThread, error) {
	return append([]domain.PullRequestReviewThread(nil), f.threads[prURL]...), nil
}

func (f *fakePRStore) ListPRReviews(_ context.Context, prURL string) ([]domain.PullRequestReview, error) {
	return append([]domain.PullRequestReview(nil), f.reviews[prURL]...), nil
}

func (f *fakePRStore) WritePR(_ context.Context, pr domain.PullRequest, _ []domain.PullRequestCheck, comments []domain.PullRequestComment) error {
	f.writeCalls++
	if f.writeErr != nil {
		return f.writeErr
	}
	cp := pr
	f.wrotePR = &cp
	f.wroteComments = append([]domain.PullRequestComment(nil), comments...)
	f.put(pr)
	f.comments[pr.URL] = append([]domain.PullRequestComment(nil), comments...)
	return nil
}

func (f *fakePRStore) WriteSCMObservation(_ context.Context, pr domain.PullRequest, _ []domain.PullRequestCheck, _ []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, _ ports.ReviewWriteMode) error {
	f.writeCalls++
	if f.writeErr != nil {
		return f.writeErr
	}
	cp := pr
	f.wrotePR = &cp
	f.wroteThreads = append([]domain.PullRequestReviewThread(nil), threads...)
	f.wroteComments = append([]domain.PullRequestComment(nil), comments...)
	f.put(pr)
	f.threads[pr.URL] = append([]domain.PullRequestReviewThread(nil), threads...)
	f.comments[pr.URL] = append([]domain.PullRequestComment(nil), comments...)
	return nil
}

type fakeSCMActioner struct {
	mergeResult  ports.PRMergeResult
	mergeErr     error
	mergeCalls   int
	lastMergeRef ports.SCMPRRef
	lastMethod   string

	unresolved    []string
	listErr       error
	listCalls     int
	resolveErr    error
	resolvedIDs   []string
	failOnResolve map[string]error
}

func (f *fakeSCMActioner) MergePR(_ context.Context, ref ports.SCMPRRef, method string) (ports.PRMergeResult, error) {
	f.mergeCalls++
	f.lastMergeRef = ref
	f.lastMethod = method
	if f.mergeErr != nil {
		return ports.PRMergeResult{}, f.mergeErr
	}
	return f.mergeResult, nil
}

func (f *fakeSCMActioner) ListUnresolvedThreadIDs(_ context.Context, _ ports.SCMPRRef) ([]string, error) {
	f.listCalls++
	if f.listErr != nil {
		return nil, f.listErr
	}
	return append([]string(nil), f.unresolved...), nil
}

func (f *fakeSCMActioner) ResolveThread(_ context.Context, threadID string) error {
	if err, ok := f.failOnResolve[threadID]; ok {
		return err
	}
	if f.resolveErr != nil {
		return f.resolveErr
	}
	f.resolvedIDs = append(f.resolvedIDs, threadID)
	return nil
}

type fakeActionLifecycle struct {
	observed []ports.PRObservation
	err      error
}

func (f *fakeActionLifecycle) ApplyPRObservation(_ context.Context, _ domain.SessionID, o ports.PRObservation) error {
	f.observed = append(f.observed, o)
	return f.err
}

func samplePR(n int) domain.PullRequest {
	return domain.PullRequest{
		URL:       fmt.Sprintf("https://github.com/acme/repo/pull/%d", n),
		HTMLURL:   fmt.Sprintf("https://github.com/acme/repo/pull/%d", n),
		SessionID: "sess-1",
		Number:    n,
		Repo:      "acme/repo",
		Provider:  "github",
		Host:      "github.com",
		CI:        domain.CIPassing,
		Review:    domain.ReviewApproved,
		UpdatedAt: time.Unix(1000, 0).UTC(),
	}
}

func newTestService(store *fakePRStore, scm *fakeSCMActioner, lc *fakeActionLifecycle) *ActionService {
	deps := ActionDeps{
		Store:  store,
		Writer: store,
		SCM:    scm,
		Clock:  func() time.Time { return time.Unix(2000, 0).UTC() },
	}
	// Assign only a non-nil pointer so ActionDeps.Lifecycle stays a true nil
	// interface (avoids the classic typed-nil interface trap).
	if lc != nil {
		deps.Lifecycle = lc
	}
	return NewActionServiceWithDeps(deps)
}

// ---- Merge ----

func TestMerge_Success_CallsRemoteAndPersists(t *testing.T) {
	store := newFakePRStore()
	store.put(samplePR(42))
	scm := &fakeSCMActioner{mergeResult: ports.PRMergeResult{Merged: true, SHA: "abc123", Method: "squash"}}
	lc := &fakeActionLifecycle{}
	svc := newTestService(store, scm, lc)

	res, err := svc.Merge(context.Background(), "42")
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if res.PRNumber != 42 || res.Method != "squash" {
		t.Fatalf("result = %+v, want {42 squash}", res)
	}
	if scm.mergeCalls != 1 {
		t.Fatalf("remote merge calls = %d, want 1", scm.mergeCalls)
	}
	if scm.lastMethod != "squash" {
		t.Fatalf("method = %q, want squash", scm.lastMethod)
	}
	if scm.lastMergeRef.Number != 42 || scm.lastMergeRef.Repo.Owner != "acme" {
		t.Fatalf("merge ref = %+v", scm.lastMergeRef)
	}
	if store.writeCalls != 1 || store.wrotePR == nil || !store.wrotePR.Merged {
		t.Fatalf("local write missing or not merged: calls=%d pr=%+v", store.writeCalls, store.wrotePR)
	}
	if store.wrotePR.MergeCommitSHA != "abc123" {
		t.Fatalf("merge sha = %q, want abc123", store.wrotePR.MergeCommitSHA)
	}
	if len(lc.observed) != 1 || !lc.observed[0].Merged {
		t.Fatalf("lifecycle obs = %+v, want one merged observation", lc.observed)
	}
}

func TestMerge_DoesNotPersistWhenRemoteSkippedOrFails(t *testing.T) {
	store := newFakePRStore()
	store.put(samplePR(7))
	scm := &fakeSCMActioner{mergeErr: ports.ErrSCMNotMergeable}
	svc := newTestService(store, scm, &fakeActionLifecycle{})

	_, err := svc.Merge(context.Background(), "7")
	if !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable", err)
	}
	if store.writeCalls != 0 {
		t.Fatalf("writeCalls = %d, want 0 (no local update on remote failure)", store.writeCalls)
	}
}

func TestMerge_NotFound(t *testing.T) {
	svc := newTestService(newFakePRStore(), &fakeSCMActioner{}, nil)
	_, err := svc.Merge(context.Background(), "99")
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestMerge_LookupByURL(t *testing.T) {
	store := newFakePRStore()
	pr := samplePR(3)
	store.put(pr)
	scm := &fakeSCMActioner{mergeResult: ports.PRMergeResult{Merged: true, SHA: "s", Method: "squash"}}
	svc := newTestService(store, scm, nil)

	res, err := svc.Merge(context.Background(), pr.URL)
	if err != nil {
		t.Fatalf("Merge by URL: %v", err)
	}
	if res.PRNumber != 3 {
		t.Fatalf("PRNumber = %d, want 3", res.PRNumber)
	}
}

func TestMerge_AlreadyMergedLocally(t *testing.T) {
	store := newFakePRStore()
	pr := samplePR(1)
	pr.Merged = true
	store.put(pr)
	scm := &fakeSCMActioner{mergeResult: ports.PRMergeResult{Merged: true, Method: "squash"}}
	svc := newTestService(store, scm, nil)

	_, err := svc.Merge(context.Background(), "1")
	if !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable", err)
	}
	if scm.mergeCalls != 0 {
		t.Fatalf("should not call remote when already merged locally")
	}
}

func TestMerge_ClosedPR(t *testing.T) {
	store := newFakePRStore()
	pr := samplePR(2)
	pr.Closed = true
	store.put(pr)
	scm := &fakeSCMActioner{}
	svc := newTestService(store, scm, nil)

	_, err := svc.Merge(context.Background(), "2")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
	if scm.mergeCalls != 0 {
		t.Fatalf("should not call remote for closed PR")
	}
}

func TestMerge_AuthFailure_NoLocalWrite(t *testing.T) {
	store := newFakePRStore()
	store.put(samplePR(5))
	scm := &fakeSCMActioner{mergeErr: ports.ErrSCMAuthFailed}
	svc := newTestService(store, scm, nil)

	_, err := svc.Merge(context.Background(), "5")
	if err == nil {
		t.Fatal("expected auth error")
	}
	if errors.Is(err, ErrPRNotFound) || errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("auth should not map to not-found/not-mergeable: %v", err)
	}
	if store.writeCalls != 0 {
		t.Fatalf("no local write on auth failure")
	}
}

func TestMerge_PersistenceError_AfterRemoteSuccess(t *testing.T) {
	store := newFakePRStore()
	store.put(samplePR(8))
	store.writeErr = errors.New("disk full")
	scm := &fakeSCMActioner{mergeResult: ports.PRMergeResult{Merged: true, SHA: "x", Method: "squash"}}
	svc := newTestService(store, scm, nil)

	_, err := svc.Merge(context.Background(), "8")
	if err == nil {
		t.Fatal("expected persistence error")
	}
	if scm.mergeCalls != 1 {
		t.Fatalf("remote should have been called once")
	}
}

func TestMerge_RemoteUnprocessable(t *testing.T) {
	store := newFakePRStore()
	store.put(samplePR(9))
	scm := &fakeSCMActioner{mergeErr: ports.ErrSCMUnprocessable}
	svc := newTestService(store, scm, nil)

	_, err := svc.Merge(context.Background(), "9")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
}

func TestMerge_RemoteReportsNotMerged_NoLocalWrite(t *testing.T) {
	store := newFakePRStore()
	store.put(samplePR(10))
	// Provider returns success envelope but Merged=false and empty SHA is rejected
	// inside the GitHub adapter; here we simulate a bad result object.
	scm := &fakeSCMActioner{mergeResult: ports.PRMergeResult{Merged: false}}
	svc := newTestService(store, scm, nil)

	_, err := svc.Merge(context.Background(), "10")
	if !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable", err)
	}
	if store.writeCalls != 0 {
		t.Fatalf("must not persist when provider did not confirm merge")
	}
}

// ---- ResolveComments ----

func TestResolveComments_ResolveAll_RemoteThenLocal(t *testing.T) {
	store := newFakePRStore()
	pr := samplePR(42)
	store.put(pr)
	store.threads[pr.URL] = []domain.PullRequestReviewThread{
		{ThreadID: "T_1", Resolved: false},
		{ThreadID: "T_2", Resolved: false},
	}
	store.comments[pr.URL] = []domain.PullRequestComment{
		{ThreadID: "T_1", ID: "C_1", Resolved: false},
		{ThreadID: "T_2", ID: "C_2", Resolved: false},
	}
	scm := &fakeSCMActioner{unresolved: []string{"T_1", "T_2"}}
	svc := newTestService(store, scm, nil)

	res, err := svc.ResolveComments(context.Background(), "42", nil)
	if err != nil {
		t.Fatalf("ResolveComments: %v", err)
	}
	if res.Resolved != 2 {
		t.Fatalf("Resolved = %d, want 2", res.Resolved)
	}
	if scm.listCalls != 1 || len(scm.resolvedIDs) != 2 {
		t.Fatalf("remote list=%d resolved=%v", scm.listCalls, scm.resolvedIDs)
	}
	if store.writeCalls != 1 {
		t.Fatalf("writeCalls = %d, want 1", store.writeCalls)
	}
	for _, th := range store.wroteThreads {
		if !th.Resolved {
			t.Fatalf("thread %s not marked resolved locally", th.ThreadID)
		}
	}
	for _, c := range store.wroteComments {
		if !c.Resolved {
			t.Fatalf("comment %s not marked resolved locally", c.ID)
		}
	}
}

func TestResolveComments_ExplicitIDs(t *testing.T) {
	store := newFakePRStore()
	pr := samplePR(1)
	store.put(pr)
	store.threads[pr.URL] = []domain.PullRequestReviewThread{{ThreadID: "T_only", Resolved: false}}
	scm := &fakeSCMActioner{unresolved: []string{"T_only", "T_other"}}
	svc := newTestService(store, scm, nil)

	res, err := svc.ResolveComments(context.Background(), "1", []string{"T_only", "", "T_only"})
	if err != nil {
		t.Fatalf("ResolveComments: %v", err)
	}
	if res.Resolved != 1 {
		t.Fatalf("Resolved = %d, want 1 (deduped)", res.Resolved)
	}
	if len(scm.resolvedIDs) != 1 || scm.resolvedIDs[0] != "T_only" {
		t.Fatalf("resolvedIDs = %v", scm.resolvedIDs)
	}
}

func TestResolveComments_NothingToResolve(t *testing.T) {
	store := newFakePRStore()
	store.put(samplePR(1))
	scm := &fakeSCMActioner{unresolved: nil}
	svc := newTestService(store, scm, nil)

	_, err := svc.ResolveComments(context.Background(), "1", nil)
	if !errors.Is(err, ErrNothingToResolve) {
		t.Fatalf("err = %v, want ErrNothingToResolve", err)
	}
	if store.writeCalls != 0 {
		t.Fatalf("no local write when nothing to resolve")
	}
}

func TestResolveComments_NotFound(t *testing.T) {
	svc := newTestService(newFakePRStore(), &fakeSCMActioner{}, nil)
	_, err := svc.ResolveComments(context.Background(), "404", nil)
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestResolveComments_RemoteFail_NoLocalWrite(t *testing.T) {
	store := newFakePRStore()
	store.put(samplePR(1))
	scm := &fakeSCMActioner{
		unresolved: []string{"T_1"},
		resolveErr: ports.ErrSCMAuthFailed,
	}
	svc := newTestService(store, scm, nil)

	_, err := svc.ResolveComments(context.Background(), "1", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if store.writeCalls != 0 {
		t.Fatalf("must not write local state when remote resolve fails")
	}
}

func TestResolveComments_ListFail_NoLocalWrite(t *testing.T) {
	store := newFakePRStore()
	store.put(samplePR(1))
	scm := &fakeSCMActioner{listErr: ports.ErrSCMNotFound}
	svc := newTestService(store, scm, nil)

	_, err := svc.ResolveComments(context.Background(), "1", nil)
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
	if store.writeCalls != 0 {
		t.Fatalf("no write on list failure")
	}
}

func TestResolveComments_InvalidPathID(t *testing.T) {
	svc := newTestService(newFakePRStore(), &fakeSCMActioner{}, nil)
	_, err := svc.ResolveComments(context.Background(), "not-a-number", nil)
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestActionService_NotConfigured(t *testing.T) {
	svc := NewActionService()
	if _, err := svc.Merge(context.Background(), "1"); err == nil {
		t.Fatal("expected not-configured error for Merge")
	}
	if _, err := svc.ResolveComments(context.Background(), "1", nil); err == nil {
		t.Fatal("expected not-configured error for ResolveComments")
	}
}