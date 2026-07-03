package jira

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestNew_RequiresCredentials(t *testing.T) {
	if _, err := New(Options{}); !errors.Is(err, ErrNoCredentials) {
		t.Fatalf("New without creds: %v, want ErrNoCredentials", err)
	}
	if _, err := New(Options{Credentials: StaticCredentials{Email: "", Token: "x"}}); !errors.Is(err, ErrNoCredentials) {
		t.Fatalf("New with missing email: %v, want ErrNoCredentials", err)
	}
}

func TestList_BuildsJQLAndDecodes(t *testing.T) {
	var capturedJQL string
	var capturedAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != searchPath {
			t.Errorf("path = %q, want %q", r.URL.Path, searchPath)
		}
		capturedJQL = r.URL.Query().Get("jql")
		capturedAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"issues":[{
		  "key":"ENG-1",
		  "fields":{
		    "summary":"first",
		    "description":"plain body",
		    "status":{"name":"To Do","statusCategory":{"key":"new","name":"To Do"}},
		    "labels":["agent-ready","bug"],
		    "assignee":{"accountId":"abc","displayName":"Alice","emailAddress":"alice@example.com"}
		  }
		}]}`))
	}))
	defer srv.Close()

	tracker, err := New(Options{Credentials: StaticCredentials{Email: "me@example.com", Token: "tok"}, HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	issues, err := tracker.List(context.Background(), domain.TrackerRepo{
		Provider: domain.TrackerProviderJira,
		Native:   "ENG",
		BaseURL:  srv.URL,
	}, domain.ListFilter{
		State:    domain.ListOpen,
		Labels:   []string{"agent-ready", `quote"trap`},
		Assignee: "Alice",
		Limit:    5,
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(issues) != 1 {
		t.Fatalf("got %d issues", len(issues))
	}
	got := issues[0]
	if got.ID.Provider != domain.TrackerProviderJira {
		t.Fatalf("provider = %q", got.ID.Provider)
	}
	if !strings.HasSuffix(got.URL, "/browse/ENG-1") {
		t.Fatalf("url = %q", got.URL)
	}
	if got.State != domain.IssueOpen {
		t.Fatalf("state = %q, want open", got.State)
	}
	if len(got.Labels) != 2 || got.Labels[0] != "agent-ready" {
		t.Fatalf("labels = %v", got.Labels)
	}
	if len(got.Assignees) != 1 || got.Assignees[0] != "Alice" {
		t.Fatalf("assignees = %v", got.Assignees)
	}
	if !strings.Contains(capturedJQL, `project = "ENG"`) {
		t.Fatalf("jql missing project: %q", capturedJQL)
	}
	if !strings.Contains(capturedJQL, "statusCategory != Done") {
		t.Fatalf("jql missing state filter: %q", capturedJQL)
	}
	if !strings.Contains(capturedJQL, `labels in ("agent-ready","quote\"trap")`) {
		t.Fatalf("jql labels malformed: %q", capturedJQL)
	}
	if !strings.HasPrefix(capturedAuth, "Basic ") {
		t.Fatalf("auth header = %q", capturedAuth)
	}
}

func TestList_RequiresBaseURL(t *testing.T) {
	tracker, _ := New(Options{Credentials: StaticCredentials{Email: "e", Token: "t"}})
	_, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderJira, Native: "ENG"}, domain.ListFilter{})
	if !errors.Is(err, ErrNoBaseURL) {
		t.Fatalf("expected ErrNoBaseURL, got %v", err)
	}
}

func TestList_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"nope"}`))
	}))
	defer srv.Close()
	tracker, _ := New(Options{Credentials: StaticCredentials{Email: "e", Token: "t"}, HTTPClient: srv.Client()})
	_, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderJira, Native: "ENG", BaseURL: srv.URL}, domain.ListFilter{})
	if !errors.Is(err, ErrAuthFailed) {
		t.Fatalf("expected ErrAuthFailed, got %v", err)
	}
}

func TestGet_BrowseURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, issuePath) {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"key":"ENG-7","fields":{
		  "summary":"hi",
		  "description":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"line one"}]}]},
		  "status":{"name":"In Progress","statusCategory":{"key":"indeterminate","name":"In Progress"}},
		  "labels":[],
		  "assignee":null
		}}`))
	}))
	defer srv.Close()
	tracker, _ := New(Options{Credentials: StaticCredentials{Email: "e", Token: "t"}, HTTPClient: srv.Client()})
	got, err := tracker.Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderJira,
		Native:   srv.URL + "/browse/ENG-7",
	})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.State != domain.IssueInProgress {
		t.Fatalf("state = %q, want in_progress", got.State)
	}
	if !strings.Contains(got.Body, "line one") {
		t.Fatalf("ADF flatten failed: %q", got.Body)
	}
}

func TestMapStateFromJira_Cancelled(t *testing.T) {
	if got := mapStateFromJira(jrStatus{Name: "Cancelled", StatusCategory: jrStatusCategory{Key: "done"}}); got != domain.IssueCancelled {
		t.Fatalf("got %q", got)
	}
	if got := mapStateFromJira(jrStatus{Name: "Won't Do", StatusCategory: jrStatusCategory{Key: "done"}}); got != domain.IssueCancelled {
		t.Fatalf("got %q", got)
	}
	if got := mapStateFromJira(jrStatus{Name: "Done", StatusCategory: jrStatusCategory{Key: "done"}}); got != domain.IssueDone {
		t.Fatalf("got %q", got)
	}
}

func TestNormalizeBaseURL(t *testing.T) {
	cases := map[string]string{
		"acme.atlassian.net":          "https://acme.atlassian.net",
		"https://acme.atlassian.net":  "https://acme.atlassian.net",
		"https://acme.atlassian.net/": "https://acme.atlassian.net",
		"":                            "",
	}
	for in, want := range cases {
		if got := normalizeBaseURL(in); got != want {
			t.Errorf("normalizeBaseURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWrongProvider(t *testing.T) {
	tracker, _ := New(Options{Credentials: StaticCredentials{Email: "e", Token: "t"}})
	_, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderGitHub, Native: "x"}, domain.ListFilter{})
	if !errors.Is(err, ErrWrongProvider) {
		t.Fatalf("expected ErrWrongProvider, got %v", err)
	}
	_, err = tracker.Get(context.Background(), domain.TrackerID{Provider: domain.TrackerProviderLinear, Native: "x"})
	if !errors.Is(err, ErrWrongProvider) {
		t.Fatalf("expected ErrWrongProvider, got %v", err)
	}
}
