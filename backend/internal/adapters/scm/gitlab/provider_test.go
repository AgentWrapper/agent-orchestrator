package gitlab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
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
	// Provider with gitlab.mycompany.com allowlisted so the self-managed test
	// cases exercise the allowlist path.
	p, err := NewProvider(ProviderOptions{
		Token:              StaticTokenSource("tok"),
		SkipTokenPreflight: true,
		AllowedHosts:       []string{"gitlab.mycompany.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
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
		// Non-allowlisted self-managed host is rejected (review Item 5).
		{
			name:   "non-allowlisted self-managed host rejected",
			remote: "git@gitlab.attacker.example:team/project.git",
			ok:     false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo, ok := p.ParseRepository(tt.remote)
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

func TestIsHostAllowed(t *testing.T) {
	p, err := NewProvider(ProviderOptions{
		Token:              StaticTokenSource("tok"),
		SkipTokenPreflight: true,
		AllowedHosts:       []string{"gitlab.mycompany.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		host string
		want bool
	}{
		{"gitlab.com", true},
		{"www.gitlab.com", true},
		{"gitlab.mycompany.com", true},
		// Non-allowlisted hosts are rejected, even if they contain "gitlab".
		{"gitlab.attacker.example", false},
		{"github.com", false},
		{"api.github.com", false},
		{"something.ghe.io", false},
		{"example.com", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			got := p.isHostAllowed(tt.host)
			if got != tt.want {
				t.Errorf("isHostAllowed(%q) = %v, want %v", tt.host, got, tt.want)
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

	prs, err := p.ListPRsByRepo(context.Background(), repo, time.Time{})
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
	// base_sha arrives nested under diff_refs in the MR detail response;
	// it must be parsed via the nested struct (not the broken dotted tag).
	if got, want := o.PR.BaseSHA, "base123"; got != want {
		t.Errorf("PR.BaseSHA = %q, want %q", got, want)
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

// TestFetchReviewThreads_SingleApprovalsCall verifies that FetchReviewThreads
// makes exactly ONE approvals API call, not two. The
// previous implementation called fetchApprovalDecision AND re-fetched the
// approvals endpoint separately.
func TestFetchReviewThreads_SingleApprovalsCall(t *testing.T) {
	approvalsHits := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/discussions", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]any{})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		approvalsHits++
		json.NewEncoder(w).Encode(map[string]any{
			"approved":           true,
			"approvals_required": 2,
			"approved_by": []map[string]any{
				{"user": map[string]any{"username": "reviewer1"}},
				{"user": map[string]any{"username": "reviewer2"}},
			},
		})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	review, err := p.FetchReviewThreads(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if approvalsHits != 1 {
		t.Fatalf("approvals endpoint hit %d times, want exactly 1", approvalsHits)
	}
	if review.Decision != "approved" {
		t.Errorf("Decision = %q, want %q", review.Decision, "approved")
	}
	if len(review.Reviews) != 2 {
		t.Fatalf("Reviews = %d, want 2", len(review.Reviews))
	}
}

// TestFetchReviewThreads_StableReviewIDs verifies that review summaries have
// stable, unique IDs so multiple approvers don't overwrite each other in
// persistence
func TestFetchReviewThreads_StableReviewIDs(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/discussions", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]any{})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"approved":           true,
			"approvals_required": 2,
			"approved_by": []map[string]any{
				{"user": map[string]any{"username": "reviewer1"}},
				{"user": map[string]any{"username": "reviewer2"}},
			},
		})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	review, err := p.FetchReviewThreads(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if len(review.Reviews) != 2 {
		t.Fatalf("Reviews = %d, want 2", len(review.Reviews))
	}
	seen := map[string]bool{}
	for _, r := range review.Reviews {
		if r.ID == "" {
			t.Error("review summary has empty ID — multiple approvers would overwrite each other")
		}
		if seen[r.ID] {
			t.Errorf("duplicate review ID %q — approvers collide in persistence", r.ID)
		}
		seen[r.ID] = true
		if r.Author == "reviewer1" && r.ID != "approval:reviewer1" {
			t.Errorf("reviewer1 ID = %q, want %q", r.ID, "approval:reviewer1")
		}
		if r.Author == "reviewer2" && r.ID != "approval:reviewer2" {
			t.Errorf("reviewer2 ID = %q, want %q", r.ID, "approval:reviewer2")
		}
	}
}

// TestFetchApprovalDecision_TrustsApprovedField verifies that the approved
// field is trusted regardless of len(approved_by) — approved_by can contain
// approvals that don't satisfy the applicable rules
func TestFetchApprovalDecision_TrustsApprovedField(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		// approved=true but approved_by is EMPTY — the adapter must trust
		// the approved field, not compare len(approved_by).
		json.NewEncoder(w).Encode(map[string]any{
			"approved":           true,
			"approvals_required": 2,
			"approved_by":        []any{},
		})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	decision, err := p.fetchApprovalDecision(context.Background(), repo, 1)
	if err != nil {
		t.Fatal(err)
	}
	if decision != "approved" {
		t.Errorf("decision = %q, want %q (must trust approved field, not len(approved_by))", decision, "approved")
	}
}

// TestFetchApprovalDecision_NotApproved verifies that approved=false with
// approvals_required>0 yields ReviewRequired
func TestFetchApprovalDecision_NotApproved(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"approved":           false,
			"approvals_required": 2,
			"approved_by": []map[string]any{
				{"user": map[string]any{"username": "reviewer1"}},
			},
		})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	decision, err := p.fetchApprovalDecision(context.Background(), repo, 1)
	if err != nil {
		t.Fatal(err)
	}
	if decision != "review_required" {
		t.Errorf("decision = %q, want %q", decision, "review_required")
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

// TestCommitChecksGuard_ThenFetchPullRequests_Pipelines304Reused asserts that
// CommitChecksGuard and fetchCI produce the same pipelines-endpoint cache key
// (same query parameters), so the second call is served as a 304 by the
// doGET ETag cache rather than a fresh 200. This is ticket 06's core
// acceptance criterion: aligning per_page=1 across both call sites lets the
// existing ETag cache do its job across the guard and the full fetch.
//
// The test counts 200 responses (full body transfers) on the pipelines
// endpoint. With the guard running first, it populates the ETag cache; when
// fetchCI runs second with the same query, it sends If-None-Match and receives
// a 304 — so the pipelines handler sees exactly one 200.
func TestCommitChecksGuard_ThenFetchPullRequests_Pipelines304Reused(t *testing.T) {
	var pipelines200 atomic.Int32
	var pipelinesTotal atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
		pipelinesTotal.Add(1)
		// Behave like a real ETag-aware GitLab server: if the client sends
		// If-None-Match matching our stable ETag, return 304 (no body). This is
		// what lets the doGET ETag cache downgrade the second call.
		if inm := r.Header.Get("If-None-Match"); inm == `"pipelines-v1"` {
			w.Header().Set("ETag", `"pipelines-v1"`)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"pipelines-v1"`)
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 100, "status": "success", "sha": "abc123"},
		})
		pipelines200.Add(1)
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid": 1, "title": "Fix bug", "state": "opened", "draft": false,
			"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch": "fix-bug", "target_branch": "main", "sha": "abc123",
			"merge_status": "can_be_merged", "author": map[string]any{"username": "alice"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 200, "name": "build", "status": "success", "web_url": "https://gitlab.com/jobs/200"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"approved": false, "approvals_required": 0, "approved_by": []any{}})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	// 1. Guard runs first (the cheap pre-check). This populates the doGET ETag
	//    cache for the pipelines endpoint with per_page=1.
	if _, err := p.CommitChecksGuard(context.Background(), repo, "abc123", ""); err != nil {
		t.Fatalf("CommitChecksGuard: %v", err)
	}

	// 2. fetchCI (via FetchPullRequests) runs second with the same query
	//    parameters. The doGET ETag cache sends If-None-Match and receives a
	//    304, so the pipelines handler is NOT hit with a fresh 200.
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}
	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	if err != nil {
		t.Fatalf("FetchPullRequests: %v", err)
	}
	if len(obs) != 1 || !obs[0].Fetched {
		t.Fatalf("expected 1 fetched observation, got %+v", obs)
	}
	if obs[0].CI.Summary != "passing" {
		t.Errorf("CI.Summary = %q, want %q", obs[0].CI.Summary, "passing")
	}

	// The pipelines endpoint must have been hit exactly once with a 200
	// (the guard's fetch). The second call (fetchCI) must be served as a 304
	// by the ETag cache, so the handler never emits a second 200 body.
	if got := pipelines200.Load(); got != 1 {
		t.Errorf("pipelines 200 count = %d, want 1 (second call should be a 304 served by ETag cache)", got)
	}
	if got := pipelinesTotal.Load(); got != 2 {
		t.Errorf("pipelines total requests = %d, want 2 (one 200 + one 304)", got)
	}
}

func TestMergeabilityFromMR(t *testing.T) {
	tests := []struct {
		name           string
		detailedStatus string // populates restMR.DetailedMergeStatus (current GitLab enum)
		legacyStatus   string // populates restMR.MergeStatus (deprecated since GitLab 15.6)
		ciState        string
		review         string
		draft          bool
		wantState      string
		wantConflict   bool
		wantBehind     bool
		wantBlockers   []string
	}{
		// Current detailed_merge_status values (GitLab >= 15.6).
		{"mergeable", "mergeable", "", "passing", "approved", false, "mergeable", false, false, nil},
		{"mergeable+failing-ci", "mergeable", "", "failing", "approved", false, "blocked", false, false, []string{"ci_failing"}},
		{"mergeable+review-required", "mergeable", "", "passing", "review_required", false, "blocked", false, false, []string{"review_required"}},
		{"mergeable+draft", "mergeable", "", "passing", "approved", true, "blocked", false, false, []string{"draft"}},
		{"conflict", "conflict", "", "passing", "approved", false, "conflicting", true, false, []string{"conflicts"}},
		{"checking", "checking", "", "passing", "approved", false, "unknown", false, false, nil},
		{"preparing", "preparing", "", "passing", "approved", false, "unknown", false, false, nil},
		{"unchecked", "unchecked", "", "passing", "approved", false, "unknown", false, false, nil},
		{"need_rebase", "need_rebase", "", "passing", "approved", false, "blocked", false, true, []string{"behind_base"}},
		{"requested_changes", "requested_changes", "", "passing", "approved", false, "blocked", false, false, []string{"review_required"}},
		{"not_approved", "not_approved", "", "passing", "none", false, "blocked", false, false, []string{"review_required"}},
		{"ci_must_pass", "ci_must_pass", "", "passing", "approved", false, "blocked", false, false, []string{"ci_failing"}},
		{"ci_still_running", "ci_still_running", "", "passing", "approved", false, "blocked", false, false, []string{"ci_failing"}},
		{"discussions_not_resolved", "discussions_not_resolved", "", "passing", "approved", false, "blocked", false, false, []string{"discussions_unresolved"}},
		{"draft_status", "draft_status", "", "passing", "approved", false, "blocked", false, false, []string{"draft"}},
		{"not_open", "not_open", "", "passing", "approved", false, "blocked", false, false, []string{"blocked_by_provider"}},
		{"merge_request_blocked", "merge_request_blocked", "", "passing", "approved", false, "blocked", false, false, []string{"blocked_by_provider"}},

		// Legacy merge_status values (deprecated since GitLab 15.6, still
		// returned by older self-managed installations).
		{"legacy-can_be_merged", "", "can_be_merged", "passing", "approved", false, "mergeable", false, false, nil},
		{"legacy-cannot_be_merged", "", "cannot_be_merged", "passing", "approved", false, "conflicting", true, false, []string{"conflicts"}},
		{"legacy-cannot_be_merged_recheck", "", "cannot_be_merged_recheck", "passing", "approved", false, "conflicting", true, false, []string{"conflicts"}},
		{"legacy-checking", "", "checking", "passing", "approved", false, "unknown", false, false, nil},
		{"legacy-unchecked", "", "unchecked", "passing", "approved", false, "unknown", false, false, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mr := &restMR{MergeStatus: tt.legacyStatus, DetailedMergeStatus: tt.detailedStatus, Draft: tt.draft}
			got := mergeabilityFromMR(mr, tt.ciState, tt.review)
			if got.State != tt.wantState {
				t.Errorf("State = %q, want %q", got.State, tt.wantState)
			}
			if got.Conflict != tt.wantConflict {
				t.Errorf("Conflict = %v, want %v", got.Conflict, tt.wantConflict)
			}
			if got.BehindBase != tt.wantBehind {
				t.Errorf("BehindBase = %v, want %v", got.BehindBase, tt.wantBehind)
			}
			if tt.wantBlockers != nil {
				if len(got.Blockers) != len(tt.wantBlockers) {
					t.Fatalf("Blockers = %v, want %v", got.Blockers, tt.wantBlockers)
				}
				for i, b := range tt.wantBlockers {
					if got.Blockers[i] != b {
						t.Errorf("Blockers[%d] = %q, want %q", i, got.Blockers[i], b)
					}
				}
			}
		})
	}
}

// TestFetchPullRequests_DetailedMergeStatus verifies that a current GitLab
// detailed_merge_status value ("mergeable") flows through to the observation's
// Mergeability.State rather than being misclassified as blocked (review
// finding #3).
func TestFetchPullRequests_DetailedMergeStatus(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid": 1, "title": "Fix bug", "state": "opened", "draft": false,
			"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch": "fix-bug", "target_branch": "main", "sha": "abc123",
			"merge_status":          "can_be_merged", // deprecated legacy field
			"detailed_merge_status": "mergeable",     // current authoritative field
			"author":                map[string]any{"username": "alice"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{{"id": 100, "status": "success", "sha": "abc123"}})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{{"id": 200, "name": "build", "status": "success", "web_url": "https://gitlab.com/jobs/200"}})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"approved": true, "approvals_required": 1, "approved_by": []map[string]any{{"user": map[string]any{"username": "reviewer1"}}}})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	if err != nil {
		t.Fatal(err)
	}
	if obs[0].Mergeability.State != "mergeable" {
		t.Errorf("Mergeability.State = %q, want %q (detailed_merge_status=mergeable must map to mergeable, not blocked)", obs[0].Mergeability.State, "mergeable")
	}
	if obs[0].Mergeability.Conflict {
		t.Error("Mergeability.Conflict = true, want false for mergeable MR")
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

// TestClassifyError_RateLimitRetryAfter verifies that a 429 with a Retry-After
// header is parsed into a RateLimitError exposing RetryAfter, so the observer
// can apply a provider-level cooldown instead of hammering every 30s (review
// finding #4).
func TestClassifyError_RateLimitRetryAfter(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Status:     http.StatusText(http.StatusTooManyRequests),
		Header: http.Header{
			"Retry-After": []string{"120"},
		},
	}
	err := classifyError(resp, nil)
	var rle *RateLimitError
	if !errors.As(err, &rle) {
		t.Fatalf("classifyError(429+Retry-After) = %T, want *RateLimitError", err)
	}
	if !errors.Is(err, ErrRateLimited) {
		t.Errorf("errors.Is(err, ErrRateLimited) = false, want true")
	}
	if rle.RetryAfter != 120*time.Second {
		t.Errorf("RetryAfter = %v, want 2m0s", rle.RetryAfter)
	}
}

// TestClassifyError_RateLimitResetHeader verifies that a 429 with a
// RateLimit-Reset header (Unix epoch seconds) is parsed into a RateLimitError
// exposing ResetAt
func TestClassifyError_RateLimitResetHeader(t *testing.T) {
	resetEpoch := time.Now().Add(5 * time.Minute).Unix()
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Status:     http.StatusText(http.StatusTooManyRequests),
		Header:     http.Header{},
	}
	// Header.Set canonicalizes the key on store, matching how Go's HTTP
	// transport populates headers from the wire (a raw map-literal key would
	// NOT be canonicalized and Get() would miss it).
	resp.Header.Set("RateLimit-Reset", strconv.FormatInt(resetEpoch, 10))
	err := classifyError(resp, nil)
	var rle *RateLimitError
	if !errors.As(err, &rle) {
		t.Fatalf("classifyError(429+RateLimit-Reset) = %T, want *RateLimitError", err)
	}
	if rle.ResetAt.IsZero() {
		t.Error("ResetAt = zero, want parsed from RateLimit-Reset header")
	}
	// Allow a small clock-skew window.
	if diff := time.Until(rle.ResetAt); diff < 4*time.Minute || diff > 6*time.Minute {
		t.Errorf("ResetAt is %v from now, want ~5m", diff)
	}
}

// TestNewClient_DefaultHTTPTimeout verifies the client uses a finite HTTP
// timeout by default so a hung GitLab API call does not block the observer
// indefinitely
func TestNewClient_DefaultHTTPTimeout(t *testing.T) {
	c := NewClient(ClientOptions{Token: StaticTokenSource("tok")})
	if c.http == nil {
		t.Fatal("http client = nil")
	}
	if c.http.Timeout <= 0 {
		t.Errorf("http client Timeout = %v, want finite (>0)", c.http.Timeout)
	}
}

// TestFetchPullRequests_SelfManagedRESTBase verifies that a self-managed GitLab
// host derives its REST base as https://<host>/api/v4 rather than hitting
// gitlab.com
func TestFetchPullRequests_SelfManagedRESTBase(t *testing.T) {
	var seenHost string
	var seenPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenHost = r.Host
		seenPath = r.URL.Path
		switch {
		case strings.HasSuffix(r.URL.Path, "/merge_requests/1"):
			json.NewEncoder(w).Encode(map[string]any{
				"iid": 1, "title": "Fix bug", "state": "opened", "draft": false,
				"web_url":       "https://gitlab.mycompany.com/eng/team/-/merge_requests/1",
				"source_branch": "fix-bug", "target_branch": "main", "sha": "abc123",
				"merge_status": "mergeable", "detailed_merge_status": "mergeable",
				"author": map[string]any{"username": "alice"},
			})
		case strings.HasSuffix(r.URL.Path, "/pipelines"):
			json.NewEncoder(w).Encode([]map[string]any{})
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			json.NewEncoder(w).Encode(map[string]any{"approved": false, "approvals_required": 0, "approved_by": []any{}})
		default:
			json.NewEncoder(w).Encode([]any{})
		}
	}))
	t.Cleanup(srv.Close)

	// Build a provider with no default client (so clientForHost always builds
	// per-host clients) and a hostClientCfg whose HTTPClient is a test-server
	// redirecting transport so the derived https://<host>/api/v4 URL is
	// rewritten to the test server. This proves the REST base is derived from
	// the host, not hardcoded to gitlab.com.
	p, err := NewProvider(ProviderOptions{
		Token:              StaticTokenSource("test-token"),
		SkipTokenPreflight: true,
		AllowedHosts:       []string{"gitlab.mycompany.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
	p.hostClientCfg = ClientOptions{
		Token: StaticTokenSource("test-token"),
		HTTPClient: &http.Client{
			Transport: &rewriteTransport{target: srv.URL},
		},
	}
	// Default client also points at the test server for the empty-host fallback.
	p.client = NewClient(ClientOptions{
		Token:      StaticTokenSource("test-token"),
		RESTBase:   srv.URL + "/api/v4",
		HTTPClient: &http.Client{Transport: &rewriteTransport{target: srv.URL}},
	})

	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.mycompany.com", Owner: "eng/team", Name: "widget", Repo: "eng/team/widget"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.mycompany.com/eng/team/-/merge_requests/1"}

	if _, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref}); err != nil {
		t.Fatalf("FetchPullRequests: %v", err)
	}
	if seenHost == "" {
		t.Fatal("no request was made to the self-managed host")
	}
	// The request must have gone to the test server (derived REST base),
	// NOT to gitlab.com. If it had used the hardcoded default, seenHost would
	// be "gitlab.com" and the request would have failed with a DNS error.
	if seenHost == "gitlab.com" {
		t.Errorf("request went to gitlab.com (host=%q), want self-managed test server — REST base not derived from host", seenHost)
	}
	if !strings.Contains(seenPath, "/projects/") {
		t.Errorf("unexpected path: %q", seenPath)
	}
}

// rewriteTransport rewrites every request's URL scheme+host to target, so a
// client whose REST base is https://gitlab.mycompany.com/api/v4 is transparently
// routed to a test server. This lets self-managed host tests prove the REST
// base is derived from the host without real DNS.
type rewriteTransport struct {
	target string
}

func (t *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req2 := req.Clone(req.Context())
	u, err := url.Parse(t.target + req2.URL.Path)
	if err != nil {
		return nil, err
	}
	u.RawQuery = req2.URL.RawQuery
	req2.URL = u
	return http.DefaultTransport.RoundTrip(req2)
}

// TestFetchPullRequests_PipelineJobsPagination verifies that when a pipeline
// has more than one page of jobs, all pages are fetched by following the
// Link: <...>; rel="next" header
func TestFetchPullRequests_PipelineJobsPagination(t *testing.T) {
	page := 1
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid": 1, "title": "Fix bug", "state": "opened", "draft": false,
			"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch": "fix-bug", "target_branch": "main", "sha": "abc123",
			"merge_status": "mergeable", "detailed_merge_status": "mergeable",
			"author": map[string]any{"username": "alice"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{{"id": 100, "status": "failed", "sha": "abc123"}})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
		if page == 1 {
			// Page 1: full page of pipelineJobsPageSize jobs + a Link header
			// pointing to page 2.
			jobs := make([]map[string]any, pipelineJobsPageSize)
			for i := range jobs {
				jobs[i] = map[string]any{
					"id": 200 + i, "name": fmt.Sprintf("job-%d", i), "status": "success",
					"web_url": fmt.Sprintf("https://gitlab.com/jobs/%d", 200+i),
				}
			}
			w.Header().Set("Link", fmt.Sprintf(`<http://%s/api/v4/projects/myorg%%2Fmyrepo/pipelines/100/jobs?per_page=%d&page=2>; rel="next"`, r.Host, pipelineJobsPageSize))
			json.NewEncoder(w).Encode(jobs)
			page = 2
			return
		}
		// Page 2: 50 more jobs (no next link → stop).
		jobs := make([]map[string]any, 50)
		for i := range jobs {
			jobs[i] = map[string]any{
				"id": 300 + i, "name": fmt.Sprintf("job-extra-%d", i), "status": "failed",
				"web_url": fmt.Sprintf("https://gitlab.com/jobs/%d", 300+i),
			}
		}
		json.NewEncoder(w).Encode(jobs)
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
	totalWant := pipelineJobsPageSize + 50
	if len(obs[0].CI.Checks) != totalWant {
		t.Errorf("CI.Checks = %d, want %d (pagination must follow Link rel=next)", len(obs[0].CI.Checks), totalWant)
	}
	if len(obs[0].CI.FailedChecks) != 50 {
		t.Errorf("CI.FailedChecks = %d, want 50 (all from page 2)", len(obs[0].CI.FailedChecks))
	}
}

// TestFetchReviewThreads_DiscussionsPagination verifies that when an MR has
// more than one page of discussions, all pages are fetched by following the
// Link header
func TestFetchReviewThreads_DiscussionsPagination(t *testing.T) {
	page := 1
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/discussions", func(w http.ResponseWriter, r *http.Request) {
		if page == 1 {
			discs := make([]map[string]any, reviewDiscussionPageSize)
			for i := range discs {
				discs[i] = map[string]any{
					"id":              fmt.Sprintf("disc-%d", i),
					"individual_note": false,
					"notes": []map[string]any{{
						"id": 100 + i, "body": "comment", "system": false,
						"resolvable": true, "resolved": true,
						"author": map[string]any{"username": "reviewer1"},
					}},
				}
			}
			w.Header().Set("Link", fmt.Sprintf(`<http://%s/api/v4/projects/myorg%%2Fmyrepo/merge_requests/1/discussions?per_page=%d&page=2>; rel="next"`, r.Host, reviewDiscussionPageSize))
			json.NewEncoder(w).Encode(discs)
			page = 2
			return
		}
		// Page 2: 30 more discussions, no next link.
		discs := make([]map[string]any, 30)
		for i := range discs {
			discs[i] = map[string]any{
				"id":              fmt.Sprintf("disc-extra-%d", i),
				"individual_note": false,
				"notes": []map[string]any{{
					"id": 200 + i, "body": "extra comment", "system": false,
					"resolvable": true, "resolved": false,
					"author": map[string]any{"username": "reviewer2"},
				}},
			}
		}
		json.NewEncoder(w).Encode(discs)
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"approved": false, "approvals_required": 0, "approved_by": []any{}})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	review, err := p.FetchReviewThreads(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	totalWant := reviewDiscussionPageSize + 30
	if len(review.Threads) != totalWant {
		t.Errorf("Threads = %d, want %d (pagination must follow Link rel=next)", len(review.Threads), totalWant)
	}
	// Pagination completed naturally (no next link on page 2) — Partial must be false.
	if review.Partial {
		t.Error("Partial = true, want false (all discussions fetched, no truncation)")
	}
}

// TestFetchReviewThreads_DiscussionsTruncated verifies that Partial is set to
// true only when the 10-page pagination cap is hit (actual truncation), not
// whenever a full page is returned. Previously Partial was set based on
// len(discussions) >= pageSize, which was true even for a single full page.
func TestFetchReviewThreads_DiscussionsTruncated(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/discussions", func(w http.ResponseWriter, r *http.Request) {
		// Always return a full page and always include a next link, simulating
		// a repo with more than 10 pages of discussions (1000+).
		discs := make([]map[string]any, reviewDiscussionPageSize)
		for i := range discs {
			discs[i] = map[string]any{
				"id":              fmt.Sprintf("disc-%s-%d", r.URL.Query().Get("page"), i),
				"individual_note": false,
				"notes": []map[string]any{{
					"id": 100 + i, "body": "comment", "system": false,
					"resolvable": true, "resolved": true,
					"author": map[string]any{"username": "reviewer1"},
				}},
			}
		}
		w.Header().Set("Link", fmt.Sprintf(`<http://%s/api/v4/projects/myorg%%2Fmyrepo/merge_requests/1/discussions?per_page=%d&page=next>; rel="next"`, r.Host, reviewDiscussionPageSize))
		json.NewEncoder(w).Encode(discs)
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"approved": false, "approvals_required": 0, "approved_by": []any{}})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	review, err := p.FetchReviewThreads(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	// 10 pages × 100 = 1000 threads, and the cap was hit so Partial must be true.
	if len(review.Threads) != maxPaginationPages*reviewDiscussionPageSize {
		t.Errorf("Threads = %d, want %d (10-page cap × page size)", len(review.Threads), maxPaginationPages*reviewDiscussionPageSize)
	}
	if !review.Partial {
		t.Error("Partial = false, want true (pagination cap hit — response is truncated)")
	}
}

// TestFetchPullRequests_TransientFailureReturnsError verifies that a transient
// failure on the MR detail endpoint is propagated as an error rather than being
// swallowed into a Fetched=false placeholder observation. The observer must
// reject failed observations to preserve last durable state
func TestFetchPullRequests_TransientFailureReturnsError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"message":"500 Internal Server Error"}`)
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	if err == nil {
		t.Fatal("FetchPullRequests: error = nil, want non-nil error for transient MR detail failure")
	}
	if len(obs) != 1 {
		t.Fatalf("got %d observations, want 1", len(obs))
	}
	if obs[0].Fetched {
		t.Error("expected Fetched=false on failed observation so observer can reject it")
	}
}

// TestFetchPullRequests_PipelineFailureReturnsError verifies that a transient
// failure on the pipelines endpoint is propagated as an error rather than
// silently degrading CI to "unknown" while Fetched stays true
func TestFetchPullRequests_PipelineFailureReturnsError(t *testing.T) {
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
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprint(w, `{"message":"502 Bad Gateway"}`)
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"approved": false, "approvals_required": 0, "approved_by": []any{}})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	if _, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref}); err == nil {
		t.Fatal("FetchPullRequests: error = nil, want non-nil error for transient pipeline failure")
	}
}

// TestFetchPullRequests_ApprovalFailureReturnsError verifies that a transient
// failure on the approvals endpoint is propagated as an error rather than
// silently degrading review to "none" while Fetched stays true
func TestFetchPullRequests_ApprovalFailureReturnsError(t *testing.T) {
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
		json.NewEncoder(w).Encode([]map[string]any{{"id": 100, "status": "success", "sha": "abc123"}})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{{"id": 200, "name": "build", "status": "success", "web_url": "https://gitlab.com/jobs/200"}})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"message":"503 Service Unavailable"}`)
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	if _, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref}); err == nil {
		t.Fatal("FetchPullRequests: error = nil, want non-nil error for transient approvals failure")
	}
}

// TestListPRsByRepo_UpdatedAfterAndStateAll verifies that ListPRsByRepo
// sends the updated_after (RFC3339) and state=all query parameters when an
// updatedAfter cursor is supplied
func TestListPRsByRepo_UpdatedAfterAndStateAll(t *testing.T) {
	var seenState, seenUpdatedAfter string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests", func(w http.ResponseWriter, r *http.Request) {
		seenState = r.URL.Query().Get("state")
		seenUpdatedAfter = r.URL.Query().Get("updated_after")
		json.NewEncoder(w).Encode([]map[string]any{})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	cursor := time.Date(2026, 1, 15, 10, 30, 0, 0, time.UTC)
	if _, err := p.ListPRsByRepo(context.Background(), repo, cursor); err != nil {
		t.Fatal(err)
	}
	if seenState != "all" {
		t.Errorf("state query param = %q, want %q (state=all for closed/merged MR discovery)", seenState, "all")
	}
	if seenUpdatedAfter == "" {
		t.Error("updated_after query param is empty, want RFC3339 timestamp")
	}
	// Verify it parses as a valid RFC3339 timestamp.
	parsed, err := time.Parse(time.RFC3339, seenUpdatedAfter)
	if err != nil {
		t.Fatalf("updated_after %q is not valid RFC3339: %v", seenUpdatedAfter, err)
	}
	if !parsed.Equal(cursor) {
		t.Errorf("updated_after = %v, want %v", parsed, cursor)
	}
}

// TestListPRsByRepo_FirstPollFullListing verifies that a zero updatedAfter
// (first poll) omits the updated_after param, requesting a full listing
func TestListPRsByRepo_FirstPollFullListing(t *testing.T) {
	var seenUpdatedAfter string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests", func(w http.ResponseWriter, r *http.Request) {
		seenUpdatedAfter = r.URL.Query().Get("updated_after")
		json.NewEncoder(w).Encode([]map[string]any{})
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	if _, err := p.ListPRsByRepo(context.Background(), repo, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if seenUpdatedAfter != "" {
		t.Errorf("updated_after = %q, want empty (first poll = full listing)", seenUpdatedAfter)
	}
}

// TestFetchPullRequests_ForkMR_ResolvesSourceProjectHeadRepo verifies that a
// fork merge request (source_project_id != target_project_id) resolves its
// head repository to the source project's path_with_namespace rather than the
// target project (review Item 4). Without this resolution, a fork MR with a
// matching branch name can pass AO's head-repository ownership guard against
// the wrong project.
func TestFetchPullRequests_ForkMR_ResolvesSourceProjectHeadRepo(t *testing.T) {
	var sourceProjectHits int
	mux := http.NewServeMux()
	// MR detail: source_project_id (99) differs from target_project_id (10)
	// — this is the signal that the MR comes from a fork.
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid":               1,
			"title":             "Fork contribution",
			"state":             "opened",
			"draft":             false,
			"web_url":           "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch":     "fix-bug",
			"target_branch":     "main",
			"sha":               "abc123",
			"merge_status":      "can_be_merged",
			"author":            map[string]any{"username": "alice"},
			"source_project_id": 99,
			"target_project_id": 10,
			"diff_refs":         map[string]any{"base_sha": "base123"},
		})
	})
	// Source project lookup: projects/:id returns path_with_namespace of the
	// fork the MR head branch lives in.
	mux.HandleFunc("/api/v4/projects/99", func(w http.ResponseWriter, r *http.Request) {
		sourceProjectHits++
		json.NewEncoder(w).Encode(map[string]any{
			"id":                  99,
			"path_with_namespace": "contributor/myrepo-fork",
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
		t.Fatalf("FetchPullRequests: unexpected error: %v", err)
	}
	if len(obs) != 1 {
		t.Fatalf("got %d observations, want 1", len(obs))
	}
	o := obs[0]
	if !o.Fetched {
		t.Fatal("expected Fetched=true for a fork MR with a resolvable source project")
	}
	// HeadRepo MUST be the source project's path_with_namespace, NOT the
	// target project repo (myorg/myrepo). This is the core of review Item 4:
	// without resolution, a fork MR with a matching branch name passes the
	// head-repository ownership guard against the wrong project.
	if got, want := o.PR.HeadRepo, "contributor/myrepo-fork"; got != want {
		t.Errorf("PR.HeadRepo = %q, want %q (source project path_with_namespace)", got, want)
	}
	// The source-project endpoint must actually have been queried once.
	if sourceProjectHits != 1 {
		t.Errorf("source project endpoint hits = %d, want 1", sourceProjectHits)
	}
}

// TestFetchPullRequests_NonForkMR_DoesNotFetchSourceProject verifies that a
// same-project MR (source_project_id == target_project_id) does NOT trigger a
// source-project fetch. The source-project resolution is exclusively for fork
// MRs; issuing it for same-repo MRs would be wasted work per poll (review
// Item 4 — no-cache, per-poll fetch is rare because fork MRs are a minority).
func TestFetchPullRequests_NonForkMR_DoesNotFetchSourceProject(t *testing.T) {
	var sourceProjectHits int
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid":               1,
			"title":             "Same-repo MR",
			"state":             "opened",
			"draft":             false,
			"web_url":           "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch":     "fix-bug",
			"target_branch":     "main",
			"sha":               "abc123",
			"merge_status":      "can_be_merged",
			"author":            map[string]any{"username": "alice"},
			"source_project_id": 10,
			"target_project_id": 10,
			"diff_refs":         map[string]any{"base_sha": "base123"},
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
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"approved": false, "approvals_required": 0, "approved_by": []any{}})
	})
	// Catch-all that fails the test if the source-project endpoint is hit at
	// all — the non-fork path must not issue this request.
	mux.HandleFunc("/api/v4/projects/10", func(w http.ResponseWriter, r *http.Request) {
		sourceProjectHits++
		t.Errorf("source project endpoint hit for non-fork MR; should not be fetched")
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	if err != nil {
		t.Fatalf("FetchPullRequests: unexpected error: %v", err)
	}
	if len(obs) != 1 || !obs[0].Fetched {
		t.Fatalf("expected one fetched observation, got %+v", obs)
	}
	// For a same-repo MR, HeadRepo stays the target repo (no fork resolution).
	if got, want := obs[0].PR.HeadRepo, "myorg/myrepo"; got != want {
		t.Errorf("PR.HeadRepo = %q, want %q (target repo for non-fork MR)", got, want)
	}
	if sourceProjectHits != 0 {
		t.Errorf("source project endpoint hits = %d, want 0 (non-fork MR must not trigger a fetch)", sourceProjectHits)
	}
}

// TestFetchPullRequests_ForkMR_SourceProjectFetchFails_FailClosed verifies
// that when a fork MR's source-project fetch fails (404 here, but the same
// applies to 5xx/timeout), the observation is marked Fetched=false with the
// error attached (ticket 03's obs.Error mechanism) and the head repository is
// NOT fabricated to the target project (review Item 4 — fail closed, do not
// falsify the head repository). This preserves the cross-cutting rule: a
// failed retrieval must not advance durable state.
func TestFetchPullRequests_ForkMR_SourceProjectFetchFails_FailClosed(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid":               1,
			"title":             "Fork with unresolvable source",
			"state":             "opened",
			"draft":             false,
			"web_url":           "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch":     "fix-bug",
			"target_branch":     "main",
			"sha":               "abc123",
			"merge_status":      "can_be_merged",
			"author":            map[string]any{"username": "alice"},
			"source_project_id": 99,
			"target_project_id": 10,
			"diff_refs":         map[string]any{"base_sha": "base123"},
		})
	})
	// Source project lookup 404s — e.g. the fork was deleted or made private.
	mux.HandleFunc("/api/v4/projects/99", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"message":"404 Project Not Found"}`)
	})
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	// A transient fetch failure must propagate as a non-nil error so the
	// observer preserves the last durable state rather than persisting a
	// falsified observation.
	if err == nil {
		t.Fatal("FetchPullRequests: error = nil, want non-nil for failed fork-MR source-project fetch")
	}
	if len(obs) != 1 {
		t.Fatalf("got %d observations, want 1", len(obs))
	}
	o := obs[0]
	if o.Fetched {
		t.Error("expected Fetched=false (fail closed) when source-project fetch fails")
	}
	// The error classification must be attached as transient per-observation
	// metadata (ticket 03 mechanism) so the observer can route it to
	// refresh-incomplete without discarding the classification.
	if o.Error == nil {
		t.Error("expected obs.Error set on failed fork-MR observation")
	}
	// HeadRepo must NOT be the target project repo — failing closed means we
	// do not fabricate the head repository for a fork whose source is
	// unresolvable. It should be empty (zero value), not "myorg/myrepo".
	if o.PR.HeadRepo != "" {
		t.Errorf("PR.HeadRepo = %q, want empty (must not fabricate head repo on fetch failure)", o.PR.HeadRepo)
	}
}

// TestFetchPullRequests_PipelineJobsTruncated_Partial verifies that when the
// pipeline-jobs pagination hits the 10-page cap (more than 1,000 jobs), the
// observation's CI.Partial flag is set to true so the observer does not
// authoritatively persist a capped snapshot as Fetched=true complete (review
// Item 13). The truncation flag comes from doGETPaginated's boolean return
// value — a separate code path from the rolling-tail byte bound (ticket 12).
// Durable checks must NOT be overwritten by the capped snapshot; that
// preservation is the observer's responsibility, gated by CI.Partial.
func TestFetchPullRequests_PipelineJobsTruncated_Partial(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid": 1, "title": "Fix bug", "state": "opened", "draft": false,
			"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch": "fix-bug", "target_branch": "main", "sha": "abc123",
			"merge_status": "mergeable", "detailed_merge_status": "mergeable",
			"author": map[string]any{"username": "alice"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{{"id": 100, "status": "success", "sha": "abc123"}})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
		// Always return a full page and always include a next link,
		// simulating a repo with more than 10 pages of pipeline jobs
		// (1,000+ jobs). The doGETPaginated loop hits the maxPaginationPages
		// cap and returns truncated=true.
		jobs := make([]map[string]any, pipelineJobsPageSize)
		for i := range jobs {
			jobs[i] = map[string]any{
				"id": 200 + i, "name": fmt.Sprintf("job-%s-%d", r.URL.Query().Get("page"), i),
				"status": "success", "web_url": fmt.Sprintf("https://gitlab.com/jobs/%d", 200+i),
			}
		}
		w.Header().Set("Link", fmt.Sprintf(`<http://%s/api/v4/projects/myorg%%2Fmyrepo/pipelines/100/jobs?per_page=%d&page=next>; rel="next"`, r.Host, pipelineJobsPageSize))
		json.NewEncoder(w).Encode(jobs)
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
	// 10 pages × 100 jobs = 1,000 jobs collected before the cap stopped the loop.
	if len(o.CI.Checks) != maxPaginationPages*pipelineJobsPageSize {
		t.Errorf("CI.Checks = %d, want %d (10-page cap × page size)", len(o.CI.Checks), maxPaginationPages*pipelineJobsPageSize)
	}
	// Partial MUST be true so the observer does not authoritatively persist the
	// capped snapshot as Fetched=true complete. Without this flag, more than
	// 1,000 jobs are treated as a complete CI snapshot and later failures can
	// be omitted while durable checks are overwritten.
	if !o.CI.Partial {
		t.Error("CI.Partial = false, want true (pagination cap hit — response is truncated)")
	}
}

