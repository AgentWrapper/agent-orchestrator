package linear

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestNew_RequiresToken(t *testing.T) {
	if _, err := New(Options{}); !errors.Is(err, ErrNoToken) {
		t.Fatalf("New without token: %v, want ErrNoToken", err)
	}
	if _, err := New(Options{Token: StaticTokenSource("  ")}); !errors.Is(err, ErrNoToken) {
		t.Fatalf("New with blank token: %v, want ErrNoToken", err)
	}
}

func TestList_BuildsFilter(t *testing.T) {
	var captured struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		if got := r.Header.Get("Authorization"); got != "lin_api_test" {
			t.Errorf("Authorization = %q, want %q", got, "lin_api_test")
		}
		_, _ = w.Write([]byte(`{"data":{"issues":{"nodes":[
		  {"identifier":"ENG-1","title":"first","description":"body","url":"https://linear.app/x/issue/ENG-1",
		   "state":{"type":"backlog","name":"Backlog"},
		   "labels":{"nodes":[{"name":"agent-ready"}]},
		   "assignee":{"displayName":"Alice","name":"alice"},
		   "assignees":{"nodes":[]}}
		]}}}`))
	}))
	defer srv.Close()

	tracker, err := New(Options{Token: StaticTokenSource("lin_api_test"), BaseURL: srv.URL, HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	issues, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderLinear, Native: "ENG"}, domain.ListFilter{
		State:    domain.ListOpen,
		Labels:   []string{"agent-ready"},
		Assignee: "Alice",
		Limit:    5,
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got, want := len(issues), 1; got != want {
		t.Fatalf("len(issues) = %d, want %d", got, want)
	}
	got := issues[0]
	if got.ID.Provider != domain.TrackerProviderLinear || got.ID.Native != "ENG-1" {
		t.Fatalf("issue ID = %+v", got.ID)
	}
	if got.State != domain.IssueOpen {
		t.Fatalf("state = %q, want open", got.State)
	}
	if got.URL != "https://linear.app/x/issue/ENG-1" {
		t.Fatalf("url = %q", got.URL)
	}
	if len(got.Labels) != 1 || got.Labels[0] != "agent-ready" {
		t.Fatalf("labels = %v", got.Labels)
	}
	if len(got.Assignees) != 1 || got.Assignees[0] != "Alice" {
		t.Fatalf("assignees = %v", got.Assignees)
	}

	// Verify the GraphQL filter we built.
	filter, ok := captured.Variables["filter"].(map[string]any)
	if !ok {
		t.Fatalf("filter not present in variables: %+v", captured.Variables)
	}
	team, ok := filter["team"].(map[string]any)
	if !ok {
		t.Fatalf("team filter missing: %+v", filter)
	}
	if !strings.Contains(asJSON(t, team), "ENG") {
		t.Fatalf("team filter lacks ENG: %s", asJSON(t, team))
	}
	if _, ok := filter["state"]; !ok {
		t.Fatalf("state filter missing")
	}
	if _, ok := filter["labels"]; !ok {
		t.Fatalf("labels filter missing")
	}
	if _, ok := filter["assignee"]; !ok {
		t.Fatalf("assignee filter missing")
	}
	if first, _ := captured.Variables["first"].(float64); first != 5 {
		t.Fatalf("first = %v, want 5", captured.Variables["first"])
	}
}

func TestList_AssigneeWildcardOmitsFilter(t *testing.T) {
	var captured struct {
		Variables map[string]any `json:"variables"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		_, _ = w.Write([]byte(`{"data":{"issues":{"nodes":[]}}}`))
	}))
	defer srv.Close()

	tracker, _ := New(Options{Token: StaticTokenSource("t"), BaseURL: srv.URL, HTTPClient: srv.Client()})
	_, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderLinear, Native: "ENG"}, domain.ListFilter{
		Assignee: "*",
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	filter, _ := captured.Variables["filter"].(map[string]any)
	if _, has := filter["assignee"]; has {
		t.Fatalf("assignee filter should be omitted for wildcard, got: %v", filter["assignee"])
	}
}

func TestGet_HappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"issue":{
		  "identifier":"ENG-7","title":"hello","description":"body","url":"https://linear.app/x/issue/ENG-7",
		  "state":{"type":"started","name":"In Progress"},
		  "labels":{"nodes":[]},
		  "assignee":null,
		  "assignees":{"nodes":[]}
		}}}`))
	}))
	defer srv.Close()
	tracker, _ := New(Options{Token: StaticTokenSource("t"), BaseURL: srv.URL, HTTPClient: srv.Client()})
	got, err := tracker.Get(context.Background(), domain.TrackerID{Provider: domain.TrackerProviderLinear, Native: "ENG-7"})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.State != domain.IssueInProgress {
		t.Fatalf("state = %q, want in_progress", got.State)
	}
}

func TestGet_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"issue":null}}`))
	}))
	defer srv.Close()
	tracker, _ := New(Options{Token: StaticTokenSource("t"), BaseURL: srv.URL, HTTPClient: srv.Client()})
	_, err := tracker.Get(context.Background(), domain.TrackerID{Provider: domain.TrackerProviderLinear, Native: "ENG-404"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestQuery_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer srv.Close()
	tracker, _ := New(Options{Token: StaticTokenSource("t"), BaseURL: srv.URL, HTTPClient: srv.Client()})
	_, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderLinear, Native: "ENG"}, domain.ListFilter{})
	if !errors.Is(err, ErrAuthFailed) {
		t.Fatalf("expected ErrAuthFailed, got %v", err)
	}
}

func TestWrongProvider(t *testing.T) {
	tracker, _ := New(Options{Token: StaticTokenSource("t"), BaseURL: "http://invalid"})
	_, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderGitHub, Native: "acme/x"}, domain.ListFilter{})
	if !errors.Is(err, ErrWrongProvider) {
		t.Fatalf("expected ErrWrongProvider, got %v", err)
	}
	_, err = tracker.Get(context.Background(), domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/x#1"})
	if !errors.Is(err, ErrWrongProvider) {
		t.Fatalf("expected ErrWrongProvider for Get, got %v", err)
	}
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
