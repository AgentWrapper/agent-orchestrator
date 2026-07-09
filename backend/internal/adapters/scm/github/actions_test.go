package github

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestMergePR_Success(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPut, "/repos/octocat/hello/pulls/42/merge", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["merge_method"] != "squash" {
			t.Fatalf("merge_method = %v, want squash", body["merge_method"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"merged": true, "sha": "deadbeef", "message": "Pull Request successfully merged"})
	})
	p := newProviderForTest(t, f)

	res, err := p.MergePR(ctx(), ports.SCMPRRef{
		Repo:   ports.SCMRepo{Owner: "octocat", Name: "hello", Repo: "octocat/hello"},
		Number: 42,
	}, "squash")
	if err != nil {
		t.Fatalf("MergePR: %v", err)
	}
	if !res.Merged || res.SHA != "deadbeef" || res.Method != "squash" {
		t.Fatalf("result = %+v", res)
	}
	if f.callsTo(http.MethodPut, "/repos/octocat/hello/pulls/42/merge") != 1 {
		t.Fatalf("expected one merge PUT")
	}
}

func TestMergePR_NotMergeable_405(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPut, "/repos/o/r/pulls/1/merge", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusMethodNotAllowed)
		_, _ = w.Write([]byte(`{"message":"Pull Request is not mergeable"}`))
	})
	p := newProviderForTest(t, f)

	_, err := p.MergePR(ctx(), ports.SCMPRRef{Repo: ports.SCMRepo{Owner: "o", Name: "r"}, Number: 1}, "squash")
	if !errors.Is(err, ErrNotMergeable) {
		t.Fatalf("err = %v, want ErrNotMergeable", err)
	}
}

func TestMergePR_Conflict_409(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPut, "/repos/o/r/pulls/1/merge", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"message":"Head branch was modified"}`))
	})
	p := newProviderForTest(t, f)

	_, err := p.MergePR(ctx(), ports.SCMPRRef{Repo: ports.SCMRepo{Owner: "o", Name: "r"}, Number: 1}, "")
	if !errors.Is(err, ErrUnprocessable) {
		t.Fatalf("err = %v, want ErrUnprocessable", err)
	}
}

func TestMergePR_Auth_401(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPut, "/repos/o/r/pulls/1/merge", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Bad credentials"}`))
	})
	p := newProviderForTest(t, f)

	_, err := p.MergePR(ctx(), ports.SCMPRRef{Repo: ports.SCMRepo{Owner: "o", Name: "r"}, Number: 1}, "squash")
	if !errors.Is(err, ports.ErrSCMAuthFailed) {
		t.Fatalf("err = %v, want ErrSCMAuthFailed", err)
	}
}

func TestMergePR_FromURLRef(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPut, "/repos/acme/app/pulls/9/merge", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"merged": true, "sha": "s1"})
	})
	p := newProviderForTest(t, f)

	res, err := p.MergePR(ctx(), ports.SCMPRRef{URL: "https://github.com/acme/app/pull/9"}, "squash")
	if err != nil {
		t.Fatalf("MergePR: %v", err)
	}
	if !res.Merged {
		t.Fatal("expected merged")
	}
}

func TestListUnresolvedThreadIDs(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPost, "/graphql", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Query string `json:"query"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !strings.Contains(body.Query, "reviewThreads") {
			t.Fatalf("unexpected query: %s", body.Query)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"pullRequest": map[string]any{
						"reviewThreads": map[string]any{
							"nodes": []any{
								map[string]any{"id": "T_open", "isResolved": false},
								map[string]any{"id": "T_done", "isResolved": true},
								map[string]any{"id": "T_open2", "isResolved": false},
							},
						},
					},
				},
			},
		})
	})
	p := newProviderForTest(t, f)

	ids, err := p.ListUnresolvedThreadIDs(ctx(), ports.SCMPRRef{
		Repo: ports.SCMRepo{Owner: "o", Name: "r"}, Number: 1,
	})
	if err != nil {
		t.Fatalf("ListUnresolvedThreadIDs: %v", err)
	}
	if len(ids) != 2 || ids[0] != "T_open" || ids[1] != "T_open2" {
		t.Fatalf("ids = %v, want [T_open T_open2]", ids)
	}
}

func TestResolveThread_Success(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPost, "/graphql", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Variables["id"] != "PRRT_1" {
			t.Fatalf("variables = %#v", body.Variables)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"resolveReviewThread": map[string]any{
					"thread": map[string]any{"id": "PRRT_1", "isResolved": true},
				},
			},
		})
	})
	p := newProviderForTest(t, f)

	if err := p.ResolveThread(ctx(), "PRRT_1"); err != nil {
		t.Fatalf("ResolveThread: %v", err)
	}
}

func TestResolveThread_EmptyID(t *testing.T) {
	p := newProviderForTest(t, newFakeGH(t))
	if err := p.ResolveThread(ctx(), "  "); !errors.Is(err, ErrUnprocessable) {
		t.Fatalf("err = %v, want ErrUnprocessable", err)
	}
}

func TestResolveThread_NullPayload(t *testing.T) {
	f := newFakeGH(t)
	f.on(http.MethodPost, "/graphql", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{"resolveReviewThread": nil},
		})
	})
	p := newProviderForTest(t, f)
	if err := p.ResolveThread(ctx(), "T_x"); !errors.Is(err, ErrUnprocessable) {
		t.Fatalf("err = %v, want ErrUnprocessable", err)
	}
}