package scmregistry

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/scmconnection"
)

type fakeConnectionStore struct {
	connections map[string]domain.SCMConnection
	calls       []string
}

func (f *fakeConnectionStore) GetSCMConnection(_ context.Context, id string) (domain.SCMConnection, bool, error) {
	f.calls = append(f.calls, id)
	connection, ok := f.connections[id]
	return connection, ok, nil
}

type fakeCredentials struct {
	secrets map[string][]byte
	gets    []string
	err     error
}

func (f *fakeCredentials) Put(context.Context, string, []byte) error { return nil }
func (f *fakeCredentials) Delete(context.Context, string) error      { return nil }
func (f *fakeCredentials) Get(_ context.Context, ref string) ([]byte, bool, error) {
	f.gets = append(f.gets, ref)
	if f.err != nil {
		return nil, false, f.err
	}
	secret, ok := f.secrets[ref]
	return append([]byte(nil), secret...), ok, nil
}

type stubSCM struct{ id string }

func (*stubSCM) ParseRepository(string) (ports.SCMRepo, bool) { return ports.SCMRepo{}, false }
func (*stubSCM) RepoPRListGuard(context.Context, ports.SCMRepo, string) (ports.SCMGuardResult, error) {
	return ports.SCMGuardResult{}, nil
}
func (*stubSCM) ListOpenPRsByRepo(context.Context, ports.SCMRepo) ([]ports.SCMPRObservation, error) {
	return nil, nil
}
func (*stubSCM) CommitChecksGuard(context.Context, ports.SCMRepo, string, string) (ports.SCMGuardResult, error) {
	return ports.SCMGuardResult{}, nil
}
func (*stubSCM) FetchPullRequests(context.Context, []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	return nil, nil
}
func (*stubSCM) FetchFailedCheckLogTail(context.Context, ports.SCMRepo, ports.SCMCheckObservation) (string, error) {
	return "", nil
}
func (*stubSCM) FetchReviewThreads(context.Context, ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	return ports.SCMReviewObservation{}, nil
}

type stubTracker struct{ id string }

func (*stubTracker) Get(context.Context, domain.TrackerID) (domain.Issue, error) {
	return domain.Issue{}, nil
}
func (*stubTracker) List(context.Context, domain.TrackerRepo, domain.ListFilter) ([]domain.Issue, error) {
	return nil, nil
}
func (*stubTracker) Preflight(context.Context) error { return nil }

type stubWriter struct{ id string }

func (*stubWriter) WriteSCMObservation(context.Context, domain.PullRequest, []domain.PullRequestCheck, []domain.PullRequestReview, []domain.PullRequestReviewThread, []domain.PullRequestComment, ports.ReviewWriteMode) error {
	return nil
}

type fakeFactory struct {
	builds []FactoryConfig
	tests  []scmconnection.ConnectionTestConfig
	tokens []string
}

func (f *fakeFactory) Build(ctx context.Context, cfg FactoryConfig) (ProviderBundle, error) {
	token, err := cfg.Token.Token(ctx)
	if err != nil {
		return ProviderBundle{}, err
	}
	f.builds = append(f.builds, cfg)
	f.tokens = append(f.tokens, token)
	id := fmt.Sprintf("%s-%d", cfg.ConnectionID, len(f.builds))
	return ProviderBundle{SCM: &stubSCM{id: id}, Tracker: &stubTracker{id: id}, Writer: &stubWriter{id: id}}, nil
}

func (f *fakeFactory) Test(_ context.Context, cfg scmconnection.ConnectionTestConfig, token []byte) (scmconnection.TestResult, error) {
	f.tests = append(f.tests, cfg)
	f.tokens = append(f.tokens, string(token))
	return scmconnection.TestResult{Status: scmconnection.StatusConnected, Identity: scmconnection.Identity{Username: "alice"}, Capabilities: scmconnection.Capabilities{Read: true}}, nil
}

type staticTokenSource struct {
	token string
	err   error
	calls int
}

func (s *staticTokenSource) Token(context.Context) (string, error) {
	s.calls++
	return s.token, s.err
}

