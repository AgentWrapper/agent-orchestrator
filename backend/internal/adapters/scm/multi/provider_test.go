package multi

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeProvider struct {
	key            string
	parseOK        bool
	credsAvailable bool
	credsErr       error
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

func (f *fakeProvider) ListPRsByRepo(_ context.Context, _ ports.SCMRepo, _ time.Time) ([]ports.SCMPRObservation, error) {
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
	return f.credsAvailable, f.credsErr
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

// TestFetchPullRequests_OneProviderFailsOthersSucceed verifies that when one
// provider fails, the other provider's successful observations are still
// returned and no error suppresses them. A GitLab timeout
// must not discard successful GitHub observations.
func TestFetchPullRequests_OneProviderFailsOthersSucceed(t *testing.T) {
	gh := &fakeProvider{key: "github", parseOK: true}
	gl := &fakeProvider{key: "gitlab", parseOK: true, fetchErr: errors.New("gitlab timeout")}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	refs := []ports.SCMPRRef{
		{Repo: ports.SCMRepo{Provider: "github"}, Number: 10},
		{Repo: ports.SCMRepo{Provider: "gitlab"}, Number: 20},
	}
	obs, err := m.FetchPullRequests(context.Background(), refs)
	if err != nil {
		t.Fatalf("error = %v, want nil (one provider failure must not suppress the other)", err)
	}
	if len(obs) != 2 {
		t.Fatalf("got %d observations, want 2", len(obs))
	}
	// GitHub observation must be present and correct despite GitLab failure.
	if !obs[0].Fetched || obs[0].Provider != "github" || obs[0].PR.Number != 10 {
		t.Errorf("obs[0] = %+v, want github/10 Fetched=true", obs[0])
	}
	// GitLab slot: the failing provider should leave a Fetched=false placeholder
	// so the observer can reject it without advancing durable state.
	if obs[1].Fetched {
		t.Errorf("obs[1].Fetched = true, want false for failed gitlab fetch")
	}
	// Item 7: the failed-provider observation must carry the error as transient
	// per-observation metadata so the observer can route it to cooldown or
	// refresh-incomplete handling.
	if obs[1].Error == nil {
		t.Errorf("obs[1].Error = nil, want the gitlab failure error for observer routing")
	}
	if gh.fetchCallCount != 1 {
		t.Errorf("github.FetchPullRequests called %d times, want 1", gh.fetchCallCount)
	}
	if gl.fetchCallCount != 1 {
		t.Errorf("gitlab.FetchPullRequests called %d times, want 1", gl.fetchCallCount)
	}
}

// TestFetchPullRequests_FailedProviderErrorCarriedAsMetadata verifies that a
// failed provider's error is attached to every failed-provider observation's
// Error field (Item 7). The observer relies on this field to route rate-limit
// errors to per-provider cooldown.
func TestFetchPullRequests_FailedProviderErrorCarriedAsMetadata(t *testing.T) {
	fetchErr := errors.New("gitlab 503")
	gh := &fakeProvider{key: "github", parseOK: true}
	gl := &fakeProvider{key: "gitlab", parseOK: true, fetchErr: fetchErr}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	refs := []ports.SCMPRRef{
		{Repo: ports.SCMRepo{Provider: "github"}, Number: 10},
		{Repo: ports.SCMRepo{Provider: "gitlab"}, Number: 20},
		{Repo: ports.SCMRepo{Provider: "gitlab"}, Number: 21},
	}
	obs, err := m.FetchPullRequests(context.Background(), refs)
	if err != nil {
		t.Fatalf("error = %v, want nil (one healthy provider)", err)
	}
	// GitHub obs: healthy, no error metadata.
	if obs[0].Error != nil {
		t.Errorf("obs[0].Error = %v, want nil for healthy github observation", obs[0].Error)
	}
	// Both GitLab obs must carry the same failure error.
	if !errors.Is(obs[1].Error, fetchErr) {
		t.Errorf("obs[1].Error = %v, want gitlab failure %v", obs[1].Error, fetchErr)
	}
	if !errors.Is(obs[2].Error, fetchErr) {
		t.Errorf("obs[2].Error = %v, want gitlab failure %v", obs[2].Error, fetchErr)
	}
	if obs[1].Fetched || obs[2].Fetched {
		t.Errorf("failed-provider observations must be Fetched=false")
	}
	if obs[1].Provider != "gitlab" || obs[2].Provider != "gitlab" {
		t.Errorf("failed-provider observations must keep their provider key for cooldown routing")
	}
}

// TestSCMCredentialsAvailable_SurfacesFirstRealError (Item 8) verifies that when
// no provider reports usable credentials, the first real error is returned
// (not nil) so CheckCredentialsOnce retries on the next poll rather than
// definitively disabling SCM observation.
func TestSCMCredentialsAvailable_SurfacesFirstRealError(t *testing.T) {
	credErr := errors.New("github probe 503")
	gh := &fakeProvider{key: "github", credsAvailable: false, credsErr: credErr}
	gl := &fakeProvider{key: "gitlab", credsAvailable: false, credsErr: nil}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	avail, err := m.SCMCredentialsAvailable(context.Background())
	if avail {
		t.Errorf("want available=false when no provider has credentials")
	}
	if err == nil {
		t.Fatal("want the first real credential error, got nil (must not be discarded)")
	}
	if !errors.Is(err, credErr) {
		t.Errorf("err = %v, want the first provider's real error %v", err, credErr)
	}
}

// TestSCMCredentialsAvailable_HealthyProviderSuppressesError verifies that a
// healthy provider's success still wins even when another provider returned a
// transient credential error (the composite must report available=true, nil).
func TestSCMCredentialsAvailable_HealthyProviderSuppressesError(t *testing.T) {
	gh := &fakeProvider{key: "github", credsAvailable: false, credsErr: errors.New("github probe 503")}
	gl := &fakeProvider{key: "gitlab", credsAvailable: true, credsErr: nil}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	avail, err := m.SCMCredentialsAvailable(context.Background())
	if err != nil || !avail {
		t.Errorf("want (true, nil) when one provider is healthy, got (%v, %v)", avail, err)
	}
}

// TestFetchPullRequests_AllProvidersFail verifies that when ALL providers fail,
// an error is returned so the observer can mark repos as failed (review
// finding #5).
func TestFetchPullRequests_AllProvidersFail(t *testing.T) {
	gh := &fakeProvider{key: "github", parseOK: true, fetchErr: errors.New("github down")}
	gl := &fakeProvider{key: "gitlab", parseOK: true, fetchErr: errors.New("gitlab down")}
	m := New(NamedProvider{Key: "github", Provider: gh}, NamedProvider{Key: "gitlab", Provider: gl})

	refs := []ports.SCMPRRef{
		{Repo: ports.SCMRepo{Provider: "github"}, Number: 10},
		{Repo: ports.SCMRepo{Provider: "gitlab"}, Number: 20},
	}
	_, err := m.FetchPullRequests(context.Background(), refs)
	if err == nil {
		t.Fatal("expected error when all providers fail")
	}
}