// TestFetchPullRequests_AllowFailureJobNotActionable verifies that a job with
// allow_failure: true is classified as an optional failure and does NOT appear
// in FailedChecks when the pipeline succeeds (review Item 13). Optional failed
// jobs must not become actionable failed checks — they are informational, not
// blocking. The job still appears in Checks (full CI snapshot), but its failure
// is not promoted to an actionable failure.
func TestFetchPullRequests_AllowFailureJobNotActionable(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"iid": 1, "title": "Fix bug", "state": "opened", "draft": false,
			"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
			"source_branch": "fix-bug", "target_branch": "main", "sha": "abc123",
			"merge_status": "mergeable", "detailed_merge_status": "mergeable",
			"author": map[string]any{"username": "alice"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
		// Pipeline succeeds overall, even though one optional job failed.
		json.NewEncoder(w).Encode([]map[string]any{{"id": 100, "status": "success", "sha": "abc123"}})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 200, "name": "build", "status": "success", "web_url": "https://gitlab.com/jobs/200", "allow_failure": false},
			// Optional failed job — allow_failure: true. It must NOT appear in
			// FailedChecks because its failure is optional and the pipeline
			// succeeded.
			{"id": 201, "name": "flakey-e2e", "status": "failed", "web_url": "https://gitlab.com/jobs/201", "allow_failure": true},
			// Required failed job — allow_failure: false (or absent). This one
			// MUST appear in FailedChecks because its failure blocks the pipeline.
			// (The pipeline status is mocked to success for this test to isolate
			// the allow_failure classification; the classification logic operates
			// per-job regardless of the pipeline-level status.)
			{"id": 202, "name": "required-test", "status": "failed", "web_url": "https://gitlab.com/jobs/202", "allow_failure": false},
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
	// All three jobs appear in the full Checks snapshot.
	if len(o.CI.Checks) != 3 {
		t.Fatalf("CI.Checks = %d, want 3 (all jobs, including optional failures)", len(o.CI.Checks))
	}
	// Only the required failure (required-test) appears in FailedChecks.
	// The optional failure (flakey-e2e) must NOT be promoted to an
	// actionable failed check.
	if len(o.CI.FailedChecks) != 1 {
		t.Fatalf("FailedChecks = %d, want 1 (only the required failure; optional failures excluded)", len(o.CI.FailedChecks))
	}
	if o.CI.FailedChecks[0].Name != "required-test" {
		t.Errorf("FailedChecks[0].Name = %q, want %q (optional allow_failure job must not be actionable)", o.CI.FailedChecks[0].Name, "required-test")
	}
}