func TestResolverLegacyProjectUsesVirtualGitHubDefault(t *testing.T) {
	store := &fakeConnectionStore{connections: map[string]domain.SCMConnection{}}
	factory := &fakeFactory{}
	gh := &staticTokenSource{token: "gh-cli-token"}
	r := New(Deps{
		Connections: store,
		Credentials: &fakeCredentials{},
		Factories:   map[domain.SCMProvider]ProviderFactory{domain.SCMProviderGitHub: factory},
		LookupEnv: func(string) string {
			return ""
		},
		GitHubFallback: gh,
	})

	bundle, err := r.Resolve(context.Background(), domain.ProjectRecord{ID: "legacy"})
	if err != nil {
		t.Fatal(err)
	}
	if bundle.SCM == nil || bundle.Tracker == nil || bundle.Writer == nil {
		t.Fatalf("bundle = %#v", bundle)
	}
	if len(store.calls) != 0 {
		t.Fatalf("virtual default queried connection store: %v", store.calls)
	}
	if len(factory.builds) != 1 || factory.builds[0].ConnectionID != "github-default" || factory.builds[0].Provider != domain.SCMProviderGitHub {
		t.Fatalf("factory configs = %#v", factory.builds)
	}
	if factory.tokens[0] != "gh-cli-token" || gh.calls != 1 {
		t.Fatalf("tokens = %v fallback calls = %d", factory.tokens, gh.calls)
	}
}

func TestResolverLegacyProjectClassifiesMissingGitHubFallbackCredential(t *testing.T) {
	r := New(Deps{
		Factories: map[domain.SCMProvider]ProviderFactory{
			domain.SCMProviderGitHub: &fakeFactory{},
		},
		LookupEnv:      func(string) string { return "" },
		GitHubFallback: scmgithub.StaticTokenSource(""),
	})

	_, err := r.Resolve(context.Background(), domain.ProjectRecord{})
	if !errors.Is(err, ErrMissingCredential) {
		t.Fatalf("Resolve error = %v, want ErrMissingCredential", err)
	}
}

func TestResolverSelectsExplicitProjectConnectionAndRejectsMismatch(t *testing.T) {
	updated := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	store := &fakeConnectionStore{connections: map[string]domain.SCMConnection{
		"github-work": {ID: "github-work", Provider: domain.SCMProviderGitHub, APIBaseURL: "https://api.github.example", CredentialRef: "secret/github-work", UpdatedAt: updated},
		"gitlab-work": {ID: "gitlab-work", Provider: domain.SCMProviderGitLab, APIBaseURL: "https://gitlab.example/api/v4", CredentialRef: "secret/gitlab-work", UpdatedAt: updated},
	}}
	creds := &fakeCredentials{secrets: map[string][]byte{"secret/github-work": []byte("github-secret"), "secret/gitlab-work": []byte("gitlab-secret")}}
	githubFactory, gitlabFactory := &fakeFactory{}, &fakeFactory{}
	r := New(Deps{Connections: store, Credentials: creds, Factories: map[domain.SCMProvider]ProviderFactory{
		domain.SCMProviderGitHub: githubFactory,
		domain.SCMProviderGitLab: gitlabFactory,
	}, LookupEnv: func(string) string { return "" }})

	for _, cfg := range []domain.SCMProjectConfig{
		{Provider: domain.SCMProviderGitHub, ConnectionID: "github-work"},
		{Provider: domain.SCMProviderGitLab, ConnectionID: "gitlab-work"},
	} {
		if _, err := r.Resolve(context.Background(), domain.ProjectRecord{Config: domain.ProjectConfig{SCM: cfg}}); err != nil {
			t.Fatalf("Resolve(%#v): %v", cfg, err)
		}
	}
	if len(githubFactory.builds) != 1 || len(gitlabFactory.builds) != 1 {
		t.Fatalf("build counts github=%d gitlab=%d", len(githubFactory.builds), len(gitlabFactory.builds))
	}
	if githubFactory.tokens[0] != "github-secret" || gitlabFactory.tokens[0] != "gitlab-secret" {
		t.Fatalf("factory tokens github=%v gitlab=%v", githubFactory.tokens, gitlabFactory.tokens)
	}

	_, err := r.Resolve(context.Background(), domain.ProjectRecord{Config: domain.ProjectConfig{SCM: domain.SCMProjectConfig{Provider: domain.SCMProviderGitHub, ConnectionID: "gitlab-work"}}})
	if !errors.Is(err, ErrProviderMismatch) {
		t.Fatalf("mismatch error = %v", err)
	}
}

