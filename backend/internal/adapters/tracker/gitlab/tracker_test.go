package gitlab

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	scmgitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/gitlab"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestGetMapsIssueAndCanonicalIDRoundTrips(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.EscapedPath())
		mu.Unlock()
		_, _ = w.Write([]byte(`{
			"iid":42,
			"title":"Fix intake",
			"description":"Issue body",
			"state":"opened",
			"web_url":"https://gitlab.example/group/subgroup/project/-/issues/42",
			"labels":["bug","in-progress"],
			"assignees":[{"username":"alice"},{"username":"bob"}],
			"confidential":true
		}`))
	}))
	defer server.Close()

	tracker := newTrackerForTest(t, server)
	id := domain.TrackerID{
		Provider: domain.TrackerProviderGitLab,
		Native:   tracker.host + "/group/subgroup/project#!42",
	}
	issue, err := tracker.Get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	want := domain.Issue{
		ID:        id,
		Title:     "Fix intake",
		Body:      "Issue body",
		State:     domain.IssueInProgress,
		URL:       "https://gitlab.example/group/subgroup/project/-/issues/42",
		Labels:    []string{"bug", "in-progress"},
		Assignees: []string{"alice", "bob"},
	}
	if !reflect.DeepEqual(issue, want) {
		t.Fatalf("issue = %#v\nwant %#v", issue, want)
	}

	if _, err := tracker.Get(context.Background(), issue.ID); err != nil {
		t.Fatalf("round-trip Get: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	wantPath := "/projects/group%2Fsubgroup%2Fproject/issues/42"
	if !reflect.DeepEqual(paths, []string{wantPath, wantPath}) {
		t.Fatalf("paths = %q, want two %q requests", paths, wantPath)
	}
}

func TestGetMapsGitLabStates(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		state  string
		labels string
		want   domain.NormalizedIssueState
	}{
		{name: "opened", state: "opened", labels: `[]`, want: domain.IssueOpen},
		{name: "in progress label", state: "opened", labels: `["In-Progress"]`, want: domain.IssueInProgress},
		{name: "review label wins", state: "opened", labels: `["in-progress","IN-REVIEW"]`, want: domain.IssueInReview},
		{name: "closed", state: "closed", labels: `[]`, want: domain.IssueDone},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = fmt.Fprintf(w, `{"iid":1,"title":"issue","state":%q,"labels":%s}`, tt.state, tt.labels)
			}))
			defer server.Close()
			tracker := newTrackerForTest(t, server)
			issue, err := tracker.Get(context.Background(), domain.TrackerID{
				Provider: domain.TrackerProviderGitLab,
				Native:   tracker.host + "/group/project#!1",
			})
			if err != nil {
				t.Fatal(err)
			}
			if issue.State != tt.want {
				t.Fatalf("state = %q, want %q", issue.State, tt.want)
			}
		})
	}
}

