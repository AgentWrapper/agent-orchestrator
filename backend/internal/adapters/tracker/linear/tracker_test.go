package linear

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestListTeams(t *testing.T) {
	srv := newGraphQLServer(t, func(w http.ResponseWriter, r *http.Request, req graphQLRequest) {
		if !strings.Contains(req.Query, "teams") {
			t.Fatalf("query = %s, want teams", req.Query)
		}
		writeGraphQL(t, w, map[string]any{"teams": map[string]any{
			"nodes": []map[string]any{{
				"id": "team-1", "key": "ENG", "name": "Engineering",
			}},
			"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
		}})
	})
	defer srv.Close()

	tracker := newTestTracker(t, srv.URL)
	teams, err := tracker.ListTeams(context.Background())
	if err != nil {
		t.Fatalf("ListTeams: %v", err)
	}
	if len(teams) != 1 || teams[0].ID != "team-1" || teams[0].Key != "ENG" || teams[0].Name != "Engineering" {
		t.Fatalf("teams = %#v", teams)
	}
}

func TestListFiltersByTeamAndAssignee(t *testing.T) {
	srv := newGraphQLServer(t, func(w http.ResponseWriter, r *http.Request, req graphQLRequest) {
		if got := req.Variables["teamId"]; got != "team-1" {
			t.Fatalf("teamId = %#v", got)
		}
		if got := req.Variables["assigneeId"]; got != "user-1" {
			t.Fatalf("assigneeId = %#v", got)
		}
		if !strings.Contains(req.Query, `orderBy: updatedAt`) {
			t.Fatalf("query = %s, want updatedAt ordering", req.Query)
		}
		if !strings.Contains(req.Query, `type: { in: ["triage", "backlog", "unstarted"] }`) {
			t.Fatalf("query = %s, want spawnable open state filter", req.Query)
		}
		if strings.Contains(req.Query, "nin") {
			t.Fatalf("query = %s, should not use broad non-closed filter", req.Query)
		}
		// team.id/assignee.id filters expect GraphQL ID; declaring them String!
		// makes Linear reject the query with GRAPHQL_VALIDATION_FAILED.
		if !strings.Contains(req.Query, `$teamId: ID!`) || !strings.Contains(req.Query, `$assigneeId: ID!`) {
			t.Fatalf("query = %s, want ID! typed team/assignee vars", req.Query)
		}
		if strings.Contains(req.Query, `String!`) {
			t.Fatalf("query = %s, filter vars must not be String!", req.Query)
		}
		writeGraphQL(t, w, map[string]any{"issues": map[string]any{
			"nodes": []map[string]any{{
				"id":          "uuid-1",
				"identifier":  "ENG-12",
				"title":       "Fix intake",
				"description": "Linear body",
				"url":         "https://linear.app/acme/issue/ENG-12/fix-intake",
				"state":       map[string]any{"type": "unstarted"},
				"assignee":    map[string]any{"id": "user-1", "displayName": "Ada"},
				"labels":      map[string]any{"nodes": []map[string]any{{"name": "bug"}}},
			}},
			"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
		}})
	})
	defer srv.Close()

	tracker := newTestTracker(t, srv.URL)
	issues, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderLinear, Native: "team-1"}, domain.ListFilter{
		State:    domain.ListOpen,
		Assignee: "user-1",
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(issues) != 1 {
		t.Fatalf("issues = %#v", issues)
	}
	issue := issues[0]
	if issue.ID.Provider != domain.TrackerProviderLinear || issue.ID.Native != "ENG-12" || issue.State != domain.IssueOpen {
		t.Fatalf("issue = %#v", issue)
	}
	if len(issue.Assignees) == 0 || issue.Assignees[0] != "user-1" {
		t.Fatalf("assignees = %#v", issue.Assignees)
	}
}

func TestRateLimitErrorIncludesResetHints(t *testing.T) {
	reset := time.Date(2026, 7, 13, 12, 30, 0, 0, time.UTC)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.Header().Set("X-RateLimit-Endpoint-Requests-Reset", formatEpochMillis(reset))
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	tracker := newTestTracker(t, srv.URL)
	_, err := tracker.List(context.Background(), domain.TrackerRepo{Provider: domain.TrackerProviderLinear, Native: "team-1"}, domain.ListFilter{State: domain.ListOpen})
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}
	var rateErr *RateLimitError
	if !errors.As(err, &rateErr) {
		t.Fatalf("err = %#v, want RateLimitError", err)
	}
	if rateErr.RetryAfter != 2*time.Minute {
		t.Fatalf("RetryAfter = %v, want 2m", rateErr.RetryAfter)
	}
	if !rateErr.ResetAt.Equal(reset) {
		t.Fatalf("ResetAt = %v, want %v", rateErr.ResetAt, reset)
	}
}

func TestAuthFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer srv.Close()

	tracker := newTestTracker(t, srv.URL)
	if _, err := tracker.AuthenticatedUser(context.Background()); err == nil || !strings.Contains(err.Error(), ErrAuthFailed.Error()) {
		t.Fatalf("AuthenticatedUser err = %v, want auth failure", err)
	}
}

func formatEpochMillis(t time.Time) string {
	return strconv.FormatInt(t.UnixMilli(), 10)
}

func newTestTracker(t *testing.T, url string) *Tracker {
	t.Helper()
	tracker, err := New(Options{Token: StaticTokenSource("lin_key"), BaseURL: url, HTTPClient: srvClient()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return tracker
}

func srvClient() *http.Client {
	return &http.Client{}
}

func newGraphQLServer(t *testing.T, fn func(http.ResponseWriter, *http.Request, graphQLRequest)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "lin_key" {
			t.Fatalf("Authorization = %q", got)
		}
		var req graphQLRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		fn(w, r, req)
	}))
}

func writeGraphQL(t *testing.T, w http.ResponseWriter, data any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{"data": data}); err != nil {
		t.Fatalf("encode response: %v", err)
	}
}
