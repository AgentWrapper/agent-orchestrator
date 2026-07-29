package linear

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type graphqlRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables"`
}

type fakeLinear struct {
	t        *testing.T
	server   *httptest.Server
	mu       sync.Mutex
	requests []graphqlRequest
	handler  func(http.ResponseWriter, *http.Request, graphqlRequest)
}

func newFakeLinear(t *testing.T, handler func(http.ResponseWriter, *http.Request, graphqlRequest)) *fakeLinear {
	t.Helper()
	f := &fakeLinear{t: t, handler: handler}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		var req graphqlRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Errorf("decode request: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.requests = append(f.requests, req)
		f.mu.Unlock()
		handler(w, r, req)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeLinear) tracker(t *testing.T) *Tracker {
	t.Helper()
	tracker, err := New(Options{APIKey: "lin-api-key", BaseURL: f.server.URL, HTTPClient: f.server.Client()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return tracker
}

func (f *fakeLinear) calls() []graphqlRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]graphqlRequest(nil), f.requests...)
}

func TestNewRequiresAPIKey(t *testing.T) {
	t.Setenv("AO_LINEAR_API_KEY", "")
	if _, err := New(Options{}); !errors.Is(err, ErrNoAPIKey) {
		t.Fatalf("New() error = %v, want ErrNoAPIKey", err)
	}
}

func TestPreflightLoadsEnvAPIKeyAndCachesSuccess(t *testing.T) {
	t.Setenv("AO_LINEAR_API_KEY", "lin-env-key")
	f := newFakeLinear(t, func(w http.ResponseWriter, r *http.Request, req graphqlRequest) {
		if got := r.Header.Get("Authorization"); got != "lin-env-key" {
			t.Errorf("Authorization = %q, want personal API key without Bearer", got)
		}
		if !strings.Contains(req.Query, "viewer") {
			t.Errorf("query = %q, want viewer preflight", req.Query)
		}
		_, _ = io.WriteString(w, `{"data":{"viewer":{"id":"user-id"}}}`)
	})
	tracker, err := New(Options{BaseURL: f.server.URL, HTTPClient: f.server.Client()})
	if err != nil {
		t.Fatal(err)
	}

	if err := tracker.Preflight(context.Background()); err != nil {
		t.Fatalf("Preflight: %v", err)
	}
	if err := tracker.Preflight(context.Background()); err != nil {
		t.Fatalf("cached Preflight: %v", err)
	}
	if got := len(f.calls()); got != 1 {
		t.Fatalf("preflight calls = %d, want 1", got)
	}
}

func TestGetNormalizesLinearIssue(t *testing.T) {
	f := newFakeLinear(t, func(w http.ResponseWriter, _ *http.Request, req graphqlRequest) {
		if req.Variables["id"] != "AO-17" {
			t.Errorf("id variable = %#v, want AO-17", req.Variables["id"])
		}
		_, _ = io.WriteString(w, `{"data":{"issue":{
			"id":"4f1be3d1-4c4d-4ad5-8e86-e71f2fb44be8",
			"identifier":"AO-17",
			"title":"Add Linear intake",
			"description":"Read-only issue context",
			"url":"https://linear.app/acme/issue/AO-17/add-linear-intake",
			"state":{"type":"started","name":"In Review"},
			"labels":{"nodes":[{"name":"Feature"},{"name":"agent-ready"}]},
			"assignee":{"name":"Alice"}
		}}}`)
	})

	got, err := f.tracker(t).Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderLinear,
		Native:   "AO-17",
	})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	want := domain.Issue{
		ID: domain.TrackerID{
			Provider: domain.TrackerProviderLinear,
			Native:   "4f1be3d1-4c4d-4ad5-8e86-e71f2fb44be8",
		},
		Title:     "Add Linear intake",
		Body:      "Read-only issue context",
		State:     domain.IssueInReview,
		URL:       "https://linear.app/acme/issue/AO-17/add-linear-intake",
		Labels:    []string{"Feature", "agent-ready"},
		Assignees: []string{"Alice"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("issue = %#v\nwant %#v", got, want)
	}
}

