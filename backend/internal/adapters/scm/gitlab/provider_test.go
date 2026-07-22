package gitlab

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func testServer(t *testing.T, handler http.Handler) (*httptest.Server, *Provider) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := NewClient(ClientOptions{
		Token:    StaticTokenSource("test-token"),
		RESTBase: srv.URL + "/api/v4",
	})
	p, err := NewProvider(ProviderOptions{Client: c})
	if err != nil {
		t.Fatal(err)
	}
	return srv, p
}

func TestParseRepository(t *testing.T) {
	tests := []struct {
		name   string
		remote string
		want   ports.SCMRepo
		ok     bool
	}{
		{
			name:   "ssh gitlab.com",
			remote: "git@gitlab.com:myorg/myrepo.git",
			want:   ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"},
			ok:     true,
		},
		{
			name:   "https gitlab.com",
			remote: "https://gitlab.com/myorg/myrepo.git",
			want:   ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"},
			ok:     true,
		},
		{
			name:   "https without .git",
			remote: "https://gitlab.com/myorg/myrepo",
			want:   ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"},
			ok:     true,
		},
		{
			name:   "self-hosted with gitlab in hostname",
			remote: "git@gitlab.mycompany.com:team/project.git",
			want:   ports.SCMRepo{Provider: "gitlab", Host: "gitlab.mycompany.com", Owner: "team", Name: "project", Repo: "team/project"},
			ok:     true,
		},
		{
			name:   "github.com rejected",
			remote: "git@github.com:owner/repo.git",
			ok:     false,
		},
		{
			name:   "empty string",
			remote: "",
			ok:     false,
		},
		{
			name:   "bare owner/repo without host context",
			remote: "myorg/myrepo",
			ok:     false,
		},
		// Nested GitLab namespaces: group/subgroup/repo
		{
			name:   "ssh nested namespace",
			remote: "git@gitlab.com:group/subgroup/repo.git",
			want:   ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "group/subgroup", Name: "repo", Repo: "group/subgroup/repo"},
			ok:     true,
		},
		{
			name:   "https nested namespace",
			remote: "https://gitlab.com/group/subgroup/repo.git",
			want:   ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "group/subgroup", Name: "repo", Repo: "group/subgroup/repo"},
			ok:     true,
		},
		{
			name:   "ssh self-managed nested namespace",
			remote: "git@gitlab.mycompany.com:eng/team/widget.git",
			want:   ports.SCMRepo{Provider: "gitlab", Host: "gitlab.mycompany.com", Owner: "eng/team", Name: "widget", Repo: "eng/team/widget"},
			ok:     true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo, ok := parseGitLabRepo(tt.remote)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if !tt.ok {
				return
			}
			if repo != tt.want {
				t.Errorf("repo = %+v, want %+v", repo, tt.want)
			}
		})
	}
}

func TestIsGitLabHost(t *testing.T) {
	tests := []struct {
		host string
		want bool
	}{
		{"gitlab.com", true},
		{"www.gitlab.com", true},
		{"gitlab.mycompany.com", true},
		{"github.com", false},
		{"api.github.com", false},
		{"something.ghe.io", false},
		{"example.com", false},
	}
	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			got := isGitLabHost(tt.host)
			if got != tt.want {
				t.Errorf("isGitLabHost(%q) = %v, want %v", tt.host, got, tt.want)
			}
		})
	}
}

func TestRepoPRListGuard(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == `"etag-1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"etag-1"`)
		fmt.Fprint(w, `[{"iid": 1}]`)
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	res, err := p.RepoPRListGuard(context.Background(), repo, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.NotModified {
		t.Error("expected not NotModified on first call")
	}
	if res.ETag != `"etag-1"` {
		t.Errorf("ETag = %q, want %q", res.ETag, `"etag-1"`)
	}

	res, err = p.RepoPRListGuard(context.Background(), repo, `"etag-1"`)
	if err != nil {
		t.Fatal(err)
	}
	if !res.NotModified {
		t.Error("expected NotModified on second call")
	}
}

