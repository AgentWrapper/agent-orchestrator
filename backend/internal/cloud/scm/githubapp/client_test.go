package githubapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGetInstallationUsesAppAuthentication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v3/app/installations/42" {
			http.Error(w, "unexpected route", http.StatusNotFound)
			return
		}
		assertGitHubHeaders(t, r)
		assertJWTAuthorization(t, r)
		_, _ = w.Write([]byte(`{
			"id":42,
			"node_id":"I_kwDO",
			"account":{"id":7,"login":"aoagents","type":"Organization"},
			"repository_selection":"selected",
			"target_type":"Organization"
		}`))
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, Config{})
	installation, err := client.GetInstallation(context.Background(), 42)
	if err != nil {
		t.Fatalf("GetInstallation: %v", err)
	}
	if installation.ID != 42 || installation.Account.ID != 7 ||
		installation.Account.Login != "aoagents" ||
		installation.RepositorySelection != "selected" {
		t.Fatalf("unexpected installation: %#v", installation)
	}
}

func TestMintInstallationTokenDownscopesRequest(t *testing.T) {
	const secretToken = "ghs_secret-installation-token"
	expiresAt := time.Date(2026, 8, 3, 13, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost ||
			r.URL.Path != "/api/v3/app/installations/42/access_tokens" {
			http.Error(w, "unexpected route", http.StatusNotFound)
			return
		}
		assertGitHubHeaders(t, r)
		assertJWTAuthorization(t, r)
		var input struct {
			RepositoryIDs []int64           `json:"repository_ids"`
			Permissions   map[string]string `json:"permissions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Errorf("decode request: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if len(input.RepositoryIDs) != 1 || input.RepositoryIDs[0] != 991 {
			t.Errorf("repository_ids = %#v, want [991]", input.RepositoryIDs)
		}
		wantPermissions := map[string]string{
			"checks":        "read",
			"contents":      "write",
			"issues":        "write",
			"pull_requests": "write",
		}
		if fmt.Sprint(input.Permissions) != fmt.Sprint(wantPermissions) {
			t.Errorf("permissions = %#v, want %#v", input.Permissions, wantPermissions)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":                secretToken,
			"expires_at":           expiresAt,
			"permissions":          wantPermissions,
			"repository_selection": "selected",
		})
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, Config{})
	token, err := client.MintInstallationToken(context.Background(), 42, 991, Permissions{
		"checks":        "read",
		"contents":      "write",
		"issues":        "write",
		"pull_requests": "write",
	})
	if err != nil {
		t.Fatalf("MintInstallationToken: %v", err)
	}
	if token.Token() != secretToken || !token.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("unexpected installation token metadata")
	}
	formatted := fmt.Sprintf("%s %+v %#v", token, token, token)
	if strings.Contains(formatted, secretToken) {
		t.Fatal("formatted InstallationToken exposed its credential")
	}
	encoded, err := json.Marshal(token)
	if err != nil {
		t.Fatalf("marshal InstallationToken: %v", err)
	}
	if strings.Contains(string(encoded), secretToken) {
		t.Fatal("JSON InstallationToken exposed its credential")
	}
}

func TestMintInstallationTokenRequiresOneRepositoryAndPermissions(t *testing.T) {
	client := newTestClient(t, "http://127.0.0.1:1", Config{})
	tests := []struct {
		name         string
		installation int64
		repository   int64
		permissions  Permissions
	}{
		{name: "installation", repository: 1, permissions: Permissions{"contents": "read"}},
		{name: "repository", installation: 1, permissions: Permissions{"contents": "read"}},
		{name: "permissions", installation: 1, repository: 1},
		{name: "permission level", installation: 1, repository: 1, permissions: Permissions{"contents": ""}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := client.MintInstallationToken(
				context.Background(),
				test.installation,
				test.repository,
				test.permissions,
			)
			if err == nil {
				t.Fatal("MintInstallationToken unexpectedly succeeded")
			}
		})
	}
}

func TestListInstallationRepositoriesPaginatesAndPreservesMetadata(t *testing.T) {
	var requests int
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path == "/api/v3/app/installations/42/access_tokens" {
			assertJWTAuthorization(t, r)
			var input struct {
				RepositoryIDs []int64           `json:"repository_ids"`
				Permissions   map[string]string `json:"permissions"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Errorf("decode repository-list token request: %v", err)
			}
			if len(input.RepositoryIDs) != 0 ||
				input.Permissions["metadata"] != "read" ||
				len(input.Permissions) != 1 {
				t.Errorf("repository-list token was not metadata-only: %#v", input)
			}
			_, _ = w.Write([]byte(`{
				"token":"ghs_installation",
				"expires_at":"2026-08-03T22:00:00Z",
				"permissions":{"metadata":"read"},
				"repository_selection":"selected"
			}`))
			return
		}
		if r.URL.Path != "/api/v3/installation/repositories" {
			http.Error(w, "unexpected route", http.StatusNotFound)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer ghs_installation" {
			t.Errorf("Authorization = %q", got)
		}
		assertGitHubHeaders(t, r)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Query().Get("page") {
		case "1":
			w.Header().Set(
				"Link",
				"<"+server.URL+"/api/v3/installation/repositories?per_page=100&page=2>; rel=\"next\"",
			)
			_, _ = w.Write([]byte(`{
				"total_count":3,
				"repositories":[
					{"id":101,"node_id":"R_101","name":"one","full_name":"ao/one","private":true,
					 "owner":{"id":9,"login":"ao"},"html_url":"https://github.com/ao/one",
					 "clone_url":"https://github.com/ao/one.git","default_branch":"main",
					 "visibility":"private","permissions":{"pull":true,"push":true}},
					{"id":102,"node_id":"R_102","name":"two","full_name":"ao/two","private":false,
					 "owner":{"id":9,"login":"ao"},"html_url":"https://github.com/ao/two",
					 "default_branch":"trunk","visibility":"public"}
				]
			}`))
		case "2":
			_, _ = w.Write([]byte(`{
				"total_count":3,
				"repositories":[
					{"id":103,"node_id":"R_103","name":"three","full_name":"ao/three",
					 "owner":{"id":9,"login":"ao"},"archived":true,"default_branch":"main"}
				]
			}`))
		default:
			http.Error(w, "unexpected page", http.StatusBadRequest)
		}
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, Config{})
	repositories, err := client.ListInstallationRepositories(
		context.Background(),
		42,
	)
	if err != nil {
		t.Fatalf("ListInstallationRepositories: %v", err)
	}
	if requests != 3 {
		t.Fatalf("requests = %d, want 3", requests)
	}
	if len(repositories) != 3 {
		t.Fatalf("repositories = %d, want 3", len(repositories))
	}
	if repositories[0].ID != 101 || repositories[0].NodeID != "R_101" ||
		repositories[0].FullName != "ao/one" || !repositories[0].Private ||
		repositories[0].Owner.ID != 9 || repositories[0].DefaultBranch != "main" ||
		!repositories[0].Permissions["push"] {
		t.Fatalf("first repository metadata lost: %#v", repositories[0])
	}
	if repositories[2].ID != 103 || !repositories[2].Archived {
		t.Fatalf("last repository metadata lost: %#v", repositories[2])
	}
}

