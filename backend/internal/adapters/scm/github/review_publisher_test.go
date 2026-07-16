package github

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestProviderPublishesReviewWithInlineFindings(t *testing.T) {
	fake := newFakeGH(t)
	fake.on(http.MethodPost, "/repos/octocat/hello/pulls/42/reviews", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CommitID string `json:"commit_id"`
			Event    string `json:"event"`
			Body     string `json:"body"`
			Comments []struct {
				Path string `json:"path"`
				Line int    `json:"line"`
				Side string `json:"side"`
				Body string `json:"body"`
			} `json:"comments"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.CommitID != "head-sha" || body.Event != "COMMENT" || body.Body != "Fix these issues." {
			t.Fatalf("review body = %#v", body)
		}
		if len(body.Comments) != 1 || body.Comments[0].Path != "main.go" || body.Comments[0].Line != 17 ||
			body.Comments[0].Side != "RIGHT" || body.Comments[0].Body != "This can panic." {
			t.Fatalf("comments = %#v", body.Comments)
		}
		_, _ = w.Write([]byte(`{"id":987}`))
	})

	provider := newProviderForTest(t, fake)
	result, err := provider.PublishReview(ctx(), ports.SCMPRRef{
		Repo:   ports.SCMRepo{Provider: "github", Host: strings.TrimPrefix(fake.server.URL, "http://"), Owner: "octocat", Name: "hello", Repo: "octocat/hello"},
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
	if result.Reference != "987" {
		t.Fatalf("reference = %q", result.Reference)
	}
	calls := fake.calls()
	if len(calls) != 1 || calls[0].Header.Get("Authorization") != "Bearer tkn-test" {
		t.Fatalf("requests = %#v", calls)
	}
}

func TestProviderPublishReviewPreservesClientErrors(t *testing.T) {
	fake := newFakeGH(t)
	fake.on(http.MethodPost, "/repos/octocat/hello/pulls/42/reviews", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Bad credentials"}`))
	})

	provider := newProviderForTest(t, fake)
	_, err := provider.PublishReview(ctx(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "github", Host: strings.TrimPrefix(fake.server.URL, "http://"), Owner: "octocat", Name: "hello"}, Number: 42,
	}, ports.ReviewPublication{TargetSHA: "head-sha", Body: "review"})
	if !errors.Is(err, ErrAuthFailed) {
		t.Fatalf("error = %v", err)
	}
}

func TestProviderRejectsReviewForDifferentSCMConnection(t *testing.T) {
	fake := newFakeGH(t)
	fake.on(http.MethodPost, "/repos/octocat/hello/pulls/42/reviews", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":1}`))
	})
	provider := newProviderForTest(t, fake)

	_, err := provider.PublishReview(ctx(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "gitlab", Host: "gitlab.example.com", Owner: "octocat", Name: "hello"}, Number: 42,
	}, ports.ReviewPublication{TargetSHA: "head-sha", Body: "review"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
	if len(fake.calls()) != 0 {
		t.Fatalf("requests = %#v, want none", fake.calls())
	}
}

var _ ports.SCMReviewPublisher = (*Provider)(nil)