func TestListOpenPRsByRepo(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests", func(w http.ResponseWriter, r *http.Request) {
		mrs := []map[string]any{
			{
				"iid":           1,
				"title":         "Fix bug",
				"state":         "opened",
				"draft":         false,
				"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
				"source_branch": "fix-bug",
				"target_branch": "main",
				"sha":           "abc123",
				"merge_status":  "can_be_merged",
				"author":        map[string]any{"username": "alice"},
				"created_at":    now.Format(time.RFC3339),
				"updated_at":    now.Format(time.RFC3339),
			},
			{
				"iid":           2,
				"title":         "WIP: Draft MR",
				"state":         "opened",
				"draft":         true,
				"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/2",
				"source_branch": "draft-branch",
				"target_branch": "main",
				"sha":           "def456",
				"merge_status":  "unchecked",
				"author":        map[string]any{"username": "bob"},
				"created_at":    now.Format(time.RFC3339),
				"updated_at":    now.Format(time.RFC3339),
			},
		}
		json.NewEncoder(w).Encode(mrs)
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	prs, err := p.ListOpenPRsByRepo(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	if len(prs) != 2 {
		t.Fatalf("got %d PRs, want 2", len(prs))
	}
	if prs[0].State != "open" {
		t.Errorf("pr[0].State = %q, want %q", prs[0].State, "open")
	}
	if prs[1].State != "draft" {
		t.Errorf("pr[1].State = %q, want %q", prs[1].State, "draft")
	}
	if prs[0].Author != "alice" {
		t.Errorf("pr[0].Author = %q, want %q", prs[0].Author, "alice")
	}
}

func TestFetchPullRequests(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid":           1,
			"title":         "Fix bug",
			"state":         "opened",
			"draft":         false,
			"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch": "fix-bug",
			"target_branch": "main",
			"sha":           "abc123",
			"merge_status":  "can_be_merged",
			"author":        map[string]any{"username": "alice"},
			"diff_refs":     map[string]any{"base_sha": "base123"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 100, "status": "success", "sha": "abc123"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 200, "name": "build", "status": "success", "web_url": "https://gitlab.com/jobs/200"},
			{"id": 201, "name": "test", "status": "success", "web_url": "https://gitlab.com/jobs/201"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"approved":           true,
			"approvals_required": 1,
			"approved_by": []map[string]any{
				{"user": map[string]any{"username": "reviewer1"}},
			},
		})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 {
		t.Fatalf("got %d observations, want 1", len(obs))
	}
	o := obs[0]
	if !o.Fetched {
		t.Error("expected Fetched=true")
	}
	if o.Provider != "gitlab" {
		t.Errorf("Provider = %q, want %q", o.Provider, "gitlab")
	}
	if o.CI.Summary != "passing" {
		t.Errorf("CI.Summary = %q, want %q", o.CI.Summary, "passing")
	}
	if o.Review.Decision != "approved" {
		t.Errorf("Review.Decision = %q, want %q", o.Review.Decision, "approved")
	}
	if o.Mergeability.State != "mergeable" {
		t.Errorf("Mergeability.State = %q, want %q", o.Mergeability.State, "mergeable")
	}
	if len(o.CI.Checks) != 2 {
		t.Errorf("CI.Checks = %d, want 2", len(o.CI.Checks))
	}
}

func TestFetchPullRequests_FailingCI(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid": 1, "title": "Fix bug", "state": "opened", "draft": false,
			"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch": "fix-bug", "target_branch": "main", "sha": "abc123",
			"merge_status": "can_be_merged", "author": map[string]any{"username": "alice"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 100, "status": "failed", "sha": "abc123"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 200, "name": "build", "status": "success", "web_url": "https://gitlab.com/jobs/200"},
			{"id": 201, "name": "test", "status": "failed", "web_url": "https://gitlab.com/jobs/201"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"approved": false, "approvals_required": 0, "approved_by": []any{}})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	if err != nil {
		t.Fatal(err)
	}
	o := obs[0]
	if o.CI.Summary != "failing" {
		t.Errorf("CI.Summary = %q, want %q", o.CI.Summary, "failing")
	}
	if len(o.CI.FailedChecks) != 1 {
		t.Errorf("FailedChecks = %d, want 1", len(o.CI.FailedChecks))
	}
	if o.CI.FailedChecks[0].Name != "test" {
		t.Errorf("FailedChecks[0].Name = %q, want %q", o.CI.FailedChecks[0].Name, "test")
	}
}