func TestGenericInstallationRESTAndGraphQL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghs_operation" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		assertGitHubHeaders(t, r)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v3/repos/ao/repo/pulls/8/merge":
			if r.Method != http.MethodPut {
				t.Errorf("method = %s, want PUT", r.Method)
			}
			_, _ = w.Write([]byte(`{"merged":true,"sha":"abc123"}`))
		case "/api/graphql":
			if r.Method != http.MethodPost {
				t.Errorf("method = %s, want POST", r.Method)
			}
			_, _ = w.Write([]byte(`{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":true}}}}`))
		default:
			http.Error(w, "unexpected route", http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, Config{})
	token := InstallationToken{value: "ghs_operation"}
	var merge struct {
		Merged bool   `json:"merged"`
		SHA    string `json:"sha"`
	}
	if err := client.DoInstallationREST(
		context.Background(),
		token,
		http.MethodPut,
		"/repos/ao/repo/pulls/8/merge",
		map[string]string{"merge_method": "squash"},
		&merge,
	); err != nil {
		t.Fatalf("DoInstallationREST: %v", err)
	}
	if !merge.Merged || merge.SHA != "abc123" {
		t.Fatalf("unexpected merge response: %#v", merge)
	}

	var graph struct {
		Data struct {
			ResolveReviewThread struct {
				Thread struct {
					ID         string `json:"id"`
					IsResolved bool   `json:"isResolved"`
				} `json:"thread"`
			} `json:"resolveReviewThread"`
		} `json:"data"`
	}
	if err := client.DoInstallationGraphQL(
		context.Background(),
		token,
		`mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { id isResolved } } }`,
		map[string]any{"thread": "PRRT_1"},
		&graph,
	); err != nil {
		t.Fatalf("DoInstallationGraphQL: %v", err)
	}
	if graph.Data.ResolveReviewThread.Thread.ID != "PRRT_1" ||
		!graph.Data.ResolveReviewThread.Thread.IsResolved {
		t.Fatalf("unexpected GraphQL response: %#v", graph)
	}
}