// TestFetchPullRequests_DiffStatsNotParsed verifies that the undocumented
// diff_stats object returned by the GitLab MR detail endpoint is NOT parsed
// into the observation's Additions/Deletions/ChangedFiles fields (review S2).
// GitLab does not document diff_stats as part of the MR detail response, so
// relying on it is fragile. The observation's diff-stat fields must be
// zero-valued unless sourced from a documented endpoint.
func TestFetchPullRequests_DiffStatsNotParsed(t *testing.T) {
	tests := []struct {
		name    string
		mrBody  map[string]any
		wantAdd int
		wantDel int
		wantChg int
	}{
		{
			name: "diff_stats absent",
			mrBody: map[string]any{
				"iid": 1, "title": "Fix bug", "state": "opened", "draft": false,
				"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
				"source_branch": "fix-bug", "target_branch": "main", "sha": "abc123",
				"merge_status": "can_be_merged", "author": map[string]any{"username": "alice"},
			},
			wantAdd: 0, wantDel: 0, wantChg: 0,
		},
		{
			name: "diff_stats present but ignored",
			mrBody: map[string]any{
				"iid": 1, "title": "Fix bug", "state": "opened", "draft": false,
				"web_url":       "https://gitlab.com/myorg/myrepo/-/merge_requests/1",
				"source_branch": "fix-bug", "target_branch": "main", "sha": "abc123",
				"merge_status": "can_be_merged", "author": map[string]any{"username": "alice"},
				// GitLab may return this undocumented object; it must be
				// ignored (not parsed) so the observation does not depend on
				// undocumented fields.
				"diff_stats": map[string]any{
					"additions": 42,
					"deletions": 7,
					"changes":   3,
				},
			},
			wantAdd: 0, wantDel: 0, wantChg: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(tt.mrBody)
			})
			mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode([]map[string]any{{"id": 100, "status": "success", "sha": "abc123"}})
			})
			mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode([]map[string]any{{"id": 200, "name": "build", "status": "success", "web_url": "https://gitlab.com/jobs/200"}})
			})
			mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{"approved": false, "approvals_required": 0, "approved_by": []any{}})
			})
			_, p := testServer(t, mux)
			repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
			ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

			obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
			if err != nil {
				t.Fatalf("FetchPullRequests: unexpected error: %v", err)
			}
			if len(obs) != 1 || !obs[0].Fetched {
				t.Fatalf("got %d observations, want 1 Fetched=true", len(obs))
			}
			pr := obs[0].PR
			if pr.Additions != tt.wantAdd {
				t.Errorf("PR.Additions = %d, want %d (diff_stats must not be parsed)", pr.Additions, tt.wantAdd)
			}
			if pr.Deletions != tt.wantDel {
				t.Errorf("PR.Deletions = %d, want %d (diff_stats must not be parsed)", pr.Deletions, tt.wantDel)
			}
			if pr.ChangedFiles != tt.wantChg {
				t.Errorf("PR.ChangedFiles = %d, want %d (diff_stats must not be parsed)", pr.ChangedFiles, tt.wantChg)
			}
		})
	}
}

