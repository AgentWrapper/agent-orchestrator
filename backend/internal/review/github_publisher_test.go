package review

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestGitHubReviewPublisherPostsInlineFinding(t *testing.T) {
	var gotArgs []string
	var gotInput []byte
	publisher := &githubReviewPublisher{execute: func(_ context.Context, args []string, input []byte) ([]byte, error) {
		gotArgs = append([]string(nil), args...)
		gotInput = append([]byte(nil), input...)
		return []byte(`{"id":12345}`), nil
	}}

	id, err := publisher.Publish(context.Background(), "https://github.com/acme/widgets/pull/42", "deadbeef", "## Greptile review", []ports.ReviewComment{{
		Path: "pkg/widget.go", StartLine: 10, EndLine: 12, Side: "RIGHT", Body: "This can panic.", Suggestion: "Guard the nil value.",
	}})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if id != "12345" {
		t.Fatalf("id = %q, want 12345", id)
	}
	if len(gotArgs) != 7 || gotArgs[0] != "gh" || gotArgs[1] != "api" || gotArgs[len(gotArgs)-1] != "repos/acme/widgets/pulls/42/reviews" {
		t.Fatalf("args = %#v", gotArgs)
	}
	var payload struct {
		CommitID string `json:"commit_id"`
		Event    string `json:"event"`
		Comments []struct {
			Path      string `json:"path"`
			Line      int    `json:"line"`
			StartLine int    `json:"start_line"`
			Body      string `json:"body"`
		} `json:"comments"`
	}
	if err := json.Unmarshal(gotInput, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload.CommitID != "deadbeef" || payload.Event != "COMMENT" || len(payload.Comments) != 1 {
		t.Fatalf("payload = %+v", payload)
	}
	comment := payload.Comments[0]
	if comment.Path != "pkg/widget.go" || comment.Line != 12 || comment.StartLine != 10 || comment.Body != "This can panic.\n\nSuggested fix:\nGuard the nil value." {
		t.Fatalf("inline comment = %+v", comment)
	}
}

func TestGitHubPRRefRejectsNonGitHubURL(t *testing.T) {
	if _, _, _, err := githubPRRef("https://example.com/acme/widgets/pull/42"); err == nil {
		t.Fatal("expected non-GitHub URL to be rejected")
	}
}
