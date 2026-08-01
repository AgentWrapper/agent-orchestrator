package pr

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakePRStore struct {
	pr         domain.PullRequest
	ok         bool
	err        error
	unresolved bool
	unresErr   error
	checks     []domain.PullRequestCheck
	written    *domain.PullRequest
	writeErr   error
}

func (f *fakePRStore) GetPRByNumber(_ context.Context, _ int) (domain.PullRequest, bool, error) {
	return f.pr, f.ok, f.err
}

func (f *fakePRStore) GetPRByRepoAndNumber(_ context.Context, _ string, _ int) (domain.PullRequest, bool, error) {
	return f.pr, f.ok, f.err
}

func (f *fakePRStore) GetPRReviewCommentsUnresolved(_ context.Context, _ string) (bool, error) {
	return f.unresolved, f.unresErr
}

func (f *fakePRStore) ListChecks(_ context.Context, _ string) ([]domain.PullRequestCheck, error) {
	return append([]domain.PullRequestCheck(nil), f.checks...), nil
}

func (f *fakePRStore) WriteSCMObservation(_ context.Context, pr domain.PullRequest, _ []domain.PullRequestCheck, _ []domain.PullRequestReview, _ []domain.PullRequestReviewThread, _ []domain.PullRequestComment, _ ports.ReviewWriteMode) error {
	f.written = &pr
	return f.writeErr
}

type fakeSCMMerger struct {
	sha      string
	err      error
	settings ports.SCMRepoMergeSettings
	settErr  error
}

func (f *fakeSCMMerger) MergePR(_ context.Context, _, _ string, _ int, _, _ string) (string, error) {
	return f.sha, f.err
}

func (f *fakeSCMMerger) RepoMergeSettings(_ context.Context, _, _ string) (ports.SCMRepoMergeSettings, error) {
	return f.settings, f.settErr
}

func mergeablePR(number int, repo string) domain.PullRequest {
	return domain.PullRequest{
		URL:          "https://github.com/" + repo + "/pull/42",
		Number:       number,
		SessionID:    "sess-1",
		Repo:         repo,
		CI:           domain.CIPassing,
		Review:       domain.ReviewApproved,
		Mergeability: domain.MergeMergeable,
		HeadSHA:      "headsha123",
	}
}

func allowSquash() ports.SCMRepoMergeSettings {
	return ports.SCMRepoMergeSettings{AllowSquash: true}
}

func TestMerge_Success(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(42, "acme/widgets")}
	scm := &fakeSCMMerger{sha: "abc123", settings: allowSquash()}
	svc := NewActionService(store, scm, nil)

	res, err := svc.Merge(context.Background(), "42", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.PRNumber != 42 || res.Method != "squash" {
		t.Fatalf("res = %#v", res)
	}
	if store.written == nil {
		t.Fatal("expected merged PR snapshot to be persisted")
	}
	if !store.written.Merged || store.written.MergeCommitSHA != "abc123" {
		t.Fatalf("persisted PR = %#v, want merged with merge SHA", *store.written)
	}
}

func TestMerge_SuccessWithRepoScope(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(42, "acme/widgets")}
	scm := &fakeSCMMerger{sha: "abc123", settings: allowSquash()}
	svc := NewActionService(store, scm, nil)

	res, err := svc.Merge(context.Background(), "42", "acme/widgets")
	if err != nil {
		t.Fatal(err)
	}
	if res.PRNumber != 42 || res.Method != "squash" {
		t.Fatalf("res = %#v", res)
	}
}

func TestMerge_NotFound(t *testing.T) {
	store := &fakePRStore{ok: false}
	svc := NewActionService(store, &fakeSCMMerger{settings: allowSquash()}, nil)
	_, err := svc.Merge(context.Background(), "99", "")
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestMerge_NotMergeable(t *testing.T) {
	pr := mergeablePR(1, "acme/widgets")
	pr.Mergeability = domain.MergeBlocked
	store := &fakePRStore{ok: true, pr: pr}
	svc := NewActionService(store, &fakeSCMMerger{settings: allowSquash()}, nil)
	_, err := svc.Merge(context.Background(), "1", "")
	if !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable", err)
	}
}

func TestMerge_UnknownCIWithObservedChecksIsNotMergeable(t *testing.T) {
	pr := mergeablePR(2, "acme/widgets")
	pr.CI = domain.CIUnknown
	store := &fakePRStore{
		ok:     true,
		pr:     pr,
		checks: []domain.PullRequestCheck{{Name: "unit", Status: domain.PRCheckPassed}},
	}
	svc := NewActionService(store, &fakeSCMMerger{settings: allowSquash()}, nil)
	_, err := svc.Merge(context.Background(), "2", "")
	if !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable", err)
	}
	if store.written != nil {
		t.Fatalf("unexpected merged snapshot persisted: %#v", *store.written)
	}
}

