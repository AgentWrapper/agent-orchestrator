package pr

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeActionLookup struct {
	pr  domain.PullRequest
	ok  bool
	err error
}

func (f *fakeActionLookup) GetPRByNumber(_ context.Context, _ int) (domain.PullRequest, bool, error) {
	return f.pr, f.ok, f.err
}

type fakeSCMActions struct {
	mergeOwner  string
	mergeRepo   string
	mergeNumber int
	mergeMethod string
	mergeErr    error
	closeOwner  string
	closeRepo   string
	closeNumber int
	closeErr    error
}

func (f *fakeSCMActions) MergePR(_ context.Context, owner, repo string, number int, method string) error {
	f.mergeOwner = owner
	f.mergeRepo = repo
	f.mergeNumber = number
	f.mergeMethod = method
	return f.mergeErr
}

func (f *fakeSCMActions) ClosePR(_ context.Context, owner, repo string, number int) error {
	f.closeOwner = owner
	f.closeRepo = repo
	f.closeNumber = number
	return f.closeErr
}

func TestMerge_LooksUpStoredPRAndSquashMergesViaSCM(t *testing.T) {
	scm := &fakeSCMActions{}
	svc := NewActionService(ActionDeps{
		Lookup: &fakeActionLookup{
			pr: domain.PullRequest{URL: "https://github.com/acme/widgets/pull/42", Number: 42, Repo: "acme/widgets"},
			ok: true,
		},
		SCM: scm,
	})

	res, err := svc.Merge(context.Background(), "42")
	if err != nil {
		t.Fatal(err)
	}
	if scm.mergeOwner != "acme" || scm.mergeRepo != "widgets" || scm.mergeNumber != 42 || scm.mergeMethod != "squash" {
		t.Fatalf("MergePR called with owner=%q repo=%q number=%d method=%q", scm.mergeOwner, scm.mergeRepo, scm.mergeNumber, scm.mergeMethod)
	}
	if res.PRNumber != 42 || res.Method != "squash" {
		t.Fatalf("result = %+v, want PRNumber 42 Method squash", res)
	}
}

func TestMerge_FallsBackToPRURLWhenRepoFieldMissing(t *testing.T) {
	scm := &fakeSCMActions{}
	svc := NewActionService(ActionDeps{
		Lookup: &fakeActionLookup{
			pr: domain.PullRequest{URL: "https://github.com/acme/widgets/pull/42", Number: 42},
			ok: true,
		},
		SCM: scm,
	})

	if _, err := svc.Merge(context.Background(), "42"); err != nil {
		t.Fatal(err)
	}
	if scm.mergeOwner != "acme" || scm.mergeRepo != "widgets" || scm.mergeNumber != 42 {
		t.Fatalf("MergePR called with owner=%q repo=%q number=%d", scm.mergeOwner, scm.mergeRepo, scm.mergeNumber)
	}
}

func TestMerge_UnknownPRNumberReturnsNotFoundWithoutSCMCall(t *testing.T) {
	scm := &fakeSCMActions{}
	svc := NewActionService(ActionDeps{Lookup: &fakeActionLookup{}, SCM: scm})

	if _, err := svc.Merge(context.Background(), "42"); !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
	if scm.mergeNumber != 0 {
		t.Fatalf("MergePR called for missing PR: %+v", scm)
	}
}

func TestMerge_PropagatesSCMActionError(t *testing.T) {
	scm := &fakeSCMActions{mergeErr: ErrPRNotMergeable}
	svc := NewActionService(ActionDeps{
		Lookup: &fakeActionLookup{pr: domain.PullRequest{URL: "https://github.com/acme/widgets/pull/42", Number: 42, Repo: "acme/widgets"}, ok: true},
		SCM:    scm,
	})

	if _, err := svc.Merge(context.Background(), "42"); !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable", err)
	}
}

func TestClose_LooksUpStoredPRAndClosesViaSCM(t *testing.T) {
	scm := &fakeSCMActions{}
	svc := NewActionService(ActionDeps{
		Lookup: &fakeActionLookup{
			pr: domain.PullRequest{URL: "https://github.com/acme/widgets/pull/42", Number: 42, Repo: "acme/widgets"},
			ok: true,
		},
		SCM: scm,
	})

	res, err := svc.Close(context.Background(), "42")
	if err != nil {
		t.Fatal(err)
	}
	if scm.closeOwner != "acme" || scm.closeRepo != "widgets" || scm.closeNumber != 42 {
		t.Fatalf("ClosePR called with owner=%q repo=%q number=%d", scm.closeOwner, scm.closeRepo, scm.closeNumber)
	}
	if res.PRNumber != 42 {
		t.Fatalf("result = %+v, want PRNumber 42", res)
	}
}

func TestClose_PropagatesSCMActionError(t *testing.T) {
	scm := &fakeSCMActions{closeErr: ErrPRNotFound}
	svc := NewActionService(ActionDeps{
		Lookup: &fakeActionLookup{pr: domain.PullRequest{URL: "https://github.com/acme/widgets/pull/42", Number: 42, Repo: "acme/widgets"}, ok: true},
		SCM:    scm,
	})

	if _, err := svc.Close(context.Background(), "42"); !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestResolveComments_ReturnsOK(t *testing.T) {
	svc := NewActionService(ActionDeps{})
	_, err := svc.ResolveComments(context.Background(), "1", nil)
	if err != nil {
		t.Fatal(err)
	}
}
