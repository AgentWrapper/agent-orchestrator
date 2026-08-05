package pr

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeActionStore struct {
	pr         domain.PullRequest
	ok         bool
	writeErr   error
	written    *domain.PullRequest
	writeCalls int
}

func (f *fakeActionStore) GetPR(context.Context, string) (domain.PullRequest, bool, error) {
	return f.pr, f.ok, nil
}

func (f *fakeActionStore) WriteSCMObservation(_ context.Context, pr domain.PullRequest, _ []domain.PullRequestCheck, _ []domain.PullRequestReview, _ []domain.PullRequestReviewThread, _ []domain.PullRequestComment, _ ports.ReviewWriteMode) error {
	f.writeCalls++
	prCopy := pr
	f.written = &prCopy
	return f.writeErr
}

type observedPRObservation struct {
	sessionID domain.SessionID
	obs       ports.PRObservation
}

type fakeActionLifecycle struct {
	observed []observedPRObservation
	err      error
}

func (f *fakeActionLifecycle) ApplyPRObservation(_ context.Context, id domain.SessionID, o ports.PRObservation) error {
	f.observed = append(f.observed, observedPRObservation{sessionID: id, obs: o})
	return f.err
}

type fakeSCMAction struct {
	observation ports.SCMObservation
	review      ports.SCMReviewObservation
	mergeErr    error
	request     ports.SCMMergeRequest
	mergeCalls  int
}

func (f *fakeSCMAction) FetchPullRequests(context.Context, []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	return []ports.SCMObservation{f.observation}, nil
}

func (f *fakeSCMAction) FetchReviewThreads(context.Context, ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	return f.review, nil
}

func (f *fakeSCMAction) MergePullRequest(_ context.Context, request ports.SCMMergeRequest) (ports.SCMMergeResult, error) {
	f.mergeCalls++
	f.request = request
	return ports.SCMMergeResult{MergeCommitSHA: "merge-sha"}, f.mergeErr
}

func mergeableActionFixture() (domain.PullRequest, *fakeSCMAction) {
	pr := domain.PullRequest{
		URL:          "https://github.com/acme/widgets/pull/42",
		Number:       42,
		SessionID:    "sess-42",
		Provider:     "github",
		Host:         "github.com",
		Repo:         "acme/widgets",
		HeadSHA:      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Mergeability: domain.MergeMergeable,
	}
	scm := &fakeSCMAction{observation: ports.SCMObservation{
		Fetched:      true,
		PR:           ports.SCMPRObservation{URL: pr.URL, Number: pr.Number, HeadSHA: pr.HeadSHA},
		CI:           ports.SCMCIObservation{Summary: string(domain.CIPassing), HeadSHA: pr.HeadSHA},
		Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable), Mergeable: true},
	}}
	return pr, scm
}

func TestActionServiceMerge_GuardsAndSquashMergesExactHead(t *testing.T) {
	pr, scm := mergeableActionFixture()
	svc := NewActionService(ActionDeps{Store: &fakeActionStore{pr: pr, ok: true}, Reader: scm, Merger: scm})
	result, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA})
	if err != nil {
		t.Fatal(err)
	}
	if result.PRNumber != 42 || result.Method != "squash" || result.MergeCommitSHA != "merge-sha" {
		t.Fatalf("result = %#v", result)
	}
	if scm.mergeCalls != 1 || scm.request.ExpectedHeadSHA != pr.HeadSHA || scm.request.Method != ports.SCMMergeSquash {
		t.Fatalf("request = %#v, calls = %d", scm.request, scm.mergeCalls)
	}
}

