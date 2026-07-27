package pr

import (
	"context"
	"errors"
	"testing"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakePRStore struct {
	pr         domain.PullRequest
	ok         bool
	err        error
	unresolved bool
	unresErr   error
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

type fakeSCMMerger struct {
	sha      string
	err      error
	settings scmgithub.RepoMergeSettings
	settErr  error
}

func (f *fakeSCMMerger) MergePR(_ context.Context, _, _ string, _ int, _, _ string) (string, error) {
	return f.sha, f.err
}

func (f *fakeSCMMerger) RepoMergeSettings(_ context.Context, _, _ string) (scmgithub.RepoMergeSettings, error) {
	return f.settings, f.settErr
}

func mergeablePR(number int, repo string) domain.PullRequest {
	return domain.PullRequest{
		Number:       number,
		Repo:         repo,
		CI:           domain.CIPassing,
		Review:       domain.ReviewApproved,
		Mergeability: domain.MergeMergeable,
		HeadSHA:      "headsha123",
	}
}

func allowSquash() scmgithub.RepoMergeSettings {
	return scmgithub.RepoMergeSettings{AllowSquash: true}
}

func TestMerge_Success(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(42, "acme/widgets")}
	scm := &fakeSCMMerger{sha: "abc123", settings: allowSquash()}
	svc := NewActionService(store, scm)

	res, err := svc.Merge(context.Background(), "42", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.PRNumber != 42 || res.Method != "squash" {
		t.Fatalf("res = %#v", res)
	}
}

func TestMerge_SuccessWithRepoScope(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(42, "acme/widgets")}
	scm := &fakeSCMMerger{sha: "abc123", settings: allowSquash()}
	svc := NewActionService(store, scm)

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
	svc := NewActionService(store, &fakeSCMMerger{settings: allowSquash()})
	_, err := svc.Merge(context.Background(), "99", "")
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestMerge_NotMergeable(t *testing.T) {
	pr := mergeablePR(1, "acme/widgets")
	pr.Mergeability = domain.MergeBlocked
	store := &fakePRStore{ok: true, pr: pr}
	svc := NewActionService(store, &fakeSCMMerger{settings: allowSquash()})
	_, err := svc.Merge(context.Background(), "1", "")
	if !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable", err)
	}
}

func TestMerge_AlreadyMerged(t *testing.T) {
	store := &fakePRStore{ok: true, pr: domain.PullRequest{Merged: true}}
	svc := NewActionService(store, &fakeSCMMerger{settings: allowSquash()})
	_, err := svc.Merge(context.Background(), "1", "")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
}

func TestMerge_NilSCM(t *testing.T) {
	svc := NewActionService(&fakePRStore{}, nil)
	_, err := svc.Merge(context.Background(), "1", "")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions (SCM unavailable)", err)
	}
}

func TestMerge_BadID(t *testing.T) {
	svc := NewActionService(&fakePRStore{}, &fakeSCMMerger{})
	_, err := svc.Merge(context.Background(), "not-a-number", "")
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestMerge_UnresolvedReviewCommentsBlocksMerge(t *testing.T) {
	pr := mergeablePR(7, "acme/widgets")
	store := &fakePRStore{ok: true, pr: pr, unresolved: true}
	svc := NewActionService(store, &fakeSCMMerger{settings: allowSquash()})
	_, err := svc.Merge(context.Background(), "7", "")
	if !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable (unresolved review comments)", err)
	}
}

func TestMerge_NoAllowedMergeMethodReturnsPreconditions(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(9, "acme/widgets")}
	svc := NewActionService(store, &fakeSCMMerger{settings: scmgithub.RepoMergeSettings{}})
	_, err := svc.Merge(context.Background(), "9", "")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions (no merge method enabled)", err)
	}
}

func TestMerge_PrefersSquashThenMergeThenRebase(t *testing.T) {
	store := &fakePRStore{ok: true, pr: mergeablePR(10, "acme/widgets")}
	scm := &fakeSCMMerger{sha: "abc", settings: scmgithub.RepoMergeSettings{AllowMergeCommit: true, AllowRebase: true}}
	svc := NewActionService(store, scm)
	res, err := svc.Merge(context.Background(), "10", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Method != "merge" {
		t.Fatalf("method = %q, want merge (squash disabled, merge commit allowed)", res.Method)
	}
}

func TestResolveComments_ReturnsNotImplemented(t *testing.T) {
	svc := NewActionService(&fakePRStore{}, &fakeSCMMerger{})
	_, err := svc.ResolveComments(context.Background(), "1", nil)
	if !errors.Is(err, ErrNotImplemented) {
		t.Fatalf("err = %v, want ErrNotImplemented", err)
	}
}