func TestGetRejectsWrongProviderAndNonCanonicalIDs(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	tracker := newTrackerForTest(t, server)

	tests := []struct {
		name string
		id   domain.TrackerID
		want error
	}{
		{name: "wrong provider", id: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: tracker.host + "/group/project#!1"}, want: ErrWrongProvider},
		{name: "missing host", id: domain.TrackerID{Provider: domain.TrackerProviderGitLab, Native: "group/project#!1"}, want: ErrBadID},
		{name: "wrong host", id: domain.TrackerID{Provider: domain.TrackerProviderGitLab, Native: "other.example/group/project#!1"}, want: ErrBadID},
		{name: "github delimiter", id: domain.TrackerID{Provider: domain.TrackerProviderGitLab, Native: tracker.host + "/group/project#1"}, want: ErrBadID},
		{name: "zero iid", id: domain.TrackerID{Provider: domain.TrackerProviderGitLab, Native: tracker.host + "/group/project#!0"}, want: ErrBadID},
		{name: "project traversal", id: domain.TrackerID{Provider: domain.TrackerProviderGitLab, Native: tracker.host + "/group/../project#!1"}, want: ErrBadID},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := tracker.Get(context.Background(), tt.id)
			if !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestGetDoesNotDiscloseConfidentialIssueExistence(t *testing.T) {
	t.Parallel()
	var messages []string
	for _, status := range []int{http.StatusForbidden, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"message":"sensitive title must not escape"}`))
			}))
			defer server.Close()
			tracker := newTrackerForTest(t, server)
			_, err := tracker.Get(context.Background(), domain.TrackerID{
				Provider: domain.TrackerProviderGitLab,
				Native:   tracker.host + "/group/project#!9",
			})
			if !errors.Is(err, ErrNotFound) || strings.Contains(err.Error(), "sensitive") {
				t.Fatalf("err = %v, want redacted ErrNotFound", err)
			}
			messages = append(messages, err.Error())
		})
	}
	if len(messages) == 2 && messages[0] != messages[1] {
		t.Fatalf("403 and 404 are distinguishable: %q vs %q", messages[0], messages[1])
	}
}

func TestListPaginatesAndRequiresAllLabels(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var queries []url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		queries = append(queries, r.URL.Query())
		mu.Unlock()
		if r.URL.EscapedPath() != "/projects/group%2Fsubgroup%2Fproject/issues" {
			http.Error(w, "wrong path", http.StatusBadRequest)
			return
		}
		if r.URL.Query().Get("page") == "2" {
			_, _ = w.Write([]byte(`[
				{"iid":3,"title":"third","state":"closed","labels":["bug","ready"],"assignees":[]}
			]`))
			return
		}
		w.Header().Set("X-Next-Page", "2")
		_, _ = w.Write([]byte(`[
			{"iid":1,"title":"first","state":"opened","labels":["bug","ready"],"assignees":[{"username":"alice"}]},
			{"iid":2,"title":"missing ready","state":"opened","labels":["bug"],"assignees":[{"username":"alice"}]}
		]`))
	}))
	defer server.Close()

	tracker := newTrackerForTest(t, server)
	issues, err := tracker.List(context.Background(), domain.TrackerRepo{
		Provider: domain.TrackerProviderGitLab,
		Native:   "group/subgroup/project.git",
	}, domain.ListFilter{State: domain.ListAll, Labels: []string{"BUG", "ready"}, Assignee: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	if len(issues) != 2 || issues[0].ID.Native != tracker.host+"/group/subgroup/project#!1" || issues[1].ID.Native != tracker.host+"/group/subgroup/project#!3" {
		t.Fatalf("issues = %#v", issues)
	}
	if issues[1].State != domain.IssueDone || issues[1].Labels == nil || issues[1].Assignees != nil {
		t.Fatalf("second issue normalization = %#v", issues[1])
	}

	mu.Lock()
	defer mu.Unlock()
	if len(queries) != 2 {
		t.Fatalf("queries = %d, want 2 pages", len(queries))
	}
	first := queries[0]
	if first.Get("scope") != "all" || first.Get("state") != "all" || first.Get("per_page") != "100" {
		t.Fatalf("base query = %v", first)
	}
	if !reflect.DeepEqual(first["assignee_username[]"], []string{"alice"}) {
		t.Fatalf("assignee_username[] = %v", first["assignee_username[]"])
	}
	if first.Get("labels") != "BUG,ready" {
		t.Fatalf("labels = %q", first.Get("labels"))
	}
}

func TestListMapsStateAndAssigneeFilters(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		filter     domain.ListFilter
		wantState  string
		wantKey    string
		wantValue  string
		absentKeys []string
	}{
		{name: "opened assigned to username", filter: domain.ListFilter{State: domain.ListOpen, Assignee: "alice"}, wantState: "opened", wantKey: "assignee_username[]", wantValue: "alice", absentKeys: []string{"assignee_id"}},
		{name: "closed assigned to anyone", filter: domain.ListFilter{State: domain.ListClosed, Assignee: "*"}, wantState: "closed", wantKey: "assignee_id", wantValue: "Any", absentKeys: []string{"assignee_username[]"}},
		{name: "all unassigned", filter: domain.ListFilter{State: domain.ListAll, Assignee: "none"}, wantState: "all", wantKey: "assignee_id", wantValue: "None", absentKeys: []string{"assignee_username[]"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var got url.Values
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got = r.URL.Query()
				_, _ = w.Write([]byte(`[]`))
			}))
			defer server.Close()
			tracker := newTrackerForTest(t, server)
			_, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderGitLab, Native: "group/project"}, tt.filter)
			if err != nil {
				t.Fatal(err)
			}
			if got.Get("state") != tt.wantState || got.Get(tt.wantKey) != tt.wantValue || got.Get("scope") != "all" {
				t.Fatalf("query = %v", got)
			}
			for _, key := range tt.absentKeys {
				if _, ok := got[key]; ok {
					t.Fatalf("query unexpectedly contains %q: %v", key, got)
				}
			}
		})
	}
}

func TestListHonorsLimitAfterLocalLabelFiltering(t *testing.T) {
	t.Parallel()
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Query().Get("page") == "2" {
			_, _ = w.Write([]byte(`[{"iid":2,"title":"eligible","state":"opened","labels":["ready"]}]`))
			return
		}
		w.Header().Set("X-Next-Page", "2")
		_, _ = w.Write([]byte(`[{"iid":1,"title":"ineligible","state":"opened","labels":[]}]`))
	}))
	defer server.Close()
	tracker := newTrackerForTest(t, server)
	issues, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderGitLab, Native: "group/project"}, domain.ListFilter{Labels: []string{"ready"}, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || len(issues) != 1 || issues[0].Title != "eligible" {
		t.Fatalf("requests = %d, issues = %#v", requests, issues)
	}
}

func TestListRejectsWrongProviderAndBadRepo(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()
	tracker := newTrackerForTest(t, server)
	for _, repo := range []domain.TrackerRepo{
		{Provider: domain.TrackerProviderGitHub, Native: "group/project"},
		{Provider: domain.TrackerProviderGitLab, Native: "group"},
		{Provider: domain.TrackerProviderGitLab, Native: "group/../project"},
		{Provider: domain.TrackerProviderGitLab, Native: " group/project"},
	} {
		_, err := tracker.List(context.Background(), repo, domain.ListFilter{})
		if err == nil {
			t.Fatalf("repo %#v unexpectedly accepted", repo)
		}
	}
}

func TestRateLimitErrorPassesThrough(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "11")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()
	tracker := newTrackerForTest(t, server)
	_, err := tracker.Get(context.Background(), domain.TrackerID{Provider: domain.TrackerProviderGitLab, Native: tracker.host + "/group/project#!1"})
	if !errors.Is(err, scmgitlab.ErrRateLimited) {
		t.Fatalf("err = %v, want GitLab rate limit", err)
	}
	var rate *scmgitlab.RateLimitError
	if !errors.As(err, &rate) || rate.RetryAfter != 11*time.Second {
		t.Fatalf("rate = %#v, err = %v", rate, err)
	}
}

func TestPreflightUsesUserEndpoint(t *testing.T) {
	t.Parallel()
	var method, path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		_, _ = w.Write([]byte(`{"username":"alice"}`))
	}))
	defer server.Close()
	tracker := newTrackerForTest(t, server)
	if err := tracker.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodGet || path != "/user" {
		t.Fatalf("request = %s %s", method, path)
	}
}

func TestTrackerImplementsPort(t *testing.T) {
	t.Parallel()
	var _ ports.Tracker = (*Tracker)(nil)
}

func newTrackerForTest(t *testing.T, server *httptest.Server) *Tracker {
	t.Helper()
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := scmgitlab.NewClient(scmgitlab.ClientOptions{
		HTTPClient: server.Client(),
		BaseURL:    server.URL,
		Token:      scmgitlab.StaticTokenSource("test-token"),
	})
	tracker, err := New(Options{Client: client, Host: base.Host})
	if err != nil {
		t.Fatal(err)
	}
	return tracker
}