func TestResolverCachesIndependentlyAndInvalidatesOnlyOnMetadataVersion(t *testing.T) {
	v1 := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	store := &fakeConnectionStore{connections: map[string]domain.SCMConnection{
		"one": {ID: "one", Provider: domain.SCMProviderGitHub, CredentialRef: "secret/one", UpdatedAt: v1},
		"two": {ID: "two", Provider: domain.SCMProviderGitHub, CredentialRef: "secret/two", UpdatedAt: v1},
	}}
	factory := &fakeFactory{}
	r := New(Deps{
		Connections: store,
		Credentials: &fakeCredentials{secrets: map[string][]byte{"secret/one": []byte("one"), "secret/two": []byte("two")}},
		Factories:   map[domain.SCMProvider]ProviderFactory{domain.SCMProviderGitHub: factory},
		LookupEnv:   func(string) string { return "" },
	})
	project := func(id string) domain.ProjectRecord {
		return domain.ProjectRecord{Config: domain.ProjectConfig{SCM: domain.SCMProjectConfig{Provider: domain.SCMProviderGitHub, ConnectionID: id}}}
	}

	oneV1, err := r.Resolve(context.Background(), project("one"))
	if err != nil {
		t.Fatal(err)
	}
	twoV1, err := r.Resolve(context.Background(), project("two"))
	if err != nil {
		t.Fatal(err)
	}
	oneValidationOnly, err := r.Resolve(context.Background(), project("one"))
	if err != nil {
		t.Fatal(err)
	}
	if oneValidationOnly.SCM != oneV1.SCM || len(factory.builds) != 2 {
		t.Fatalf("validation-only read rebuilt bundle: same=%v builds=%d", oneValidationOnly.SCM == oneV1.SCM, len(factory.builds))
	}

	one := store.connections["one"]
	one.UpdatedAt = v1.Add(time.Second)
	store.connections["one"] = one
	oneV2, err := r.Resolve(context.Background(), project("one"))
	if err != nil {
		t.Fatal(err)
	}
	twoAgain, err := r.Resolve(context.Background(), project("two"))
	if err != nil {
		t.Fatal(err)
	}
	if oneV2.SCM == oneV1.SCM || twoAgain.SCM != twoV1.SCM || len(factory.builds) != 3 {
		t.Fatalf("cache invalidation wrong: one rebuilt=%v two stable=%v builds=%d", oneV2.SCM != oneV1.SCM, twoAgain.SCM == twoV1.SCM, len(factory.builds))
	}
}

func TestResolverCredentialPrecedenceAndRedactedFailures(t *testing.T) {
	connection := domain.SCMConnection{ID: "gitlab-work", Provider: domain.SCMProviderGitLab, CredentialRef: "vault/ref", UpdatedAt: time.Now()}
	project := domain.ProjectRecord{Config: domain.ProjectConfig{SCM: domain.SCMProjectConfig{Provider: domain.SCMProviderGitLab, ConnectionID: connection.ID}}}
	for _, tc := range []struct {
		name      string
		env       string
		vault     string
		vaultErr  error
		wantToken string
		wantErr   bool
	}{
		{name: "environment overrides vault", env: "env-token", vault: "vault-token", wantToken: "env-token"},
		{name: "vault fallback", vault: "vault-token", wantToken: "vault-token"},
		{name: "missing", wantErr: true},
		{name: "vault error", vaultErr: errors.New("vault failed with leaked-token"), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			factory := &fakeFactory{}
			r := New(Deps{
				Connections: &fakeConnectionStore{connections: map[string]domain.SCMConnection{connection.ID: connection}},
				Credentials: &fakeCredentials{secrets: map[string][]byte{"vault/ref": []byte(tc.vault)}, err: tc.vaultErr},
				Factories:   map[domain.SCMProvider]ProviderFactory{domain.SCMProviderGitLab: factory},
				LookupEnv: func(name string) string {
					if name == "AO_GITLAB_TOKEN" {
						return tc.env
					}
					return ""
				},
			})
			_, err := r.Resolve(context.Background(), project)
			if tc.wantErr {
				if !errors.Is(err, ErrMissingCredential) && !errors.Is(err, ErrCredentialUnavailable) {
					t.Fatalf("error = %v", err)
				}
				if err != nil && (strings.Contains(err.Error(), "leaked-token") || strings.Contains(err.Error(), "vault/ref")) {
					t.Fatalf("error leaked credential detail: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(factory.tokens) != 1 || factory.tokens[0] != tc.wantToken {
				t.Fatalf("tokens = %v, want %q", factory.tokens, tc.wantToken)
			}
		})
	}
}

func TestResolverUnavailableProviderAndConnectionTesterDispatch(t *testing.T) {
	githubFactory := &fakeFactory{}
	r := New(Deps{Factories: map[domain.SCMProvider]ProviderFactory{domain.SCMProviderGitHub: githubFactory}})
	_, err := r.Resolve(context.Background(), domain.ProjectRecord{Config: domain.ProjectConfig{SCM: domain.SCMProjectConfig{Provider: domain.SCMProviderGitLab, ConnectionID: "gitlab-work"}}})
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("unavailable error = %v", err)
	}

	cfg := scmconnection.ConnectionTestConfig{ID: "github-work", Provider: domain.SCMProviderGitHub, WebBaseURL: "https://github.com", APIBaseURL: "https://api.github.com"}
	result, err := r.Test(context.Background(), cfg, []byte("test-token"))
	if err != nil || result.Status != scmconnection.StatusConnected {
		t.Fatalf("Test = (%#v, %v)", result, err)
	}
	if len(githubFactory.tests) != 1 || githubFactory.tests[0] != cfg || githubFactory.tokens[0] != "test-token" {
		t.Fatalf("tester dispatch configs=%#v tokens=%v", githubFactory.tests, githubFactory.tokens)
	}
}

