package gitlab

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestProviderPublishesReviewSummaryAndInlineDiscussions(t *testing.T) {
	var calls []string
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token := r.Header.Get("PRIVATE-TOKEN"); token != "test-token" {
			t.Fatalf("PRIVATE-TOKEN = %q", token)
		}
		calls = append(calls, r.Method+" "+r.URL.EscapedPath())
		switch r.Method + " " + r.URL.EscapedPath() {
		case "GET /projects/group%2Fsubgroup%2Frepo/merge_requests/42":
			_, _ = w.Write([]byte(`{"diff_refs":{"base_sha":"base-sha","start_sha":"start-sha","head_sha":"head-sha"}}`))
		case "POST /projects/group%2Fsubgroup%2Frepo/merge_requests/42/notes":
			var body struct {
				Body string `json:"body"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Body != "Fix these issues." {
				t.Fatalf("summary body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"id":321}`))
		case "POST /projects/group%2Fsubgroup%2Frepo/merge_requests/42/discussions":
			var body struct {
				Body     string `json:"body"`
				Position struct {
					PositionType string `json:"position_type"`
					BaseSHA      string `json:"base_sha"`
					StartSHA     string `json:"start_sha"`
					HeadSHA      string `json:"head_sha"`
					OldPath      string `json:"old_path"`
					NewPath      string `json:"new_path"`
					NewLine      int    `json:"new_line"`
				} `json:"position"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Body != "This can panic." || body.Position.PositionType != "text" ||
				body.Position.BaseSHA != "base-sha" || body.Position.StartSHA != "start-sha" ||
				body.Position.HeadSHA != "head-sha" || body.Position.OldPath != "main.go" ||
				body.Position.NewPath != "main.go" || body.Position.NewLine != 17 {
				t.Fatalf("discussion body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"id":"discussion-1"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	result, err := provider.PublishReview(context.Background(), ports.SCMPRRef{
		Repo:   ports.SCMRepo{Provider: "gitlab", Host: strings.TrimPrefix(server.URL, "http://"), Owner: "group/subgroup", Name: "repo", Repo: "group/subgroup/repo"},
		Number: 42,
	}, ports.ReviewPublication{
		TargetSHA: "head-sha",
		Verdict:   "changes_requested",
		Body:      "Fix these issues.",
		Findings:  []ports.ReviewFinding{{Path: "main.go", Line: 17, Body: "This can panic."}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Reference != "321" {
		t.Fatalf("reference = %q", result.Reference)
	}
	wantCalls := []string{
		"GET /projects/group%2Fsubgroup%2Frepo/merge_requests/42",
		"POST /projects/group%2Fsubgroup%2Frepo/merge_requests/42/notes",
		"POST /projects/group%2Fsubgroup%2Frepo/merge_requests/42/discussions",
	}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("calls = %#v, want %#v", calls, wantCalls)
	}
}

func TestProviderDoesNotPublishReviewWhenTargetChanged(t *testing.T) {
	var writes int
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writes++
		}
		_, _ = w.Write([]byte(`{"diff_refs":{"base_sha":"base","start_sha":"start","head_sha":"new-head"}}`))
	}))
	t.Cleanup(server.Close)

	_, err := provider.PublishReview(context.Background(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "gitlab", Host: strings.TrimPrefix(server.URL, "http://"), Repo: "group/repo"}, Number: 7,
	}, ports.ReviewPublication{TargetSHA: "old-head", Body: "review"})
	if !errors.Is(err, ErrPrecondition) {
		t.Fatalf("error = %v", err)
	}
	if writes != 0 {
		t.Fatalf("write requests = %d", writes)
	}
}

func TestProviderRejectsReviewForDifferentGitLabHost(t *testing.T) {
	var calls int
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"diff_refs":{"base_sha":"base","start_sha":"start","head_sha":"head"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":1}`))
	}))
	t.Cleanup(server.Close)

	_, err := provider.PublishReview(context.Background(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "gitlab", Host: "other.example.com", Repo: "group/repo"}, Number: 7,
	}, ports.ReviewPublication{TargetSHA: "head", Body: "review"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
	if calls != 0 {
		t.Fatalf("requests = %d, want none", calls)
	}
}

var _ ports.SCMReviewPublisher = (*Provider)(nil)