// mrDetailFixture returns a GitLab MR JSON payload (as a Go map) suitable for
// both the list and detail endpoints — GitLab returns the same shape for the
// fields AO uses, which is what ticket 03's MR-detail cache relies on.
func mrDetailFixture(iid int, baseSHA string) map[string]any {
	return map[string]any{
		"iid":               iid,
		"title":             "Fix bug",
		"state":             "opened",
		"draft":             false,
		"web_url":           "https://gitlab.com/myorg/myrepo/-/merge_requests/" + strconv.Itoa(iid),
		"source_branch":     "fix-bug",
		"target_branch":     "main",
		"sha":               "abc123",
		"merge_status":      "can_be_merged",
		"author":            map[string]any{"username": "alice"},
		"source_project_id": 10,
		"target_project_id": 10,
		"diff_refs":         map[string]any{"base_sha": baseSHA, "head_sha": "abc123", "start_sha": "parent789"},
	}
}

// registerMRSupportingEndpoints wires the CI/approvals sub-fetch endpoints
// that FetchPullRequests calls after the MR detail. They return minimal
// success payloads so fetchSingleMR completes without error.
func registerMRSupportingEndpoints(mux *http.ServeMux) {
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 100, "status": "success", "sha": "abc123"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/pipelines/100/jobs", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 200, "name": "build", "status": "success", "web_url": "https://gitlab.com/jobs/200"},
		})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1/approvals", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"approved": true, "approvals_required": 1, "approved_by": []any{}})
	})
}

