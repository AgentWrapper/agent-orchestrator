package github

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestWriterSquashMergeUsesExpectedHeadSHA(t *testing.T) {
	fake := newFakeGH(t)
	fake.on(http.MethodPut, "/repos/acme/repo/pulls/42/merge", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Method string `json:"merge_method"`
			SHA    string `json:"sha"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Method != "squash" || body.SHA != "head-42" {
			t.Fatalf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"merged":true}`))
	})
	provider := newProviderForTest(t, fake)
	err := provider.SquashMerge(ctx(), ports.SCMPRRef{
		Repo:   ports.SCMRepo{Provider: "github", Host: strings.TrimPrefix(fake.server.URL, "http://"), Owner: "acme", Name: "repo", Repo: "acme/repo"},
		Number: 42,
	}, "head-42")
	if err != nil {
		t.Fatal(err)
	}
}

func TestWriterResolveReviewThreadUsesGraphQLMutation(t *testing.T) {
	fake := newFakeGH(t)
	fake.on(http.MethodPost, "/graphql", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Variables["threadId"] != "PRRT_1" {
			t.Fatalf("variables = %#v", body.Variables)
		}
		_, _ = w.Write([]byte(`{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":true}}}}`))
	})
	provider := newProviderForTest(t, fake)
	err := provider.ResolveReviewThread(ctx(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "github", Host: strings.TrimPrefix(fake.server.URL, "http://"), Repo: "acme/repo"}, Number: 42,
	}, "PRRT_1")
	if err != nil {
		t.Fatal(err)
	}
}

func TestWriterReplyReviewThreadUsesGraphQLMutation(t *testing.T) {
	fake := newFakeGH(t)
	fake.on(http.MethodPost, "/graphql", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(body.Query, "addPullRequestReviewThreadReply") ||
			body.Variables["threadId"] != "PRRT_1" || body.Variables["body"] != "Fixed in head-43." {
			t.Fatalf("request = %#v", body)
		}
		_, _ = w.Write([]byte(`{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"PRRC_2"}}}}`))
	})
	provider := newProviderForTest(t, fake)
	err := provider.ReplyReviewThread(ctx(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "github", Host: strings.TrimPrefix(fake.server.URL, "http://"), Repo: "acme/repo"}, Number: 42,
	}, "PRRT_1", "Fixed in head-43.")
	if err != nil {
		t.Fatal(err)
	}
}

func TestWriterReplyReviewThreadRejectsEmptyBodyWithoutRequest(t *testing.T) {
	fake := newFakeGH(t)
	provider := newProviderForTest(t, fake)
	err := provider.ReplyReviewThread(ctx(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "github", Host: strings.TrimPrefix(fake.server.URL, "http://"), Repo: "acme/repo"}, Number: 42,
	}, "PRRT_1", "  ")
	if !errors.Is(err, ports.ErrSCMActionPrecondition) || len(fake.calls()) != 0 {
		t.Fatalf("error/calls = %v / %d", err, len(fake.calls()))
	}
}

func TestWriterReplyReviewThreadMapsGraphQLErrorTypes(t *testing.T) {
	for _, tc := range []struct {
		name      string
		errorType string
		want      error
	}{
		{name: "forbidden", errorType: "FORBIDDEN", want: ports.ErrSCMActionForbidden},
		{name: "unprocessable", errorType: "UNPROCESSABLE", want: ports.ErrSCMActionPrecondition},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeGH(t)
			fake.on(http.MethodPost, "/graphql", func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"errors":[{"type":"` + tc.errorType + `","message":"provider-secret"}]}`))
			})
			provider := newProviderForTest(t, fake)
			err := provider.ReplyReviewThread(ctx(), ports.SCMPRRef{
				Repo: ports.SCMRepo{Provider: "github", Host: strings.TrimPrefix(fake.server.URL, "http://"), Repo: "acme/repo"}, Number: 42,
			}, "PRRT_1", "Fixed.")
			if !errors.Is(err, tc.want) || strings.Contains(err.Error(), "provider-secret") {
				t.Fatalf("error = %v, want %v without provider message", err, tc.want)
			}
		})
	}
}

func TestWriterRejectsWrongRepositoryWithoutRequest(t *testing.T) {
	fake := newFakeGH(t)
	provider := newProviderForTest(t, fake)
	err := provider.SquashMerge(ctx(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Provider: "github", Host: "wrong.example.com", Repo: "acme/repo"}, Number: 42,
	}, "head-42")
	if !errors.Is(err, ports.ErrSCMNotFound) || len(fake.calls()) != 0 {
		t.Fatalf("error/calls = %v / %d", err, len(fake.calls()))
	}
}

func TestWriterMapsMethodNotAllowedToPrecondition(t *testing.T) {
	fake := newFakeGH(t)
	fake.on(http.MethodPut, "/repos/acme/repo/pulls/42/merge", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	provider := newProviderForTest(t, fake)
	err := provider.SquashMerge(ctx(), ports.SCMPRRef{
		Repo: ports.SCMRepo{
			Provider: "github", Host: strings.TrimPrefix(fake.server.URL, "http://"), Repo: "acme/repo",
		},
		Number: 42,
	}, "head-42")
	if !errors.Is(err, ports.ErrSCMActionPrecondition) {
		t.Fatalf("error = %v, want precondition", err)
	}
}