func TestMerge_UnknownCIWithNoChecksIsMergeable(t *testing.T) {
	pr := mergeablePR(3, "acme/widgets")
	pr.CI = domain.CIUnknown
	store := &fakePRStore{ok: true, pr: pr}
	svc := NewActionService(store, &fakeSCMMerger{sha: "merge-sha", settings: allowSquash()}, nil)
	res, err := svc.Merge(context.Background(), "3", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.PRNumber != 3 || store.written == nil || !store.written.Merged {
		t.Fatalf("res = %#v written = %#v", res, store.written)
	}
}

func TestMerge_AlreadyMerged(t *testing.T) {
	store := &fakePRStore{ok: true, pr: domain.PullRequest{Merged: true}}
	svc := NewActionService(store, &fakeSCMMerger{settings: allowSquash()}, nil)
	_, err := svc.Merge(context.Background(), "1", "")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
}

func TestMerge_NilSCM(t *testing.T) {
	svc := NewActionService(&fakePRStore{}, nil, nil)
	_, err := svc.Merge(context.Background(), "1", "")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions (SCM unavailable)", err)
	}
}

func TestMerge_BadID(t *testing.T) {
	svc := NewActionService(&fakePRStore{}, &fakeSCMMerger{}, nil)
	_, err := svc.Merge(context.Background(), "not-a-number", "")
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestMerge_UnresolvedReviewCommentsBlocksMerge(t *testing.T) {
	pr := mergeablePR(7, "acme/widgets")
	store := &fakePRStore{ok: true, pr: pr, unresolved: true}
	svc := NewActionService(store, &fakeSCMMerger{settings: allowSquash()}, nil)
	_, err := svc.Merge(context.Background(), "7", "")
	if !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable (unresolved review comments)", err)
	}
}

func TestMerge_NoAllowedMergeMethodReturnsPreconditions(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(9, "acme/widgets")}
	svc := NewActionService(store, &fakeSCMMerger{settings: ports.SCMRepoMergeSettings{}}, nil)
	_, err := svc.Merge(context.Background(), "9", "")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions (no merge method enabled)", err)
	}
}

func TestMerge_PrefersSquashThenMergeThenRebase(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(10, "acme/widgets")}
	scm := &fakeSCMMerger{sha: "abc", settings: ports.SCMRepoMergeSettings{AllowMergeCommit: true, AllowRebase: true}}
	svc := NewActionService(store, scm, nil)
	res, err := svc.Merge(context.Background(), "10", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Method != "merge" {
		t.Fatalf("method = %q, want merge (squash disabled, merge commit allowed)", res.Method)
	}
}

func TestMerge_Success_AppliesLifecycleReactionWithMergedObservation(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(42, "acme/widgets")}
	scm := &fakeSCMMerger{sha: "abc123", settings: allowSquash()}
	lc := &fakeLifecycle{}
	svc := NewActionService(store, scm, lc)

	if _, err := svc.Merge(context.Background(), "42", ""); err != nil {
		t.Fatal(err)
	}
	if len(lc.observed) != 1 {
		t.Fatalf("lifecycle.ApplyPRObservation calls = %d, want 1", len(lc.observed))
	}
	if lc.ids[0] != "sess-1" {
		t.Fatalf("session id = %q, want sess-1", lc.ids[0])
	}
	o := lc.observed[0]
	if !o.Fetched || !o.Merged || o.URL == "" || o.Number != 42 {
		t.Fatalf("observation = %#v, want Fetched+Merged with URL/Number set", o)
	}
}

func TestMerge_Success_LifecycleFailureStaysBestEffort(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(42, "acme/widgets")}
	scm := &fakeSCMMerger{sha: "abc123", settings: allowSquash()}
	lc := &fakeLifecycle{err: errors.New("boom")}
	svc := NewActionService(store, scm, lc)

	res, err := svc.Merge(context.Background(), "42", "")
	if err != nil {
		t.Fatalf("merge should still succeed when the best-effort lifecycle reaction fails: %v", err)
	}
	if res.PRNumber != 42 {
		t.Fatalf("res = %#v", res)
	}
	if len(lc.observed) != 1 {
		t.Fatalf("lifecycle.ApplyPRObservation calls = %d, want 1 (must still be attempted)", len(lc.observed))
	}
}

func TestMerge_ProviderSuccess_PersistenceFailureStillSucceedsAndAppliesLifecycle(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(42, "acme/widgets"), writeErr: errors.New("db write failed")}
	scm := &fakeSCMMerger{sha: "abc123", settings: allowSquash()}
	lc := &fakeLifecycle{}
	svc := NewActionService(store, scm, lc)

	res, err := svc.Merge(context.Background(), "42", "")
	if err != nil {
		t.Fatalf("local persistence failure after successful provider merge must not report as merge error (GitHub already merged): %v", err)
	}
	if res.PRNumber != 42 || res.Method != "squash" {
		t.Fatalf("res = %#v", res)
	}
	if len(lc.observed) != 1 {
		t.Fatalf("lifecycle calls = %d, want 1 (cleanup must proceed despite persistence failure)", len(lc.observed))
	}
	if !lc.observed[0].Merged {
		t.Fatalf("observation.Merged = false, want true")
	}
}

func TestResolveComments_ReturnsNotImplemented(t *testing.T) {
	svc := NewActionService(&fakePRStore{}, &fakeSCMMerger{}, nil)
	_, err := svc.ResolveComments(context.Background(), "1", nil)
	if !errors.Is(err, ErrNotImplemented) {
		t.Fatalf("err = %v, want ErrNotImplemented", err)
	}
}