// TestFetchPullRequests_ReusesMRDetailFromListCache verifies ticket 03's core
// behavior: after ListPRsByRepo fetches the MR list, FetchPullRequests for one
// of the listed MRs within the MR-detail TTL does NOT issue a redundant
// GET /merge_requests/:iid. The cached restMR from the listing is a valid
// substitute for the detail response (same shape for the fields AO uses), and
// diff_refs.base_sha must be populated from the list payload.
func TestFetchPullRequests_ReusesMRDetailFromListCache(t *testing.T) {
	var mrDetailHits atomic.Int32
	mux := http.NewServeMux()
	// MR list endpoint returns the MR that will later be fetched by detail.
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests", func(w http.ResponseWriter, r *http.Request) {
		// state=all + pagination are fine; return one MR.
		json.NewEncoder(w).Encode([]map[string]any{mrDetailFixture(1, "base123")})
	})
	// MR detail endpoint — this is what ticket 03 must SKIP. If it is hit,
	// the test fails.
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		mrDetailHits.Add(1)
		json.NewEncoder(w).Encode(mrDetailFixture(1, "base123"))
	})
	registerMRSupportingEndpoints(mux)
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	// Populate the MR-detail cache via the listing.
	if _, err := p.ListPRsByRepo(context.Background(), repo, time.Time{}); err != nil {
		t.Fatalf("ListPRsByRepo: %v", err)
	}

	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}
	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	if err != nil {
		t.Fatalf("FetchPullRequests: %v", err)
	}
	if len(obs) != 1 || !obs[0].Fetched {
		t.Fatalf("expected one fetched observation, got %+v", obs)
	}
	// The MR detail endpoint must NOT have been hit — the list-cached restMR
	// is reused.
	if got := mrDetailHits.Load(); got != 0 {
		t.Errorf("MR detail endpoint hits = %d, want 0 (cached restMR from listing must be reused)", got)
	}
	// Base SHA must be populated from the list-cached restMR (acceptance
	// criterion: diff_refs.base_sha correctly populated when served from the
	// list cache).
	if got, want := obs[0].PR.BaseSHA, "base123"; got != want {
		t.Errorf("PR.BaseSHA = %q, want %q (served from list cache)", got, want)
	}
	// Sanity: the other observation fields are correct (the cached restMR is
	// a valid substitute for the detail response).
	if got, want := obs[0].PR.Number, 1; got != want {
		t.Errorf("PR.Number = %d, want %d", got, want)
	}
	if got, want := obs[0].PR.HeadSHA, "abc123"; got != want {
		t.Errorf("PR.HeadSHA = %q, want %q", got, want)
	}
}