func TestFetchFailedCheckLogTail(t *testing.T) {
	lines := make([]string, 50)
	for i := range lines {
		lines[i] = fmt.Sprintf("line %d", i+1)
	}
	logContent := strings.Join(lines, "\n")

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/jobs/201/trace", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, logContent)
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	check := ports.SCMCheckObservation{ProviderID: "201"}

	tail, err := p.FetchFailedCheckLogTail(context.Background(), repo, check)
	if err != nil {
		t.Fatal(err)
	}
	tailLines := strings.Split(tail, "\n")
	if len(tailLines) != ciFailureLogTailLines {
		t.Errorf("got %d lines, want %d", len(tailLines), ciFailureLogTailLines)
	}
	if tailLines[0] != "line 31" {
		t.Errorf("first tail line = %q, want %q", tailLines[0], "line 31")
	}
}

func TestFetchReviewThreads(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/discussions", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{
				"id":              "disc-1",
				"individual_note": false,
				"notes": []map[string]any{
					{
						"id":         100,
						"body":       "Please fix this",
						"system":     false,
						"resolvable": true,
						"resolved":   false,
						"author":     map[string]any{"username": "reviewer1"},
						"position":   map[string]any{"new_path": "main.go", "new_line": 42},
					},
				},
			},
			{
				"id":              "disc-2",
				"individual_note": false,
				"notes": []map[string]any{
					{
						"id":         101,
						"body":       "System message",
						"system":     true,
						"resolvable": false,
						"author":     map[string]any{"username": "gitlab-bot"},
					},
				},
			},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"approved":           false,
			"approvals_required": 1,
			"approved_by":        []any{},
		})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	review, err := p.FetchReviewThreads(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if review.Decision != "review_required" {
		t.Errorf("Decision = %q, want %q", review.Decision, "review_required")
	}
	if len(review.Threads) != 1 {
		t.Fatalf("Threads = %d, want 1 (system note discussion should be filtered)", len(review.Threads))
	}
	th := review.Threads[0]
	if th.Resolved {
		t.Error("expected thread to be unresolved")
	}
	if th.Path != "main.go" {
		t.Errorf("Path = %q, want %q", th.Path, "main.go")
	}
	if th.Line != 42 {
		t.Errorf("Line = %d, want %d", th.Line, 42)
	}
}

func TestCommitChecksGuard(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 100, "status": "success", "sha": "abc123"},
		})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	res1, err := p.CommitChecksGuard(context.Background(), repo, "abc123", "")
	if err != nil {
		t.Fatal(err)
	}
	if res1.ETag == "" {
		t.Error("expected non-empty ETag")
	}
	if res1.NotModified {
		t.Error("expected not NotModified on first call")
	}

	res2, err := p.CommitChecksGuard(context.Background(), repo, "abc123", res1.ETag)
	if err != nil {
		t.Fatal(err)
	}
	if !res2.NotModified {
		t.Error("expected NotModified on second call with same data")
	}
}

