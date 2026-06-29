package controllers_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/legacyimport"
	importsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/importer"
)

// fakeImportService is a test double for controllers.ImportService.
type fakeImportService struct {
	statusResult importsvc.Status
	statusErr    error
	runResult    legacyimport.Report
	runErr       error
}

func (f *fakeImportService) Status(_ context.Context) (importsvc.Status, error) {
	return f.statusResult, f.statusErr
}

func (f *fakeImportService) Run(_ context.Context) (legacyimport.Report, error) {
	return f.runResult, f.runErr
}

func newImportTestServer(t *testing.T, svc controllers.ImportService) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Import: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestImportAPI_Status(t *testing.T) {
	svc := &fakeImportService{statusResult: importsvc.Status{Available: true, LegacyRoot: "/home/u/.agent-orchestrator"}}
	srv := newImportTestServer(t, svc)
	body, status, headers := doRequest(t, srv, "GET", "/api/v1/import", "")
	if status != http.StatusOK {
		t.Fatalf("GET /import = %d, want 200; body=%s", status, body)
	}
	assertJSON(t, headers)
	var resp controllers.ImportStatusResponse
	mustJSON(t, body, &resp)
	if !resp.Available || resp.LegacyRoot != "/home/u/.agent-orchestrator" {
		t.Fatalf("status = %+v", resp)
	}
}

func TestImportAPI_StatusError(t *testing.T) {
	svc := &fakeImportService{statusErr: errors.New("store error")}
	srv := newImportTestServer(t, svc)
	_, status, _ := doRequest(t, srv, "GET", "/api/v1/import", "")
	if status != http.StatusInternalServerError {
		t.Fatalf("GET /import with error = %d, want 500", status)
	}
}

func TestImportAPI_Run(t *testing.T) {
	svc := &fakeImportService{runResult: legacyimport.Report{ProjectsImported: 3}}
	srv := newImportTestServer(t, svc)
	body, status, headers := doRequest(t, srv, "POST", "/api/v1/import", "")
	if status != http.StatusOK {
		t.Fatalf("POST /import = %d, want 200; body=%s", status, body)
	}
	assertJSON(t, headers)
	var resp controllers.ImportRunResponse
	mustJSON(t, body, &resp)
	if resp.Report.ProjectsImported != 3 {
		t.Fatalf("report = %+v", resp.Report)
	}
}

func TestImportAPI_RunError(t *testing.T) {
	svc := &fakeImportService{runErr: errors.New("disk full")}
	srv := newImportTestServer(t, svc)
	_, status, _ := doRequest(t, srv, "POST", "/api/v1/import", "")
	if status != http.StatusInternalServerError {
		t.Fatalf("POST /import with error = %d, want 500", status)
	}
}

func TestImportAPI_NilSvcReturns501(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	body, status, _ := doRequest(t, srv, "GET", "/api/v1/import", "")
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
	body, status, _ = doRequest(t, srv, "POST", "/api/v1/import", "")
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}