// TestFetchPullRequests_ColdCache_FetchesMRDetailViaHTTP verifies the
// fallback path: with no prior listing (cold MR-detail cache), FetchPullRequests
// fetches the MR detail endpoint via HTTP and returns the correct result.
func TestFetchPullRequests_ColdCache_FetchesMRDetailViaHTTP(t *testing.T) {
	var mrDetailHits atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		mrDetailHits.Add(1)
		json.NewEncoder(w).Encode(mrDetailFixture(1, "base123"))
	})
	registerMRSupportingEndpoints(mux)
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}
	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}

	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	if err != nil {
		t.Fatalf("FetchPullRequests: %v", err)
	}
	if len(obs) != 1 || !obs[0].Fetched {
		t.Fatalf("expected one fetched observation, got %+v", obs)
	}
	// Cold cache → the MR detail endpoint MUST be hit exactly once.
	if got := mrDetailHits.Load(); got != 1 {
		t.Errorf("MR detail endpoint hits = %d, want 1 (cold cache must fall back to HTTP)", got)
	}
	if got, want := obs[0].PR.BaseSHA, "base123"; got != want {
		t.Errorf("PR.BaseSHA = %q, want %q", got, want)
	}
	if got, want := obs[0].PR.Number, 1; got != want {
		t.Errorf("PR.Number = %d, want %d", got, want)
	}
}

