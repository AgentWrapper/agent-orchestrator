package github

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func validMergeRequest() ports.SCMMergeRequest {
	return ports.SCMMergeRequest{
		PR: ports.SCMPRRef{
			Repo:   ports.SCMRepo{Provider: "github", Host: "github.com", Owner: "octocat", Name: "hello", Repo: "octocat/hello"},
			Number: 42,
			URL:    "https://github.com/octocat/hello/pull/42",
		},
		ExpectedHeadSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Method:          ports.SCMMergeSquash,
	}
}

func TestMergePullRequest_UsesSquashAndExpectedHead(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPut, "/repos/octocat/hello/pulls/42/merge", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SHA         string `json:"sha"`
			MergeMethod string `json:"merge_method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.SHA != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || body.MergeMethod != "squash" {
			t.Fatalf("body = %#v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sha": "merge-sha", "merged": true, "message": "merged"})
	})

	got, err := newProviderForTest(t, f).MergePullRequest(ctx(), validMergeRequest())
	if err != nil {
		t.Fatal(err)
	}
	if got.MergeCommitSHA != "merge-sha" {
		t.Fatalf("result = %#v", got)
	}
}

func TestMergePullRequest_MapsGitHubFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		want   error
	}{
		{name: "not found", status: http.StatusNotFound, want: ports.ErrSCMNotFound},
		{name: "head changed", status: http.StatusConflict, want: ports.ErrSCMHeadChanged},
		{name: "merge blocked", status: http.StatusMethodNotAllowed, want: ports.ErrSCMNotMergeable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeGH(t)
			f.on(http.MethodPut, "/repos/octocat/hello/pulls/42/merge", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]string{"message": tc.name})
			})
			_, err := newProviderForTest(t, f).MergePullRequest(ctx(), validMergeRequest())
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestMergePullRequest_RejectsIncompleteGuard(t *testing.T) {
	request := validMergeRequest()
	request.ExpectedHeadSHA = "abc"
	if _, err := newProviderForTest(t, newFakeGH(t)).MergePullRequest(ctx(), request); err == nil {
		t.Fatal("merge with invalid expected head succeeded")
	}
}
