package scmregistry

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/scmconnection"
)

type gitLabFactoryToken string

func (s gitLabFactoryToken) Token(context.Context) (string, error) { return string(s), nil }

func TestGitLabFactoryBuildsCurrentBundle(t *testing.T) {
	bundle, err := NewGitLabFactory(GitLabFactoryOptions{}).Build(context.Background(), FactoryConfig{
		ConnectionID: "gitlab-work",
		Provider:     domain.SCMProviderGitLab,
		WebBaseURL:   "https://gitlab.example.com",
		APIBaseURL:   "https://gitlab.example.com/api/v4",
		Token:        gitLabFactoryToken("test-token"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if bundle.SCM == nil || bundle.Tracker == nil {
		t.Fatalf("GitLab bundle = %#v", bundle)
	}
	if bundle.Writer != nil {
		t.Fatalf("GitLab writer landed before the provider-neutral writer path: %#v", bundle.Writer)
	}
}

func TestGitLabFactoryTestsNestedRepositoryCapabilities(t *testing.T) {
	var tokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokens = append(tokens, r.Header.Get("PRIVATE-TOKEN"))
		switch r.URL.EscapedPath() {
		case "/user":
			_, _ = w.Write([]byte(`{"username":"alice","name":"Alice Example"}`))
		case "/projects/group%2Fsubgroup%2Frepo":
			_, _ = w.Write([]byte(`{"permissions":{"project_access":{"access_level":30}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	result, err := NewGitLabFactory(GitLabFactoryOptions{HTTPClient: server.Client()}).Test(
		context.Background(),
		scmconnection.ConnectionTestConfig{
			ID: "gitlab-work", Provider: domain.SCMProviderGitLab,
			WebBaseURL: server.URL, APIBaseURL: server.URL, Repository: "group/subgroup/repo.git",
		},
		[]byte("gitlab-test-token"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 2 || tokens[0] != "gitlab-test-token" || tokens[1] != "gitlab-test-token" {
		t.Fatalf("PRIVATE-TOKEN = %v", tokens)
	}
	if result.Status != scmconnection.StatusConnected || result.Identity.Username != "alice" || result.Identity.DisplayName != "Alice Example" {
		t.Fatalf("result = %#v", result)
	}
	if !result.Capabilities.Read || !result.Capabilities.Write {
		t.Fatalf("capabilities = %#v", result.Capabilities)
	}
}

func TestGitLabFactoryTestsRepositoryCapabilities(t *testing.T) {
	for _, tc := range []struct {
		name       string
		repoStatus int
		repoBody   string
		wantKind   scmconnection.TestFailureKind
	}{
		{name: "write scope missing", repoStatus: http.StatusOK, repoBody: `{"permissions":{"project_access":{"access_level":20}}}`, wantKind: scmconnection.TestFailureWriteScopeMissing},
		{name: "repository missing", repoStatus: http.StatusNotFound, repoBody: `{}`, wantKind: scmconnection.TestFailureRepoNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/user" {
					_, _ = w.Write([]byte(`{"username":"alice"}`))
					return
				}
				w.WriteHeader(tc.repoStatus)
				_, _ = w.Write([]byte(tc.repoBody))
			}))
			t.Cleanup(server.Close)

			result, err := NewGitLabFactory(GitLabFactoryOptions{HTTPClient: server.Client()}).Test(
				context.Background(),
				scmconnection.ConnectionTestConfig{
					ID: "gitlab-work", Provider: domain.SCMProviderGitLab,
					WebBaseURL: server.URL, APIBaseURL: server.URL, Repository: "group/repo",
				},
				[]byte("token"),
			)
			var failure *scmconnection.TestFailure
			if !errors.As(err, &failure) || failure.Kind != tc.wantKind {
				t.Fatalf("error = %v, result = %#v", err, result)
			}
			if result.Status != scmconnection.StatusConnected || result.Identity.Username != "alice" || result.Capabilities.Write {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}

func TestGitLabFactoryClassifiesConnectionFailures(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		wantKind scmconnection.TestFailureKind
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, wantKind: scmconnection.TestFailureAuth},
		{name: "forbidden", status: http.StatusForbidden, wantKind: scmconnection.TestFailureForbidden},
		{name: "rate limited", status: http.StatusTooManyRequests, wantKind: scmconnection.TestFailureRateLimited},
		{name: "server failure", status: http.StatusInternalServerError, wantKind: scmconnection.TestFailureUnreachable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"message":"must stay private"}`))
			}))
			t.Cleanup(server.Close)

			_, err := NewGitLabFactory(GitLabFactoryOptions{HTTPClient: server.Client()}).Test(
				context.Background(),
				scmconnection.ConnectionTestConfig{
					ID: "gitlab-work", Provider: domain.SCMProviderGitLab,
					WebBaseURL: server.URL, APIBaseURL: server.URL, Repository: "group/repo",
				},
				[]byte("secret-token"),
			)
			var failure *scmconnection.TestFailure
			if !errors.As(err, &failure) || failure.Kind != tc.wantKind {
				t.Fatalf("error = %v", err)
			}
			if strings.Contains(err.Error(), "secret-token") || strings.Contains(err.Error(), "must stay private") {
				t.Fatalf("connection test leaked provider data: %v", err)
			}
		})
	}
}

func TestGitLabFactoryClassifiesTLSFailure(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(server.Close)

	_, err := NewGitLabFactory(GitLabFactoryOptions{}).Test(context.Background(), scmconnection.ConnectionTestConfig{
		ID: "gitlab-work", Provider: domain.SCMProviderGitLab,
		WebBaseURL: server.URL, APIBaseURL: server.URL, Repository: "group/repo",
	}, []byte("token"))
	var failure *scmconnection.TestFailure
	if !errors.As(err, &failure) || failure.Kind != scmconnection.TestFailureTLS {
		t.Fatalf("error = %v", err)
	}
}
