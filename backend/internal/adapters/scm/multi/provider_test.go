package multi

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeProvider struct {
	key            string
	parseOK        bool
	credsAvailable bool
	fetchCallCount int
	fetchErr       error
}

func (f *fakeProvider) ParseRepository(remote string) (ports.SCMRepo, bool) {
	if !f.parseOK {
		return ports.SCMRepo{}, false
	}
	return ports.SCMRepo{Provider: f.key, Host: f.key + ".com", Owner: "owner", Name: "repo", Repo: "owner/repo"}, true
}

func (f *fakeProvider) RepoPRListGuard(_ context.Context, _ ports.SCMRepo, etag string) (ports.SCMGuardResult, error) {
	return ports.SCMGuardResult{ETag: "etag-" + f.key, NotModified: etag == "etag-"+f.key}, nil
}

func (f *fakeProvider) ListOpenPRsByRepo(_ context.Context, _ ports.SCMRepo) ([]ports.SCMPRObservation, error) {
	return []ports.SCMPRObservation{{Number: 1, State: "open"}}, nil
}

func (f *fakeProvider) CommitChecksGuard(_ context.Context, _ ports.SCMRepo, _, etag string) (ports.SCMGuardResult, error) {
	return ports.SCMGuardResult{}, nil
}

func (f *fakeProvider) FetchPullRequests(_ context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	f.fetchCallCount++
	if f.fetchErr != nil {
		return nil, f.fetchErr
	}
	obs := make([]ports.SCMObservation, len(refs))
	for i, r := range refs {
		obs[i] = ports.SCMObservation{Fetched: true, Provider: f.key, PR: ports.SCMPRObservation{Number: r.Number}}
	}
	return obs, nil
}

func (f *fakeProvider) FetchFailedCheckLogTail(_ context.Context, _ ports.SCMRepo, _ ports.SCMCheckObservation) (string, error) {
	return "log tail from " + f.key, nil
}

func (f *fakeProvider) FetchReviewThreads(_ context.Context, _ ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	return ports.SCMReviewObservation{Decision: "none"}, nil
}

func (f *fakeProvider) SCMCredentialsAvailable(_ context.Context) (bool, error) {
	return f.credsAvailable, nil
}

func TestParseRepository_RoutesToFirstMatch(t *testing.T) {
	gh := &fakeProvider{key: "github", parseOK: true}
	gl := &fakeProvider{key: "gitlab", parseOK: false}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	repo, ok := m.ParseRepository("git@github.com:owner/repo.git")
	if !ok {
		t.Fatal("expected match")
	}
	if repo.Provider != "github" {
		t.Errorf("Provider = %q, want %q", repo.Provider, "github")
	}
}

func TestParseRepository_FallsThrough(t *testing.T) {
	gh := &fakeProvider{key: "github", parseOK: false}
	gl := &fakeProvider{key: "gitlab", parseOK: true}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	repo, ok := m.ParseRepository("git@gitlab.com:owner/repo.git")
	if !ok {
		t.Fatal("expected match")
	}
	if repo.Provider != "gitlab" {
		t.Errorf("Provider = %q, want %q", repo.Provider, "gitlab")
	}
}

func TestParseRepository_NoMatch(t *testing.T) {
	gh := &fakeProvider{key: "github", parseOK: false}
	gl := &fakeProvider{key: "gitlab", parseOK: false}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	_, ok := m.ParseRepository("git@unknown.com:owner/repo.git")
	if ok {
		t.Fatal("expected no match")
	}
}

func TestRouting_RepoPRListGuard(t *testing.T) {
	gh := &fakeProvider{key: "github", parseOK: true}
	gl := &fakeProvider{key: "gitlab", parseOK: true}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	res, err := m.RepoPRListGuard(context.Background(), ports.SCMRepo{Provider: "gitlab"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.ETag != "etag-gitlab" {
		t.Errorf("ETag = %q, want %q (routed to wrong provider)", res.ETag, "etag-gitlab")
	}
}

func TestRouting_UnknownProvider(t *testing.T) {
	m := New(NamedProvider{Key: "github", Provider: &fakeProvider{key: "github"}})

	_, err := m.RepoPRListGuard(context.Background(), ports.SCMRepo{Provider: "gitlab"}, "")
	if err == nil {
		t.Fatal("expected error for unknown provider")
	}
}

func TestFetchPullRequests_PartitionsAndMerges(t *testing.T) {
	gh := &fakeProvider{key: "github", parseOK: true}
	gl := &fakeProvider{key: "gitlab", parseOK: true}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	refs := []ports.SCMPRRef{
		{Repo: ports.SCMRepo{Provider: "github"}, Number: 10},
		{Repo: ports.SCMRepo{Provider: "gitlab"}, Number: 20},
		{Repo: ports.SCMRepo{Provider: "github"}, Number: 30},
	}

	obs, err := m.FetchPullRequests(context.Background(), refs)
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 3 {
		t.Fatalf("got %d observations, want 3", len(obs))
	}
	if obs[0].Provider != "github" || obs[0].PR.Number != 10 {
		t.Errorf("obs[0] = %+v, want github/10", obs[0])
	}
	if obs[1].Provider != "gitlab" || obs[1].PR.Number != 20 {
		t.Errorf("obs[1] = %+v, want gitlab/20", obs[1])
	}
	if obs[2].Provider != "github" || obs[2].PR.Number != 30 {
		t.Errorf("obs[2] = %+v, want github/30", obs[2])
	}
	if gh.fetchCallCount != 1 {
		t.Errorf("github.FetchPullRequests called %d times, want 1", gh.fetchCallCount)
	}
	if gl.fetchCallCount != 1 {
		t.Errorf("gitlab.FetchPullRequests called %d times, want 1", gl.fetchCallCount)
	}
}

func TestSCMCredentialsAvailable_AnyTrue(t *testing.T) {
	gh := &fakeProvider{key: "github", credsAvailable: false}
	gl := &fakeProvider{key: "gitlab", credsAvailable: true}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	avail, err := m.SCMCredentialsAvailable(context.Background())
	if err != nil || !avail {
		t.Errorf("want (true, nil), got (%v, %v)", avail, err)
	}
}

func TestSCMCredentialsAvailable_NoneTrue(t *testing.T) {
	gh := &fakeProvider{key: "github", credsAvailable: false}
	gl := &fakeProvider{key: "gitlab", credsAvailable: false}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	avail, err := m.SCMCredentialsAvailable(context.Background())
	if err != nil || avail {
		t.Errorf("want (false, nil), got (%v, %v)", avail, err)
	}
}

func TestFetchPullRequests_PropagatesError(t *testing.T) {
	gh := &fakeProvider{key: "github", fetchErr: errors.New("github down")}
	m := New(NamedProvider{Key: "github", Provider: gh})

	refs := []ports.SCMPRRef{{Repo: ports.SCMRepo{Provider: "github"}, Number: 1}}
	_, err := m.FetchPullRequests(context.Background(), refs)
	if err == nil {
		t.Fatal("expected error")
	}
}
