package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	prsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pr"
)

type fakePRService struct {
	mergeResult   prsvc.MergeResult
	mergeErr      error
	mergeInput    prsvc.MergeInput
	resolveResult prsvc.ResolveResult
	resolveErr    error
	resolveInput  prsvc.ResolveCommentsInput
}

func (f *fakePRService) Merge(_ context.Context, _ string, input prsvc.MergeInput) (prsvc.MergeResult, error) {
	f.mergeInput = input
	return f.mergeResult, f.mergeErr
}

func (f *fakePRService) ResolveComments(_ context.Context, _ string, input prsvc.ResolveCommentsInput) (prsvc.ResolveResult, error) {
	f.resolveInput = input
	return f.resolveResult, f.resolveErr
}

const mergeRequestBody = `{"sessionId":"session-1","prUrl":"https://example.test/acme/repo/pull/42","expectedHeadSha":"head-42"}`
const resolveRequestBody = `{"sessionId":"session-1","prUrl":"https://example.test/acme/repo/pull/42"}`

func newPRTestServer(t *testing.T, svc prsvc.ActionManager) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{PRs: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

// ---- Nil service → 503 SCM_NOT_CONFIGURED ----

func TestPRsRoutes_NilService_MergeReturns501(t *testing.T) {
	srv := newPRTestServer(t, nil)
	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/merge", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}

func TestPRsRoutes_NilService_ResolveCommentsReturns501(t *testing.T) {
	srv := newPRTestServer(t, nil)
	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/resolve-comments", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}

// ---- Merge: 200 ----

func TestPRsRoutes_Merge_200(t *testing.T) {
	svc := &fakePRService{mergeResult: prsvc.MergeResult{PRNumber: 42, Method: "squash"}}
	srv := newPRTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/prs/42/merge", mergeRequestBody)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		OK       bool   `json:"ok"`
		PRNumber int    `json:"prNumber"`
		Method   string `json:"method"`
	}
	mustJSON(t, body, &resp)
	if !resp.OK || resp.PRNumber != 42 || resp.Method != "squash" {
		t.Errorf("resp = %+v, want {ok:true prNumber:42 method:squash}", resp)
	}
	if svc.mergeInput.SessionID != "session-1" || svc.mergeInput.ExpectedHeadSHA != "head-42" {
		t.Fatalf("merge input = %#v", svc.mergeInput)
	}
}

func TestPRsRoutes_Merge_400_NoBody(t *testing.T) {
	srv := newPRTestServer(t, &fakePRService{})
	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/42/merge", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_JSON")
}

// ---- Merge: 404 ----

func TestPRsRoutes_Merge_404(t *testing.T) {
	svc := &fakePRService{mergeErr: prsvc.ErrPRNotFound}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/99/merge", mergeRequestBody)
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotFound, "PR_NOT_FOUND")
}

// ---- Merge: 409 ----

func TestPRsRoutes_Merge_409(t *testing.T) {
	svc := &fakePRService{mergeErr: prsvc.ErrPRNotMergeable}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/merge", mergeRequestBody)
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusConflict, "PR_NOT_MERGEABLE")
}

// ---- Merge: 422 ----

func TestPRsRoutes_Merge_422(t *testing.T) {
	svc := &fakePRService{mergeErr: prsvc.ErrPRPreconditions}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/merge", mergeRequestBody)
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusUnprocessableEntity, "PR_PRECONDITIONS_UNMET")
}

// ---- ResolveComments: 200 ----

func TestPRsRoutes_ResolveComments_200(t *testing.T) {
	svc := &fakePRService{resolveResult: prsvc.ResolveResult{Resolved: 3}}
	srv := newPRTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/prs/42/resolve-comments", `{"sessionId":"session-1","prUrl":"https://example.test/acme/repo/pull/42","commentIds":["T_1","T_2","T_3"]}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		OK       bool `json:"ok"`
		Resolved int  `json:"resolved"`
	}
	mustJSON(t, body, &resp)
	if !resp.OK || resp.Resolved != 3 {
		t.Errorf("resp = %+v, want {ok:true resolved:3}", resp)
	}
	if svc.resolveInput.SessionID != "session-1" || len(svc.resolveInput.CommentIDs) != 3 {
		t.Fatalf("resolve input = %#v", svc.resolveInput)
	}
}

func TestPRsRoutes_ResolveCommentsPassesReplies(t *testing.T) {
	svc := &fakePRService{resolveResult: prsvc.ResolveResult{Resolved: 1}}
	srv := newPRTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/prs/42/resolve-comments", `{"sessionId":"session-1","prUrl":"https://example.test/acme/repo/pull/42","replies":[{"threadId":"T_1","body":"Fixed."}]}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if len(svc.resolveInput.Replies) != 1 || svc.resolveInput.Replies[0].ThreadID != "T_1" || svc.resolveInput.Replies[0].Body != "Fixed." {
		t.Fatalf("resolve input = %#v", svc.resolveInput)
	}
}

func TestPRsRoutes_ResolveCommentsRejectsInvalidReplies(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "empty body", body: `{"sessionId":"session-1","prUrl":"https://example.test/acme/repo/pull/42","replies":[{"threadId":"T_1","body":"  "}]}`},
		{name: "duplicate thread", body: `{"sessionId":"session-1","prUrl":"https://example.test/acme/repo/pull/42","replies":[{"threadId":"T_1","body":"First."},{"threadId":"T_1","body":"Second."}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newPRTestServer(t, &fakePRService{resolveResult: prsvc.ResolveResult{Resolved: 1}})
			body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/42/resolve-comments", tc.body)
			assertJSON(t, headers)
			assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_PR_ACTION")
		})
	}
}

func TestPRsRoutes_ResolveComments_400_NoBody(t *testing.T) {
	svc := &fakePRService{resolveResult: prsvc.ResolveResult{Resolved: 2}}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/42/resolve-comments", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_JSON")
}

// ---- ResolveComments: 404 ----

func TestPRsRoutes_ResolveComments_404(t *testing.T) {
	svc := &fakePRService{resolveErr: prsvc.ErrPRNotFound}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/99/resolve-comments", resolveRequestBody)
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotFound, "PR_NOT_FOUND")
}

// ---- ResolveComments: 422 ----

func TestPRsRoutes_ResolveComments_422(t *testing.T) {
	svc := &fakePRService{resolveErr: prsvc.ErrNothingToResolve}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/resolve-comments", resolveRequestBody)
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusUnprocessableEntity, "NOTHING_TO_RESOLVE")
}
