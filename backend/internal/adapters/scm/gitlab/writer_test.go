package gitlab

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestWriterSquashMergeUsesExpectedHeadSHA(t *testing.T) {
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.EscapedPath() != "/projects/group%2Frepo/merge_requests/42/merge" {
			t.Fatalf("request = %s %s", r.Method, r.URL.EscapedPath())
		}
		var body struct {
			Squash bool   `json:"squash"`
			SHA    string `json:"sha"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if !body.Squash || body.SHA != "head-42" {
			t.Fatalf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"state":"merged"}`))
	}))
	defer server.Close()
	err := provider.SquashMerge(context.Background(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "gitlab", Host: provider.host, Repo: "group/repo"}, Number: 42,
	}, "head-42")
	if err != nil {
		t.Fatal(err)
	}
}

func TestWriterResolvesDiscussionOnMergeRequest(t *testing.T) {
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.EscapedPath() != "/projects/group%2Frepo/merge_requests/42/discussions/discussion-1" {
			t.Fatalf("request = %s %s", r.Method, r.URL.EscapedPath())
		}
		var body struct {
			Resolved bool `json:"resolved"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !body.Resolved {
			t.Fatalf("body/error = %#v / %v", body, err)
		}
		_, _ = w.Write([]byte(`{"id":"discussion-1","resolved":true}`))
	}))
	defer server.Close()
	err := provider.ResolveReviewThread(context.Background(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "gitlab", Host: provider.host, Repo: "group/repo"}, Number: 42,
	}, "discussion-1")
	if err != nil {
		t.Fatal(err)
	}
}

func TestWriterRepliesToDiscussionOnMergeRequest(t *testing.T) {
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.EscapedPath() != "/projects/group%2Frepo/merge_requests/42/discussions/discussion-1/notes" {
			t.Fatalf("request = %s %s", r.Method, r.URL.EscapedPath())
		}
		var body struct {
			Body string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Body != "Fixed in head-43." {
			t.Fatalf("body/error = %#v / %v", body, err)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":99,"body":"Fixed in head-43."}`))
	}))
	defer server.Close()
	err := provider.ReplyReviewThread(context.Background(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "gitlab", Host: provider.host, Repo: "group/repo"}, Number: 42,
	}, "discussion-1", "Fixed in head-43.")
	if err != nil {
		t.Fatal(err)
	}
}

func TestWriterReplyRejectsEmptyBodyWithoutRequest(t *testing.T) {
	provider, server := newTestProvider(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("unexpected request")
	}))
	defer server.Close()
	err := provider.ReplyReviewThread(context.Background(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "gitlab", Host: provider.host, Repo: "group/repo"}, Number: 42,
	}, "discussion-1", "  ")
	if !errors.Is(err, ports.ErrSCMActionPrecondition) {
		t.Fatalf("error = %v, want precondition", err)
	}
}

func TestWriterMapsForbiddenAndPrecondition(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   error
	}{
		{status: http.StatusForbidden, want: ports.ErrSCMActionForbidden},
		{status: http.StatusConflict, want: ports.ErrSCMActionPrecondition},
		{status: http.StatusMethodNotAllowed, want: ports.ErrSCMActionPrecondition},
	} {
		provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
		}))
		err := provider.SquashMerge(context.Background(), ports.SCMPRRef{
			Repo: ports.SCMRepo{Provider: "gitlab", Host: provider.host, Repo: "group/repo"}, Number: 42,
		}, "head-42")
		server.Close()
		if !errors.Is(err, tc.want) {
			t.Fatalf("status %d error = %v, want %v", tc.status, err, tc.want)
		}
	}
}

func TestWriterRejectsSuccessfulResponseThatDidNotMerge(t *testing.T) {
	provider, server := newTestProvider(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"state":"opened"}`))
	}))
	defer server.Close()

	err := provider.SquashMerge(context.Background(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "gitlab", Host: provider.host, Repo: "group/repo"}, Number: 42,
	}, "head-42")
	if !errors.Is(err, ports.ErrSCMActionPrecondition) {
		t.Fatalf("error = %v, want precondition", err)
	}
}