// TestFetchPullRequests_MRDetailCacheTTLExpiry verifies that after the
// MR-detail TTL elapses, a FetchPullRequests call falls back to the HTTP
// fetch even though ListPRsByRepo populated the cache earlier. This guards the
// staleness bound (~60s, one poll interval) and the miss → HTTP fallback path.
func TestFetchPullRequests_MRDetailCacheTTLExpiry(t *testing.T) {
	var mrDetailHits atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{mrDetailFixture(1, "base123")})
	})
	mux.HandleFunc("/api/v4/projects/myorg%2Fmyrepo/merge_requests/1", func(w http.ResponseWriter, r *http.Request) {
		mrDetailHits.Add(1)
		json.NewEncoder(w).Encode(mrDetailFixture(1, "base123"))
	})
	registerMRSupportingEndpoints(mux)
	_, p := testServer(t, mux)
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.com", Owner: "myorg", Name: "myrepo", Repo: "myorg/myrepo"}

	// Inject a controllable clock so TTL expiry is fast and deterministic
	// (no real sleeping). syntheticClock is defined in cache_test.go.
	clock := &syntheticClock{t: time.Now()}
	p.cache.now = clock.now

	// Populate the MR-detail cache via the listing.
	if _, err := p.ListPRsByRepo(context.Background(), repo, time.Time{}); err != nil {
		t.Fatalf("ListPRsByRepo: %v", err)
	}

	// Advance past the MR-detail TTL (60s). The cached entry must now be
	// treated as a miss.
	clock.advance(mrDetailCacheTTL + time.Second)

	ref := ports.SCMPRRef{Repo: repo, Number: 1, URL: "https://gitlab.com/myorg/myrepo/-/merge_requests/1"}
	obs, err := p.FetchPullRequests(context.Background(), []ports.SCMPRRef{ref})
	if err != nil {
		t.Fatalf("FetchPullRequests: %v", err)
	}
	if len(obs) != 1 || !obs[0].Fetched {
		t.Fatalf("expected one fetched observation, got %+v", obs)
	}
	// After TTL expiry, the MR detail endpoint MUST be hit (cache expired,
	// fell back to HTTP).
	if got := mrDetailHits.Load(); got != 1 {
		t.Errorf("MR detail endpoint hits = %d, want 1 (cache expired, must fall back to HTTP)", got)
	}
	if got, want := obs[0].PR.BaseSHA, "base123"; got != want {
		t.Errorf("PR.BaseSHA = %q, want %q (served from HTTP after expiry)", got, want)
	}
}