func TestListTeamScopePaginatesAndAppliesFilters(t *testing.T) {
	f := newFakeLinear(t, func(w http.ResponseWriter, _ *http.Request, req graphqlRequest) {
		if !strings.Contains(req.Query, "team(id: $scope)") {
			t.Errorf("query = %q, want team scope", req.Query)
		}
		if !strings.Contains(req.Query, "filter: $filter") {
			t.Errorf("query = %q, want server-side issue filter", req.Query)
		}
		if req.Variables["scope"] != "team-id" {
			t.Errorf("scope = %#v, want team-id", req.Variables["scope"])
		}
		wantFilter := map[string]any{
			"state": map[string]any{"type": map[string]any{"nin": []any{"completed", "canceled"}}},
			"assignee": map[string]any{
				"name": map[string]any{"eqIgnoreCase": "Alice"},
			},
			"and": []any{
				map[string]any{"labels": map[string]any{"name": map[string]any{"eqIgnoreCase": "agent-ready"}}},
			},
		}
		if got := req.Variables["filter"]; !reflect.DeepEqual(got, wantFilter) {
			t.Errorf("filter = %#v, want %#v", got, wantFilter)
		}
		if req.Variables["after"] == nil {
			_, _ = io.WriteString(w, `{"data":{"team":{"issues":{
				"nodes":[
					{"id":"issue-1","title":"Open","description":"","url":"https://linear.app/i/1","state":{"type":"unstarted","name":"Todo"},"labels":{"nodes":[{"name":"agent-ready"}]},"assignee":{"name":"Alice"}},
					{"id":"issue-2","title":"Done","description":"","url":"https://linear.app/i/2","state":{"type":"completed","name":"Done"},"labels":{"nodes":[]},"assignee":{"name":"Alice"}}
				],
				"pageInfo":{"hasNextPage":true,"endCursor":"next"}
			}}}}`)
			return
		}
		if req.Variables["after"] != "next" {
			t.Errorf("after = %#v, want next", req.Variables["after"])
		}
		_, _ = io.WriteString(w, `{"data":{"team":{"issues":{
			"nodes":[
				{"id":"issue-3","title":"Also open","description":"","url":"https://linear.app/i/3","state":{"type":"backlog","name":"Backlog"},"labels":{"nodes":[{"name":"agent-ready"}]},"assignee":{"name":"alice"}},
				{"id":"issue-4","title":"Wrong assignee","description":"","url":"https://linear.app/i/4","state":{"type":"unstarted","name":"Todo"},"labels":{"nodes":[{"name":"agent-ready"}]},"assignee":{"name":"Bob"}}
			],
			"pageInfo":{"hasNextPage":false,"endCursor":null}
		}}}}`)
	})

	issues, err := f.tracker(t).List(context.Background(), domain.TrackerScope{
		Provider: domain.TrackerProviderLinear,
		Native:   "team:team-id",
	}, domain.ListFilter{
		State:    domain.ListOpen,
		Labels:   []string{"agent-ready"},
		Assignee: "Alice",
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(issues) != 2 || issues[0].ID.Native != "issue-1" || issues[1].ID.Native != "issue-3" {
		t.Fatalf("issues = %#v, want issue-1 and issue-3", issues)
	}
	if got := len(f.calls()); got != 2 {
		t.Fatalf("calls = %d, want 2 pages", got)
	}
}

func TestListUsesProjectScope(t *testing.T) {
	f := newFakeLinear(t, func(w http.ResponseWriter, _ *http.Request, req graphqlRequest) {
		if !strings.Contains(req.Query, "project(id: $scope)") {
			t.Errorf("query = %q, want project scope", req.Query)
		}
		_, _ = io.WriteString(w, `{"data":{"project":{"issues":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}`)
	})
	if _, err := f.tracker(t).List(context.Background(), domain.TrackerScope{
		Provider: domain.TrackerProviderLinear,
		Native:   "project:project-id",
	}, domain.ListFilter{}); err != nil {
		t.Fatalf("List: %v", err)
	}
}

func TestListRejectsWrongProviderAndMalformedScope(t *testing.T) {
	f := newFakeLinear(t, func(http.ResponseWriter, *http.Request, graphqlRequest) {
		t.Fatal("invalid scope must not make an HTTP request")
	})
	tracker := f.tracker(t)
	if _, err := tracker.List(context.Background(), domain.TrackerScope{
		Provider: domain.TrackerProviderGitHub,
		Native:   "acme/demo",
	}, domain.ListFilter{}); !errors.Is(err, ErrWrongProvider) {
		t.Fatalf("wrong provider error = %v, want ErrWrongProvider", err)
	}
	if _, err := tracker.List(context.Background(), domain.TrackerScope{
		Provider: domain.TrackerProviderLinear,
		Native:   "workspace:workspace-id",
	}, domain.ListFilter{}); !errors.Is(err, ErrBadScope) {
		t.Fatalf("bad scope error = %v, want ErrBadScope", err)
	}
}

func TestGraphQLErrorsAreClassified(t *testing.T) {
	t.Run("invalid credentials", func(t *testing.T) {
		f := newFakeLinear(t, func(w http.ResponseWriter, _ *http.Request, _ graphqlRequest) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		})
		if err := f.tracker(t).Preflight(context.Background()); !errors.Is(err, ErrAuthFailed) {
			t.Fatalf("Preflight error = %v, want ErrAuthFailed", err)
		}
	})
	t.Run("graphql rate limited", func(t *testing.T) {
		f := newFakeLinear(t, func(w http.ResponseWriter, _ *http.Request, _ graphqlRequest) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"errors":[{"message":"Rate limit exceeded","extensions":{"code":"RATELIMITED"}}]}`)
		})
		if _, err := f.tracker(t).Get(context.Background(), domain.TrackerID{
			Provider: domain.TrackerProviderLinear,
			Native:   "AO-17",
		}); !errors.Is(err, ErrRateLimited) {
			t.Fatalf("Get error = %v, want ErrRateLimited", err)
		}
	})
	t.Run("graphql auth error", func(t *testing.T) {
		f := newFakeLinear(t, func(w http.ResponseWriter, _ *http.Request, _ graphqlRequest) {
			_, _ = io.WriteString(w, `{"errors":[{"message":"Authentication required"}]}`)
		})
		if err := f.tracker(t).Preflight(context.Background()); !errors.Is(err, ErrAuthFailed) {
			t.Fatalf("Preflight error = %v, want ErrAuthFailed", err)
		}
	})
}
