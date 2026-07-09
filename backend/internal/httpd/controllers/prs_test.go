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
	closeResult   prsvc.CloseResult
	closeErr      error
	resolveResult prsvc.ResolveResult
	resolveErr    error
}

func (f *fakePRService) Merge(_ context.Context, _ string) (prsvc.MergeResult, error) {
	return f.mergeResult, f.mergeErr
}

func (f *fakePRService) Close(_ context.Context, _ string) (prsvc.CloseResult, error) {
	return f.closeResult, f.closeErr
}

func (f *fakePRService) ResolveComments(_ context.Context, _ string, _ []string) (prsvc.ResolveResult, error) {
	return f.resolveResult, f.resolveErr
}

func newPRTestServer(t *testing.T, svc prsvc.ActionManager) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{PRs: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

// ---- Nil service → 501 NOT_IMPLEMENTED ----

func TestPRsRoutes_NilService_MergeReturns501(t *testing.T) {
	srv := newPRTestServer(t, nil)
	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/merge", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}

func TestPRsRoutes_NilService_CloseReturns501(t *testing.T) {
	srv := newPRTestServer(t, nil)
	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/close", "")
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

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/prs/42/merge", "")
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
}

// ---- Merge: 404 ----

func TestPRsRoutes_Merge_404(t *testing.T) {
	svc := &fakePRService{mergeErr: prsvc.ErrPRNotFound}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/99/merge", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotFound, "PR_NOT_FOUND")
}

// ---- Merge: 409 ----

func TestPRsRoutes_Merge_409(t *testing.T) {
	svc := &fakePRService{mergeErr: prsvc.ErrPRNotMergeable}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/merge", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusConflict, "PR_NOT_MERGEABLE")
}

// ---- Merge: 422 ----

func TestPRsRoutes_Merge_422(t *testing.T) {
	svc := &fakePRService{mergeErr: prsvc.ErrPRPreconditions}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/merge", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusUnprocessableEntity, "PR_PRECONDITIONS_UNMET")
}

// ---- Close: 200 ----

func TestPRsRoutes_Close_200(t *testing.T) {
	svc := &fakePRService{closeResult: prsvc.CloseResult{PRNumber: 42}}
	srv := newPRTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/prs/42/close", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		OK       bool `json:"ok"`
		PRNumber int  `json:"prNumber"`
	}
	mustJSON(t, body, &resp)
	if !resp.OK || resp.PRNumber != 42 {
		t.Errorf("resp = %+v, want {ok:true prNumber:42}", resp)
	}
}

// ---- Close: 404 ----

func TestPRsRoutes_Close_404(t *testing.T) {
	svc := &fakePRService{closeErr: prsvc.ErrPRNotFound}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/99/close", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotFound, "PR_NOT_FOUND")
}

// ---- Close: 409 ----

func TestPRsRoutes_Close_409(t *testing.T) {
	svc := &fakePRService{closeErr: prsvc.ErrPRNotMergeable}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/close", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusConflict, "PR_NOT_MERGEABLE")
}

// ---- ResolveComments: 200 ----

func TestPRsRoutes_ResolveComments_200(t *testing.T) {
	svc := &fakePRService{resolveResult: prsvc.ResolveResult{Resolved: 3}}
	srv := newPRTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/prs/42/resolve-comments", `{"commentIds":["T_1","T_2","T_3"]}`)
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
}

func TestPRsRoutes_ResolveComments_200_NoBody(t *testing.T) {
	svc := &fakePRService{resolveResult: prsvc.ResolveResult{Resolved: 2}}
	srv := newPRTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/prs/42/resolve-comments", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
}

// ---- ResolveComments: 404 ----

func TestPRsRoutes_ResolveComments_404(t *testing.T) {
	svc := &fakePRService{resolveErr: prsvc.ErrPRNotFound}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/99/resolve-comments", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotFound, "PR_NOT_FOUND")
}

// ---- ResolveComments: 422 ----

func TestPRsRoutes_ResolveComments_422(t *testing.T) {
	svc := &fakePRService{resolveErr: prsvc.ErrNothingToResolve}
	srv := newPRTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/prs/1/resolve-comments", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusUnprocessableEntity, "NOTHING_TO_RESOLVE")
}