// TestRestMR_DiffRefsBaseSHA_FromListResponse verifies the restMR struct tag
// correctly parses diff_refs.base_sha from a GitLab MR list payload. The list
// and detail MR responses share the same shape for diff_refs, so this also
// covers the list path that the MR-detail cache (ticket 03) will rely on.
//
// This test is the regression guard for the dead-code dotted tag
// json:"diff_refs.base_sha" (Go does not do dotted JSON tag nesting).
func TestRestMR_DiffRefsBaseSHA_FromListResponse(t *testing.T) {
	payload := `[
	  {
	    "iid": 1,
	    "sha": "abc123",
	    "diff_refs": {
	      "base_sha": "base456",
	      "head_sha": "abc123",
	      "start_sha": "parent789"
	    }
	  }
	]`
	var mrs []restMR
	if err := json.Unmarshal([]byte(payload), &mrs); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(mrs) != 1 {
		t.Fatalf("got %d MRs, want 1", len(mrs))
	}
	mr := mrs[0]
	if mr.DiffRefs.BaseSHA != "base456" {
		t.Errorf("DiffRefs.BaseSHA = %q, want %q", mr.DiffRefs.BaseSHA, "base456")
	}
	if mr.DiffRefs.HeadSHA != "abc123" {
		t.Errorf("DiffRefs.HeadSHA = %q, want %q", mr.DiffRefs.HeadSHA, "abc123")
	}
	if mr.DiffRefs.StartSHA != "parent789" {
		t.Errorf("DiffRefs.StartSHA = %q, want %q", mr.DiffRefs.StartSHA, "parent789")
	}
}