func TestMergeabilityFromMR(t *testing.T) {
	tests := []struct {
		mergeStatus string
		ciState     string
		review      string
		draft       bool
		wantState   string
	}{
		{"can_be_merged", "passing", "approved", false, "mergeable"},
		{"can_be_merged", "failing", "approved", false, "blocked"},
		{"can_be_merged", "passing", "review_required", false, "blocked"},
		{"can_be_merged", "passing", "approved", true, "blocked"},
		{"cannot_be_merged", "passing", "approved", false, "conflicting"},
		{"checking", "passing", "approved", false, "unknown"},
		{"discussions_not_resolved", "passing", "approved", false, "blocked"},
		{"not_approved", "passing", "none", false, "blocked"},
	}
	for _, tt := range tests {
		name := fmt.Sprintf("%s/%s/%s/draft=%v", tt.mergeStatus, tt.ciState, tt.review, tt.draft)
		t.Run(name, func(t *testing.T) {
			mr := &restMR{MergeStatus: tt.mergeStatus, Draft: tt.draft}
			got := mergeabilityFromMR(mr, tt.ciState, tt.review)
			if got.State != tt.wantState {
				t.Errorf("State = %q, want %q", got.State, tt.wantState)
			}
		})
	}
}

func TestNormalizeMRState(t *testing.T) {
	tests := []struct {
		state string
		draft bool
		want  string
	}{
		{"opened", false, "open"},
		{"opened", true, "draft"},
		{"merged", false, "merged"},
		{"closed", false, "closed"},
		{"locked", false, "closed"},
	}
	for _, tt := range tests {
		t.Run(tt.state+"/"+strconv.FormatBool(tt.draft), func(t *testing.T) {
			got := normalizeMRState(tt.state, tt.draft)
			if string(got) != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPipelineStatusToCI(t *testing.T) {
	tests := []struct {
		status string
		want   string
	}{
		{"success", "passing"},
		{"failed", "failing"},
		{"canceled", "failing"},
		{"running", "pending"},
		{"pending", "pending"},
		{"created", "pending"},
		{"skipped", "unknown"},
		{"manual", "unknown"},
		{"", "unknown"},
	}
	for _, tt := range tests {
		t.Run(tt.status, func(t *testing.T) {
			got := pipelineStatusToCI(tt.status)
			if string(got) != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestIsBotAuthor(t *testing.T) {
	tests := []struct {
		username string
		want     bool
	}{
		{"gitlab-bot", true},
		{"ghost", true},
		{"dependabot[bot]", true},
		{"project_123_bot", true},
		{"alice", false},
		{"robotics-team", false},
	}
	for _, tt := range tests {
		t.Run(tt.username, func(t *testing.T) {
			got := isBotAuthor(tt.username)
			if got != tt.want {
				t.Errorf("isBotAuthor(%q) = %v, want %v", tt.username, got, tt.want)
			}
		})
	}
}

func TestSCMCredentialsAvailable(t *testing.T) {
	p, _ := NewProvider(ProviderOptions{
		Client: NewClient(ClientOptions{Token: StaticTokenSource("tok")}),
	})
	avail, err := p.SCMCredentialsAvailable(context.Background())
	if err != nil || !avail {
		t.Errorf("want (true, nil), got (%v, %v)", avail, err)
	}

	pEmpty, _ := NewProvider(ProviderOptions{
		Client: NewClient(ClientOptions{Token: StaticTokenSource("")}),
	})
	avail, err = pEmpty.SCMCredentialsAvailable(context.Background())
	if err != nil || avail {
		t.Errorf("want (false, nil), got (%v, %v)", avail, err)
	}
}

func TestClassifyError(t *testing.T) {
	tests := []struct {
		status int
		want   error
	}{
		{404, ErrNotFound},
		{401, ErrAuthFailed},
		{403, ErrAuthFailed},
		{429, ErrRateLimited},
	}
	for _, tt := range tests {
		t.Run(strconv.Itoa(tt.status), func(t *testing.T) {
			resp := &http.Response{StatusCode: tt.status, Status: http.StatusText(tt.status)}
			got := classifyError(resp, nil)
			if !strings.Contains(got.Error(), tt.want.Error()) {
				t.Errorf("classifyError(%d) = %v, want to contain %v", tt.status, got, tt.want)
			}
		})
	}
}

// Silence the unused import warnings from url.
var _ = url.Values{}