func TestActionServiceMerge_FailsClosedForStaleHeadOrReadiness(t *testing.T) {
	pr, scm := mergeableActionFixture()
	svc := NewActionService(ActionDeps{Store: &fakeActionStore{pr: pr, ok: true}, Reader: scm, Merger: scm})
	_, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	if !errors.Is(err, ErrPRHeadChanged) || scm.mergeCalls != 0 {
		t.Fatalf("stale head error = %v, calls = %d", err, scm.mergeCalls)
	}

	pr, scm = mergeableActionFixture()
	scm.observation.CI.Summary = string(domain.CIPending)
	svc = NewActionService(ActionDeps{Store: &fakeActionStore{pr: pr, ok: true}, Reader: scm, Merger: scm})
	_, err = svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA})
	if !errors.Is(err, ErrPRPreconditions) || scm.mergeCalls != 0 {
		t.Fatalf("pending CI error = %v, calls = %d", err, scm.mergeCalls)
	}
}

func TestActionServiceMerge_MapsProviderConflict(t *testing.T) {
	pr, scm := mergeableActionFixture()
	scm.mergeErr = ports.ErrSCMHeadChanged
	svc := NewActionService(ActionDeps{Store: &fakeActionStore{pr: pr, ok: true}, Reader: scm, Merger: scm})
	_, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA})
	if !errors.Is(err, ErrPRHeadChanged) {
		t.Fatalf("error = %v", err)
	}
}

func TestActionServiceMerge_AppliesLifecycleReactionWithMergedObservation(t *testing.T) {
	pr, scm := mergeableActionFixture()
	store := &fakeActionStore{pr: pr, ok: true}
	lc := &fakeActionLifecycle{}
	svc := NewActionService(ActionDeps{Store: store, Reader: scm, Merger: scm, Lifecycle: lc})

	result, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MergeCommitSHA != "merge-sha" {
		t.Fatalf("merge commit sha = %q, want merge-sha", result.MergeCommitSHA)
	}
	if store.writeCalls != 1 || store.written == nil || !store.written.Merged || store.written.MergeCommitSHA != "merge-sha" {
		t.Fatalf("persisted snapshot = %+v, writeCalls = %d", store.written, store.writeCalls)
	}
	if len(lc.observed) != 1 {
		t.Fatalf("lifecycle.ApplyPRObservation calls = %d, want 1", len(lc.observed))
	}
	obs := lc.observed[0]
	if obs.sessionID != pr.SessionID {
		t.Fatalf("sessionID = %q, want %q", obs.sessionID, pr.SessionID)
	}
	if !obs.obs.Fetched || !obs.obs.Merged || obs.obs.Closed {
		t.Fatalf("observation = %+v, want {Fetched:true Merged:true Closed:false}", obs.obs)
	}
}

func TestActionServiceMerge_LifecycleFailureStaysBestEffort(t *testing.T) {
	pr, scm := mergeableActionFixture()
	lc := &fakeActionLifecycle{err: errors.New("boom")}
	svc := NewActionService(ActionDeps{Store: &fakeActionStore{pr: pr, ok: true}, Reader: scm, Merger: scm, Lifecycle: lc})

	if _, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA}); err != nil {
		t.Fatalf("merge should still succeed when the best-effort lifecycle reaction fails: %v", err)
	}
	if len(lc.observed) != 1 {
		t.Fatalf("lifecycle.ApplyPRObservation calls = %d, want 1 (must still be attempted)", len(lc.observed))
	}
}

func TestActionServiceMerge_ProviderSuccess_PersistenceFailureStillSucceedsAndAppliesLifecycle(t *testing.T) {
	pr, scm := mergeableActionFixture()
	store := &fakeActionStore{pr: pr, ok: true, writeErr: errors.New("disk full")}
	lc := &fakeActionLifecycle{}
	svc := NewActionService(ActionDeps{Store: store, Reader: scm, Merger: scm, Lifecycle: lc})

	if _, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA}); err != nil {
		t.Fatalf("merge should still succeed once the provider merge is irreversible: %v", err)
	}
	if store.writeCalls != 1 {
		t.Fatalf("persistence write calls = %d, want 1", store.writeCalls)
	}
	if len(lc.observed) != 1 {
		t.Fatalf("lifecycle calls = %d, want 1 (cleanup must proceed despite persistence failure)", len(lc.observed))
	}
}
