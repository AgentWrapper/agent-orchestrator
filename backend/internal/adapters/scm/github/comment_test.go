package github

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// PostIssueComment posts to the issue-comments endpoint for the PR's number and
// carries the body (issue #181 duplicate-PR auto-comment).
func TestPostIssueComment_PostsToIssueCommentsEndpoint(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPost, "/repos/acme/demo/issues/180/comments", func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body, _ := payload["body"].(string); !strings.Contains(body, "duplicate") {
			t.Fatalf("comment body = %q, want it to mention the duplicate", body)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":1}`))
	})
	p := newProviderForTest(t, f)

	err := p.PostIssueComment(ctx(), "https://github.com/acme/demo/pull/180", "This is a duplicate PR.")
	if err != nil {
		t.Fatalf("PostIssueComment: %v", err)
	}
	if n := f.callsTo(http.MethodPost, "/repos/acme/demo/issues/180/comments"); n != 1 {
		t.Fatalf("issue-comment POSTs = %d, want 1", n)
	}
}

// A malformed PR URL is rejected before any network call.
func TestPostIssueComment_RejectsBadURL(t *testing.T) {
	f := newFakeGH(t)
	p := newProviderForTest(t, f)
	if err := p.PostIssueComment(ctx(), "not-a-pr-url", "body"); err == nil {
		t.Fatal("PostIssueComment error = nil, want a parse error")
	}
	if len(f.calls()) != 0 {
		t.Fatalf("made %d network calls for a bad URL, want 0", len(f.calls()))
	}
}