func TestGitHubFactoryBuildIsLazyAndReturnsCurrentBundle(t *testing.T) {
	fallback := &staticTokenSource{err: ErrMissingCredential}
	r := New(Deps{
		Factories:               map[domain.SCMProvider]ProviderFactory{domain.SCMProviderGitHub: NewGitHubFactory(GitHubFactoryOptions{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})},
		LookupEnv:               func(string) string { return "" },
		GitHubFallback:          fallback,
		SkipCredentialPreflight: true,
	})
	bundle, err := r.Resolve(context.Background(), domain.ProjectRecord{})
	if err != nil {
		t.Fatal(err)
	}
	if bundle.SCM == nil || bundle.Tracker == nil {
		t.Fatalf("GitHub bundle = %#v", bundle)
	}
	if bundle.Writer != nil {
		t.Fatalf("GitHub writer landed before action writer task: %#v", bundle.Writer)
	}
	if fallback.calls != 0 {
		t.Fatalf("lazy build resolved fallback %d times", fallback.calls)
	}
}

func TestGitHubFactoryTestsConnection(t *testing.T) {
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		if r.URL.Path != "/user" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-OAuth-Scopes", "repo, read:org")
		_, _ = w.Write([]byte(`{"login":"alice","name":"Alice Example"}`))
	}))
	t.Cleanup(server.Close)

	factory := NewGitHubFactory(GitHubFactoryOptions{HTTPClient: server.Client()})
	result, err := factory.Test(context.Background(), scmconnection.ConnectionTestConfig{
		ID: "github-work", Provider: domain.SCMProviderGitHub,
		WebBaseURL: "https://github.example", APIBaseURL: server.URL,
	}, []byte("github-test-token"))
	if err != nil {
		t.Fatal(err)
	}
	if authorization != "Bearer github-test-token" {
		t.Fatalf("Authorization = %q", authorization)
	}
	if result.Status != scmconnection.StatusConnected || result.Identity.Username != "alice" || result.Identity.DisplayName != "Alice Example" {
		t.Fatalf("result = %#v", result)
	}
	if !result.Capabilities.Read || !result.Capabilities.Write {
		t.Fatalf("capabilities = %#v", result.Capabilities)
	}
}

func TestGitHubFactoryTestFailureIsRedacted(t *testing.T) {
	secret := "github-test-token"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "provider echoed "+secret, http.StatusUnauthorized)
	}))
	t.Cleanup(server.Close)

	factory := NewGitHubFactory(GitHubFactoryOptions{HTTPClient: server.Client()})
	_, err := factory.Test(context.Background(), scmconnection.ConnectionTestConfig{
		ID: "github-work", Provider: domain.SCMProviderGitHub, APIBaseURL: server.URL,
	}, []byte(secret))
	var failure *scmconnection.TestFailure
	if !errors.As(err, &failure) || failure.Kind != scmconnection.TestFailureAuth {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "echoed") {
		t.Fatalf("error leaked provider response: %v", err)
	}
}

var _ scm.Provider = (*stubSCM)(nil)
var _ ports.Tracker = (*stubTracker)(nil)
var _ ports.SCMWriter = (*stubWriter)(nil)
