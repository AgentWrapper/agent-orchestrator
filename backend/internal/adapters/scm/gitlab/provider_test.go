package gitlab

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func newTestProvider(t *testing.T, handler http.Handler, opts ...func(*ProviderOptions)) (*Provider, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	options := ProviderOptions{
		Client:     NewClient(ClientOptions{BaseURL: server.URL, Token: StaticTokenSource("test-token")}),
		WebBaseURL: server.URL,
	}
	for _, apply := range opts {
		apply(&options)
	}
	provider, err := NewProvider(options)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	return provider, server
}

func TestProviderParseRepositoryAndMergeRequestRef(t *testing.T) {
	t.Parallel()
	provider, err := NewProvider(ProviderOptions{
		Client:     NewClient(ClientOptions{BaseURL: "https://gitlab.example.com/api/v4", Token: StaticTokenSource("token")}),
		WebBaseURL: "https://gitlab.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	wantRepo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.example.com", Owner: "group/subgroup", Name: "project", Repo: "group/subgroup/project"}
	for _, remote := range []string{
		"https://gitlab.example.com/group/subgroup/project.git",
		"ssh://git@gitlab.example.com/group/subgroup/project.git",
		"git@gitlab.example.com:group/subgroup/project.git",
		"group/subgroup/project",
	} {
		t.Run(remote, func(t *testing.T) {
			got, ok := provider.ParseRepository(remote)
			if !ok || got != wantRepo {
				t.Fatalf("ParseRepository(%q) = %#v, %v", remote, got, ok)
			}
		})
	}
	for _, remote := range []string{
		"https://wrong.example.com/group/subgroup/project.git",
		"git@wrong.example.com:group/subgroup/project.git",
		"group/project/-/merge_requests/1",
		"../group/project",
	} {
		if got, ok := provider.ParseRepository(remote); ok {
			t.Fatalf("ParseRepository(%q) = %#v, true", remote, got)
		}
	}

	for _, input := range []string{
		"https://gitlab.example.com/group/subgroup/project/-/merge_requests/42",
		"group/subgroup/project!42",
		"!42",
		"42",
	} {
		t.Run("mr "+input, func(t *testing.T) {
			got, ok := provider.ParseMergeRequestRef(input, wantRepo)
			if !ok || got.Number != 42 || got.Repo != wantRepo || got.URL != "https://gitlab.example.com/group/subgroup/project/-/merge_requests/42" {
				t.Fatalf("ParseMergeRequestRef(%q) = %#v, %v", input, got, ok)
			}
			change, changeOK := provider.ParseChangeRef(input, wantRepo)
			if !changeOK || change != got {
				t.Fatalf("ParseChangeRef(%q) = %#v, %v", input, change, changeOK)
			}
		})
	}
	withoutContext, ok := provider.ParseChangeRef("https://gitlab.example.com/group/subgroup/project/-/merge_requests/42", ports.SCMRepo{})
	if !ok || withoutContext.Repo != wantRepo || withoutContext.Number != 42 {
		t.Fatalf("ParseChangeRef without context = %#v, %v", withoutContext, ok)
	}
	for _, input := range []string{
		"https://wrong.example.com/group/subgroup/project/-/merge_requests/42",
		"group/other!42",
		"!0",
		"anything",
	} {
		if got, ok := provider.ParseMergeRequestRef(input, wantRepo); ok {
			t.Fatalf("ParseMergeRequestRef(%q) = %#v, true", input, got)
		}
	}
}

func TestNormalizeRawDiffCountsPatchLinesAndBinaryFiles(t *testing.T) {
	t.Parallel()
	raw := []byte("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n same\n-old\n+new\n+added\ndiff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n")
	stats := normalizeRawDiff(raw)
	if stats.Additions != 2 || stats.Deletions != 1 || stats.ChangedFiles != 2 || !stats.Complete {
		t.Fatalf("stats = %#v", stats)
	}
	if got := normalizeRawDiff([]byte("not a unified diff")); got.Complete {
		t.Fatalf("malformed stats = %#v", got)
	}
}

func TestListOpenMergeRequestsUsesForkSourceProject(t *testing.T) {
	t.Parallel()
	var paths []string
	var mu sync.Mutex
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.EscapedPath())
		mu.Unlock()
		switch r.URL.EscapedPath() {
		case "/projects/group%2Ftarget%2Frepo/merge_requests":
			_, _ = w.Write([]byte(`[
				{"iid":7,"state":"opened","source_branch":"ao/p/work","target_branch":"main","sha":"head","source_project_id":22,"target_project_id":11,"web_url":"https://gitlab.example.com/group/target/repo/-/merge_requests/7","title":"fork","author":{"username":"alice"}},
				{"iid":8,"state":"opened","source_branch":"ao/p/local","target_branch":"main","sha":"local","source_project_id":11,"target_project_id":11,"web_url":"https://gitlab.example.com/group/target/repo/-/merge_requests/8","title":"local","author":{"username":"bob"}}
			]`))
		case "/projects/22":
			_, _ = w.Write([]byte(`{"id":22,"path_with_namespace":"alice/fork"}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider, server := newTestProvider(t, handler, func(o *ProviderOptions) { o.WebBaseURL = "https://gitlab.example.com" })
	defer server.Close()

	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.example.com", Owner: "group/target", Name: "repo", Repo: "group/target/repo"}
	got, err := provider.ListOpenPRsByRepo(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].HeadRepo != "alice/fork" || got[1].HeadRepo != repo.Repo {
		t.Fatalf("MRs = %#v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	sort.Strings(paths)
	if !reflect.DeepEqual(paths, []string{"/projects/22", "/projects/group%2Ftarget%2Frepo/merge_requests"}) {
		t.Fatalf("paths = %v", paths)
	}
}

func TestFetchPullRequestsNormalizesDetailDiffCIAndApprovals(t *testing.T) {
	t.Parallel()
	var sawFallback atomic.Bool
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.EscapedPath() {
		case "/projects/group%2Frepo/merge_requests/4":
			_, _ = w.Write([]byte(`{
				"iid":4,"state":"opened","draft":false,"title":"ship it","web_url":"https://gitlab.example.com/group/repo/-/merge_requests/4",
				"source_branch":"feature","target_branch":"main","sha":"new-sha","source_project_id":1,"target_project_id":1,
				"diff_refs":{"base_sha":"base-sha","head_sha":"new-sha"},"author":{"username":"alice"},
				"detailed_merge_status":"mergeable","has_conflicts":false,"diverged_commits_count":0,
				"created_at":"2026-07-10T10:00:00Z","updated_at":"2026-07-11T10:00:00Z"
			}`))
		case "/projects/group%2Frepo/merge_requests/4/raw_diffs":
			_, _ = w.Write([]byte("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-old\n+new\n+next\n"))
		case "/projects/group%2Frepo/merge_requests/4/pipelines":
			_, _ = w.Write([]byte(`[
				{"id":9,"sha":"old-sha","status":"success","updated_at":"2026-07-12T10:00:00Z"},
				{"id":10,"sha":"new-sha","status":"success","updated_at":"2026-07-12T09:00:00Z"}
			]`))
		case "/projects/group%2Frepo/pipelines":
			sawFallback.Store(true)
			_, _ = w.Write([]byte(`[]`))
		case "/projects/group%2Frepo/pipelines/10/jobs":
			_, _ = w.Write([]byte(`[{"id":101,"name":"test","status":"success","web_url":"https://gitlab.example.com/job/101"}]`))
		case "/projects/group%2Frepo/pipelines/10/bridges":
			_, _ = w.Write([]byte(`[]`))
		case "/projects/group%2Frepo/merge_requests/4/approvals":
			_, _ = w.Write([]byte(`{"approved":true,"approvals_left":0,"approved_by":[{"user":{"id":5,"username":"reviewer","bot":false}}]}`))
		default:
			http.NotFound(w, r)
		}
	})
	provider, server := newTestProvider(t, handler, func(o *ProviderOptions) { o.WebBaseURL = "https://gitlab.example.com" })
	defer server.Close()
	repo := ports.SCMRepo{Provider: "gitlab", Host: "gitlab.example.com", Owner: "group", Name: "repo", Repo: "group/repo"}
	got, err := provider.FetchPullRequests(context.Background(), []ports.SCMPRRef{{Repo: repo, Number: 4}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("observations = %#v", got)
	}
	obs := got[0]
	if !obs.Fetched || obs.Provider != "gitlab" || obs.Repo != "group/repo" || obs.PR.Number != 4 || obs.PR.HeadSHA != "new-sha" || obs.PR.BaseSHA != "base-sha" {
		t.Fatalf("observation = %#v", obs)
	}
	if obs.PR.Additions != 2 || obs.PR.Deletions != 1 || obs.PR.ChangedFiles != 1 || !obs.PR.DiffStatsComplete {
		t.Fatalf("diff stats = %#v", obs.PR)
	}
	if obs.CI.Summary != string(domain.CIPassing) || len(obs.CI.Checks) != 1 || obs.CI.Checks[0].ProviderID != "101" || obs.CI.HeadSHA != "new-sha" {
		t.Fatalf("CI = %#v", obs.CI)
	}
	if obs.Review.Decision != string(domain.ReviewApproved) || obs.Mergeability.State != string(domain.MergeMergeable) || !obs.Mergeability.Mergeable {
		t.Fatalf("review=%#v mergeability=%#v", obs.Review, obs.Mergeability)
	}
	if sawFallback.Load() {
		t.Fatal("branch pipeline fallback used despite a current-head MR pipeline")
	}
}

func TestFetchPullRequestsBoundsConcurrencyAndSkipsNotFound(t *testing.T) {
	t.Parallel()
	var current, maximum atomic.Int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.EscapedPath(), "/merge_requests/") {
			http.NotFound(w, r)
			return
		}
		now := current.Add(1)
		for {
			old := maximum.Load()
			if now <= old || maximum.CompareAndSwap(old, now) {
				break
			}
		}
		time.Sleep(15 * time.Millisecond)
		current.Add(-1)
		if strings.HasSuffix(r.URL.Path, "/3") {
			http.NotFound(w, r)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/raw_diffs") {
			_, _ = w.Write([]byte("diff --git a/a b/a\n--- a/a\n+++ b/a\n"))
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		iid := parts[len(parts)-1]
		_, _ = fmt.Fprintf(w, `{"iid":%s,"state":"closed","sha":"s%s","source_branch":"f%s","target_branch":"main","source_project_id":1,"target_project_id":1,"detailed_merge_status":"not_open"}`, iid, iid, iid)
	})
	provider, server := newTestProvider(t, handler, func(o *ProviderOptions) { o.MaxConcurrency = 4 })
	defer server.Close()
	repo := ports.SCMRepo{Provider: "gitlab", Host: strings.TrimPrefix(server.URL, "http://"), Owner: "g", Name: "r", Repo: "g/r"}
	refs := make([]ports.SCMPRRef, 12)
	for i := range refs {
		refs[i] = ports.SCMPRRef{Repo: repo, Number: i + 1}
	}
	got, err := provider.FetchPullRequests(context.Background(), refs)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 11 || got[0].PR.Number != 1 || got[1].PR.Number != 2 || got[2].PR.Number != 4 {
		t.Fatalf("observations = %#v", got)
	}
	if maximum.Load() > 4 {
		t.Fatalf("maximum concurrency = %d", maximum.Load())
	}
}

func TestPipelineNormalizationStateMatrixAndFallback(t *testing.T) {
	t.Parallel()
	tests := []struct {
		status string
		want   domain.PRCheckStatus
	}{
		{"success", domain.PRCheckPassed}, {"failed", domain.PRCheckFailed}, {"canceled", domain.PRCheckCancelled},
		{"created", domain.PRCheckQueued}, {"waiting_for_resource", domain.PRCheckQueued}, {"preparing", domain.PRCheckQueued},
		{"pending", domain.PRCheckQueued}, {"scheduled", domain.PRCheckQueued}, {"running", domain.PRCheckInProgress},
		{"skipped", domain.PRCheckSkipped}, {"manual", domain.PRCheckUnknown}, {"mystery", domain.PRCheckUnknown},
	}
	for _, tc := range tests {
		if got := normalizeJobStatus(tc.status); got != tc.want {
			t.Errorf("normalizeJobStatus(%q) = %q, want %q", tc.status, got, tc.want)
		}
	}
	checks := []ports.SCMCheckObservation{
		{Name: "ok", Status: string(domain.PRCheckPassed)},
		{Name: "wait", Status: string(domain.PRCheckInProgress)},
		{Name: "fail", Status: string(domain.PRCheckCancelled)},
	}
	if got := aggregateCI("success", checks); got != domain.CIFailing {
		t.Fatalf("aggregateCI = %q", got)
	}
	if got := aggregateCI("success", checks[:2]); got != domain.CIPending {
		t.Fatalf("aggregateCI pending = %q", got)
	}
	if got := aggregateCI("success", checks[:1]); got != domain.CIPassing {
		t.Fatalf("aggregateCI passing = %q", got)
	}
	if got := aggregateCI("success", []ports.SCMCheckObservation{{Status: string(domain.PRCheckUnknown)}}); got != domain.CIUnknown {
		t.Fatalf("aggregateCI unknown = %q", got)
	}
}

func TestFetchCIIgnoresOldSHAAndUsesCurrentBranchPipeline(t *testing.T) {
	t.Parallel()
	var fallbackQuery string
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.EscapedPath() {
		case "/projects/group%2Frepo/merge_requests/4/pipelines":
			_, _ = w.Write([]byte(`[{"id":1,"sha":"old","status":"success","updated_at":"2026-07-12T12:00:00Z"}]`))
		case "/projects/group%2Frepo/pipelines":
			fallbackQuery = r.URL.RawQuery
			_, _ = w.Write([]byte(`[{"id":2,"sha":"head","status":"running","updated_at":"2026-07-12T11:00:00Z"}]`))
		case "/projects/group%2Frepo/pipelines/2/jobs":
			_, _ = w.Write([]byte(`[{"id":20,"name":"test","status":"running"}]`))
		case "/projects/group%2Frepo/pipelines/2/bridges":
			_, _ = w.Write([]byte(`[{"id":21,"name":"child","status":"pending","downstream_pipeline":{"id":3,"sha":"head","status":"failed"}}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	ci, err := provider.fetchCI(context.Background(), ports.SCMRepo{Provider: "gitlab", Repo: "group/repo"}, 4, "head")
	if err != nil {
		t.Fatal(err)
	}
	if ci.Summary != string(domain.CIFailing) || ci.HeadSHA != "head" || len(ci.FailedChecks) != 1 || ci.FailedChecks[0].Name != "child" {
		t.Fatalf("CI = %#v", ci)
	}
	query, _ := url.ParseQuery(fallbackQuery)
	if query.Get("sha") != "head" {
		t.Fatalf("fallback query = %q", fallbackQuery)
	}
}

func TestFetchPullRequestReportsIncompleteDiffWhenRawResponseIsOversized(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.EscapedPath() {
		case "/projects/group%2Frepo/merge_requests/4":
			_, _ = w.Write([]byte(`{"iid":4,"state":"closed","sha":"head","source_project_id":1,"target_project_id":1}`))
		case "/projects/group%2Frepo/merge_requests/4/raw_diffs":
			_, _ = w.Write([]byte("diff --git a/a b/a\n--- a/a\n+++ b/a\n+many bytes beyond the configured raw limit\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	provider, err := NewProvider(ProviderOptions{
		Client:     NewClient(ClientOptions{BaseURL: server.URL, Token: StaticTokenSource("token"), MaxRawBytes: 8}),
		WebBaseURL: server.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := provider.FetchPullRequests(context.Background(), []ports.SCMPRRef{{Repo: ports.SCMRepo{Provider: "gitlab", Repo: "group/repo"}, Number: 4}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].PR.DiffStatsComplete || got[0].PR.Additions != 0 || got[0].PR.ChangedFiles != 0 {
		t.Fatalf("observation = %#v", got)
	}
}

func TestFailedCheckTraceTailIsBoundedUTF8AndScrubbed(t *testing.T) {
	t.Parallel()
	lines := make([]string, 25)
	for i := range lines {
		lines[i] = fmt.Sprintf("line-%02d", i)
	}
	lines[23] = "PRIVATE-TOKEN: very-secret"
	trace := strings.Join(lines, "\n") + string([]byte{0xff, 0xfe})
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/projects/group%2Frepo/jobs/88/trace" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(trace))
	}))
	defer server.Close()
	repo := ports.SCMRepo{Provider: "gitlab", Repo: "group/repo"}
	got, err := provider.FetchFailedCheckLogTail(context.Background(), repo, ports.SCMCheckObservation{ProviderID: "88"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(got, "\n") > 19 || strings.Contains(got, "very-secret") || strings.ContainsRune(got, '\ufffd') {
		t.Fatalf("tail = %q", got)
	}
	if !strings.Contains(got, "line-06") || !strings.Contains(got, "PRIVATE-TOKEN: [REDACTED]") {
		t.Fatalf("tail = %q", got)
	}
}

func TestFetchReviewThreadsFiltersSystemAndBotAndMarksPartial(t *testing.T) {
	t.Parallel()
	var pages atomic.Int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.EscapedPath() {
		case "/projects/group%2Frepo/merge_requests/4":
			_, _ = w.Write([]byte(`{"iid":4,"web_url":"https://gitlab.example.com/group/repo/-/merge_requests/4","detailed_merge_status":"discussions_not_resolved"}`))
		case "/projects/group%2Frepo/merge_requests/4/approvals":
			_, _ = w.Write([]byte(`{"approved":false,"approvals_left":1,"approved_by":[]}`))
		case "/projects/group%2Frepo/merge_requests/4/discussions":
			page := pages.Add(1)
			if page == 1 {
				w.Header().Set("X-Next-Page", "2")
				_, _ = w.Write([]byte(`[
					{"id":"system","notes":[{"id":1,"system":true,"body":"changed title","author":{"username":"root"}}]},
					{"id":"bot","notes":[{"id":2,"resolvable":true,"resolved":false,"body":"automation","author":{"username":"ci","bot":true}}]},
					{"id":"human","notes":[{"id":3,"resolvable":true,"resolved":false,"body":"please fix","web_url":"https://gitlab.example.com/note/3","position":{"new_path":"a.go","new_line":12},"author":{"username":"alice","bot":false}}]}
				]`))
				return
			}
			w.Header().Set("X-Next-Page", "3")
			_, _ = w.Write([]byte(`[{"id":"resolved","notes":[{"id":4,"resolvable":true,"resolved":true,"body":"done","author":{"username":"bob","bot":false}}]}]`))
		default:
			http.NotFound(w, r)
		}
	})
	provider, server := newTestProvider(t, handler, func(o *ProviderOptions) {
		o.WebBaseURL = "https://gitlab.example.com"
		o.MaxDiscussionPages = 2
	})
	defer server.Close()
	repo := ports.SCMRepo{Provider: "gitlab", Repo: "group/repo"}
	got, err := provider.FetchReviewThreads(context.Background(), ports.SCMPRRef{Repo: repo, Number: 4})
	if err != nil {
		t.Fatal(err)
	}
	if got.Decision != string(domain.ReviewRequired) || !got.Partial || len(got.Threads) != 2 {
		t.Fatalf("review = %#v", got)
	}
	if got.Threads[0].ID != "human" || got.Threads[0].Resolved || got.Threads[0].IsBot || got.Threads[0].Path != "a.go" || got.Threads[0].Line != 12 {
		t.Fatalf("human thread = %#v", got.Threads[0])
	}
	if got.Threads[1].ID != "resolved" || !got.Threads[1].Resolved {
		t.Fatalf("resolved thread = %#v", got.Threads[1])
	}
}

func TestMergeabilityStateMatrixIsStrict(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		status     string
		conflicts  bool
		draft      bool
		ci         domain.CIState
		review     domain.ReviewDecision
		approvals  bool
		want       domain.Mergeability
		blocker    string
		behindBase bool
	}{
		{"ready", "mergeable", false, false, domain.CIPassing, domain.ReviewApproved, true, domain.MergeMergeable, "", false},
		{"conflict status", "conflict", false, false, domain.CIPassing, domain.ReviewApproved, true, domain.MergeConflicting, "conflicts", false},
		{"conflict flag", "mergeable", true, false, domain.CIPassing, domain.ReviewApproved, true, domain.MergeConflicting, "conflicts", false},
		{"rebase", "need_rebase", false, false, domain.CIPassing, domain.ReviewApproved, true, domain.MergeBlocked, "behind_base", true},
		{"checking", "checking", false, false, domain.CIPassing, domain.ReviewApproved, true, domain.MergeUnknown, "checking", false},
		{"not approved", "not_approved", false, false, domain.CIPassing, domain.ReviewRequired, false, domain.MergeBlocked, "review_required", false},
		{"requested changes", "requested_changes", false, false, domain.CIPassing, domain.ReviewChangesRequest, false, domain.MergeBlocked, "changes_requested", false},
		{"discussion", "discussions_not_resolved", false, false, domain.CIPassing, domain.ReviewApproved, true, domain.MergeBlocked, "discussions_not_resolved", false},
		{"draft", "mergeable", false, true, domain.CIPassing, domain.ReviewApproved, true, domain.MergeBlocked, "draft", false},
		{"pending CI", "mergeable", false, false, domain.CIPending, domain.ReviewApproved, true, domain.MergeBlocked, "ci_pending", false},
		{"unknown CI", "mergeable", false, false, domain.CIUnknown, domain.ReviewApproved, true, domain.MergeUnknown, "ci_unknown", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeMergeability(tc.status, tc.conflicts, tc.draft, tc.ci, tc.review, tc.approvals)
			if domain.Mergeability(got.State) != tc.want || got.BehindBase != tc.behindBase || (tc.want == domain.MergeMergeable) != got.Mergeable {
				t.Fatalf("mergeability = %#v", got)
			}
			if tc.blocker != "" && !containsString(got.Blockers, tc.blocker) {
				t.Fatalf("blockers = %v, want %q", got.Blockers, tc.blocker)
			}
		})
	}
}

func TestProviderRequiresClientAndValidWebBase(t *testing.T) {
	t.Parallel()
	for _, options := range []ProviderOptions{
		{},
		{Client: NewClient(ClientOptions{Token: StaticTokenSource("token")}), WebBaseURL: "http://gitlab.example.com"},
		{Client: NewClient(ClientOptions{Token: StaticTokenSource("token")}), WebBaseURL: "https://user:pass@gitlab.example.com?q=x"},
	} {
		if _, err := NewProvider(options); err == nil {
			t.Fatalf("NewProvider(%#v) error = nil", options)
		}
	}
}

func TestRepoPRListGuardUsesETagConditionally(t *testing.T) {
	t.Parallel()
	var gotIfNoneMatch string
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotIfNoneMatch = r.Header.Get("If-None-Match")
		w.Header().Set("ETag", `"revision-1"`)
		if gotIfNoneMatch == `"revision-1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()
	repo := ports.SCMRepo{Provider: "gitlab", Repo: "group/repo"}
	guard, err := provider.RepoPRListGuard(context.Background(), repo, `"revision-1"`)
	if err != nil {
		t.Fatal(err)
	}
	if gotIfNoneMatch != `"revision-1"` || !guard.NotModified || guard.ETag != `"revision-1"` {
		t.Fatalf("If-None-Match=%q guard=%#v", gotIfNoneMatch, guard)
	}
}

func TestFetchPullRequestsMarksDivergedHeadBehindBase(t *testing.T) {
	t.Parallel()
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.EscapedPath() {
		case "/projects/group%2Frepo/merge_requests/4":
			_, _ = w.Write([]byte(`{"iid":4,"state":"opened","sha":"head","source_branch":"feat","target_branch":"main","source_project_id":1,"target_project_id":1,"detailed_merge_status":"mergeable","diverged_commits_count":2}`))
		case "/projects/group%2Frepo/merge_requests/4/raw_diffs":
			_, _ = w.Write([]byte("diff --git a/a b/a\n--- a/a\n+++ b/a\n"))
		case "/projects/group%2Frepo/merge_requests/4/pipelines":
			_, _ = w.Write([]byte(`[{"id":1,"sha":"head","status":"success"}]`))
		case "/projects/group%2Frepo/pipelines/1/jobs", "/projects/group%2Frepo/pipelines/1/bridges":
			_, _ = w.Write([]byte(`[{"id":2,"name":"test","status":"success"}]`))
		case "/projects/group%2Frepo/merge_requests/4/approvals":
			_, _ = w.Write([]byte(`{"approved":true,"approvals_left":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	repo := ports.SCMRepo{Provider: "gitlab", Repo: "group/repo"}
	got, err := provider.FetchPullRequests(context.Background(), []ports.SCMPRRef{{Repo: repo, Number: 4}})
	if err != nil {
		t.Fatal(err)
	}
	mergeability := got[0].Mergeability
	if mergeability.State != string(domain.MergeBlocked) || !mergeability.BehindBase || !containsString(mergeability.Blockers, "behind_base") {
		t.Fatalf("mergeability = %#v", mergeability)
	}
}

func TestFetchReviewThreadsRejectsMalformedNextPage(t *testing.T) {
	t.Parallel()
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"approved":true,"approvals_left":0}`))
		case strings.HasSuffix(r.URL.Path, "/discussions"):
			w.Header().Set("X-Next-Page", "not-a-page")
			_, _ = w.Write([]byte(`[]`))
		default:
			_, _ = w.Write([]byte(`{"iid":4,"detailed_merge_status":"mergeable"}`))
		}
	}))
	defer server.Close()
	_, err := provider.FetchReviewThreads(context.Background(), ports.SCMPRRef{Repo: ports.SCMRepo{Provider: "gitlab", Repo: "group/repo"}, Number: 4})
	if !errors.Is(err, ErrInvalidPagination) {
		t.Fatalf("err = %v", err)
	}
}

func TestFetchFailedCheckLogTailReturnsBoundedErrors(t *testing.T) {
	t.Parallel()
	for _, code := range []int{http.StatusForbidden, http.StatusNotFound} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }))
			defer server.Close()
			_, err := provider.FetchFailedCheckLogTail(context.Background(), ports.SCMRepo{Repo: "g/r"}, ports.SCMCheckObservation{ProviderID: "1"})
			if code == http.StatusForbidden && !errors.Is(err, ErrForbidden) {
				t.Fatalf("err = %v", err)
			}
			if code == http.StatusNotFound && !errors.Is(err, ports.ErrSCMNotFound) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
