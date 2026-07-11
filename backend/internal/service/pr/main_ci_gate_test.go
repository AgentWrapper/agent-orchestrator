package pr

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeOpenPRs struct {
	prs []domain.PullRequest
	err error
}

func (f fakeOpenPRs) ListOpenPRs(context.Context) ([]domain.PullRequest, error) {
	return f.prs, f.err
}

type fakeCommitChecks struct {
	gotRepo ports.SCMRepo
	gotRef  string
	obs     ports.SCMCommitChecksObservation
	err     error
}

func (f *fakeCommitChecks) FetchCommitChecks(_ context.Context, repo ports.SCMRepo, ref string) (ports.SCMCommitChecksObservation, error) {
	f.gotRepo = repo
	f.gotRef = ref
	return f.obs, f.err
}

type fakeTracker struct {
	issue domain.Issue
	err   error
}

func (f fakeTracker) Get(context.Context, domain.TrackerID) (domain.Issue, error) {
	return f.issue, f.err
}

func (f fakeTracker) List(context.Context, domain.TrackerRepo, domain.ListFilter) ([]domain.Issue, error) {
	return nil, nil
}

func (f fakeTracker) Preflight(context.Context) error { return nil }

type recordingTracker struct {
	got domain.TrackerID
}

func (r *recordingTracker) Get(_ context.Context, id domain.TrackerID) (domain.Issue, error) {
	r.got = id
	return domain.Issue{Labels: []string{"main-ci-fix"}}, nil
}

func (r *recordingTracker) List(context.Context, domain.TrackerRepo, domain.ListFilter) ([]domain.Issue, error) {
	return nil, nil
}

func (r *recordingTracker) Preflight(context.Context) error { return nil }

func TestLiveMainCIGateBlocksRedMainForNonFixPR(t *testing.T) {
	checks := &fakeCommitChecks{obs: ports.SCMCommitChecksObservation{
		Summary: string(domain.CIFailing),
		HeadSHA: "fee462ed",
		FailedChecks: []ports.SCMCheckObservation{
			{Name: "go", Status: string(domain.PRCheckFailed)},
			{Name: "cli-e2e", Status: string(domain.PRCheckFailed)},
		},
	}}
	gate := &LiveMainCIGate{
		PRs: fakeOpenPRs{prs: []domain.PullRequest{{
			URL:          "https://github.com/octocat/hello/pull/42",
			Number:       42,
			Repo:         "octocat/hello",
			TargetBranch: "main",
		}}},
		SCM:     checks,
		Tracker: fakeTracker{issue: domain.Issue{Labels: []string{"task"}}},
	}

	svc := NewActionServiceWithDeps(ActionDeps{MainCI: gate, Merge: fakeMergeExecutor{}})
	_, err := svc.Merge(context.Background(), "42")
	if !errors.Is(err, ErrMainCIRed) {
		t.Fatalf("err = %v, want ErrMainCIRed", err)
	}
	if checks.gotRepo.Repo != "octocat/hello" || checks.gotRef != "main" {
		t.Fatalf("checked repo/ref = %s/%s, want octocat/hello/main", checks.gotRepo.Repo, checks.gotRef)
	}
}

func TestLiveMainCIGateAllowsExplicitFixPRDuringRedMain(t *testing.T) {
	tracker := &recordingTracker{}
	gate := &LiveMainCIGate{
		PRs: fakeOpenPRs{prs: []domain.PullRequest{{
			URL:          "https://github.com/octocat/hello/pull/42",
			Number:       42,
			Repo:         "octocat/hello",
			TargetBranch: "main",
		}}},
		SCM: &fakeCommitChecks{obs: ports.SCMCommitChecksObservation{
			Summary:      string(domain.CIFailing),
			HeadSHA:      "fee462ed",
			FailedChecks: []ports.SCMCheckObservation{{Name: "go", Status: string(domain.PRCheckFailed)}},
		}},
		Tracker: tracker,
	}

	res, err := NewActionServiceWithDeps(ActionDeps{MainCI: gate, Merge: fakeMergeExecutor{}}).Merge(context.Background(), "42")
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if res.PRNumber != 42 || res.Method != "squash" {
		t.Fatalf("res = %+v, want PR 42 squash", res)
	}
	if tracker.got.Provider != domain.TrackerProviderGitHub || tracker.got.Native != "octocat/hello#42" {
		t.Fatalf("tracker id = %+v, want github octocat/hello#42", tracker.got)
	}
}

func TestLiveMainCIGateFailsClosedForAmbiguousPRNumber(t *testing.T) {
	gate := &LiveMainCIGate{
		PRs: fakeOpenPRs{prs: []domain.PullRequest{
			{URL: "https://github.com/octocat/hello/pull/42", Number: 42, Repo: "octocat/hello"},
			{URL: "https://github.com/acme/api/pull/42", Number: 42, Repo: "acme/api"},
		}},
		SCM: &fakeCommitChecks{},
	}

	_, err := gate.Check(context.Background(), "42")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
}