func TestResponseAndErrorBodiesAreBounded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v3/error":
			w.Header().Set("X-GitHub-Request-Id", "request-123")
			http.Error(w, strings.Repeat("x", 256), http.StatusInternalServerError)
		case "/api/v3/oversized":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"value":"` + strings.Repeat("y", 256) + `"}`))
		default:
			http.Error(w, "unexpected route", http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, Config{
		MaxErrorBytes:    32,
		MaxResponseBytes: 32,
	})
	err := client.DoAppREST(context.Background(), http.MethodGet, "/error", nil, &struct{}{})
	var apiError *APIError
	if !errors.As(err, &apiError) {
		t.Fatalf("error = %T %v, want *APIError", err, err)
	}
	if !apiError.Truncated || len(apiError.Body) != 32 || apiError.RequestID != "request-123" {
		t.Fatalf("unexpected bounded API error: %#v", apiError)
	}

	err = client.DoAppREST(context.Background(), http.MethodGet, "/oversized", nil, &struct{}{})
	var tooLarge *ResponseTooLargeError
	if !errors.As(err, &tooLarge) || tooLarge.Limit != 32 {
		t.Fatalf("error = %T %v, want ResponseTooLargeError limit 32", err, err)
	}
}

func TestRequestTimeoutAppliesToInjectedHTTPClient(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, Config{
		HTTPClient:     server.Client(),
		RequestTimeout: 20 * time.Millisecond,
	})
	start := time.Now()
	err := client.DoAppREST(context.Background(), http.MethodGet, "/slow", nil, &struct{}{})
	if err == nil {
		t.Fatal("DoAppREST unexpectedly succeeded")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("request timeout took %s", elapsed)
	}
}

func TestGraphQLErrorsAreReturned(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":null,"errors":[{"type":"FORBIDDEN","message":"resource not accessible"}]}`))
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, Config{})
	err := client.DoInstallationGraphQL(
		context.Background(),
		InstallationToken{value: "ghs_operation"},
		"query { viewer { login } }",
		nil,
		&struct{}{},
	)
	var graphError *GraphQLResponseError
	if !errors.As(err, &graphError) || len(graphError.Errors) != 1 ||
		graphError.Errors[0].Type != "FORBIDDEN" {
		t.Fatalf("error = %T %v, want GraphQLResponseError", err, err)
	}
}

func newTestClient(t *testing.T, serverURL string, override Config) *Client {
	t.Helper()
	_, encoded := testRSAKey(t)
	config := override
	config.ClientID = "Iv1.test-client"
	config.PrivateKeyPEM = encoded
	config.APIBaseURL = serverURL + "/api/v3"
	config.GraphQLURL = serverURL + "/api/graphql"
	client, err := New(config)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return client
}

func assertGitHubHeaders(t *testing.T, r *http.Request) {
	t.Helper()
	if got := r.Header.Get("Accept"); got != "application/vnd.github+json" {
		t.Errorf("Accept = %q", got)
	}
	if got := r.Header.Get("X-GitHub-Api-Version"); got != APIVersion {
		t.Errorf("X-GitHub-Api-Version = %q", got)
	}
	if got := r.Header.Get("User-Agent"); got != "agent-orchestrator" {
		t.Errorf("User-Agent = %q", got)
	}
}

func assertJWTAuthorization(t *testing.T, r *http.Request) {
	t.Helper()
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") ||
		len(strings.Split(strings.TrimPrefix(authorization, "Bearer "), ".")) != 3 {
		t.Errorf("Authorization does not contain a Bearer JWT")
	}
}
