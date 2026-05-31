package controllers_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/project"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithAPI(config.Config{}, log, nil, httpd.APIDeps{
		Projects: project.NewMemoryManager(),
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestProjectsRoutes_DefaultToStubsWithoutManager(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouter(config.Config{}, log, nil))
	t.Cleanup(srv.Close)

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/projects", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}

func TestProjectsAPI_ListAddGetReload(t *testing.T) {
	srv := newTestServer(t)
	repo := gitRepo(t, "agent-orchestrator")

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/projects", "")
	if status != http.StatusOK {
		t.Fatalf("GET projects = %d, want 200; body=%s", status, body)
	}
	assertJSON(t, headers)
	var list struct {
		Projects []projectSummary `json:"projects"`
	}
	mustJSON(t, body, &list)
	if len(list.Projects) != 0 {
		t.Fatalf("initial project count = %d, want 0", len(list.Projects))
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/projects", `{"path":`+quote(repo)+`,"projectId":"ao","name":"Agent Orchestrator"}`)
	if status != http.StatusCreated {
		t.Fatalf("POST project = %d, want 201; body=%s", status, body)
	}
	var add struct {
		Project projectBody `json:"project"`
	}
	mustJSON(t, body, &add)
	if add.Project.ID != "ao" || add.Project.Name != "Agent Orchestrator" || add.Project.DefaultBranch != "main" {
		t.Fatalf("created project = %#v", add.Project)
	}

	body, status, _ = doRequest(t, srv, "GET", "/api/v1/projects/ao", "")
	if status != http.StatusOK {
		t.Fatalf("GET project = %d, want 200; body=%s", status, body)
	}
	var get struct {
		Status  string      `json:"status"`
		Project projectBody `json:"project"`
	}
	mustJSON(t, body, &get)
	if get.Status != "ok" || get.Project.ID != "ao" {
		t.Fatalf("get response = %#v", get)
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/projects/reload", "")
	if status != http.StatusOK {
		t.Fatalf("reload = %d, want 200; body=%s", status, body)
	}
	var reload struct {
		Reloaded      bool `json:"reloaded"`
		ProjectCount  int  `json:"projectCount"`
		DegradedCount int  `json:"degradedCount"`
	}
	mustJSON(t, body, &reload)
	if !reload.Reloaded || reload.ProjectCount != 1 || reload.DegradedCount != 0 {
		t.Fatalf("reload response = %#v", reload)
	}
}

func TestProjectsAPI_AddValidationAndConflicts(t *testing.T) {
	srv := newTestServer(t)
	repoA := gitRepo(t, "repo-a")
	repoB := gitRepo(t, "repo-b")
	notRepo := t.TempDir()

	cases := []struct {
		name, body, wantCode string
		wantStatus           int
	}{
		{name: "invalid json", body: `{`, wantStatus: 400, wantCode: "INVALID_JSON"},
		{name: "missing path", body: `{}`, wantStatus: 400, wantCode: "PATH_REQUIRED"},
		{name: "not git", body: `{"path":` + quote(notRepo) + `}`, wantStatus: 400, wantCode: "NOT_A_GIT_REPO"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, status, _ := doRequest(t, srv, "POST", "/api/v1/projects", tc.body)
			assertErrorCode(t, body, status, tc.wantStatus, tc.wantCode)
		})
	}

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/projects", `{"path":`+quote(repoA)+`,"projectId":"shared"}`)
	if status != http.StatusCreated {
		t.Fatalf("seed create = %d, want 201; body=%s", status, body)
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/projects", `{"path":`+quote(repoA)+`,"projectId":"other"}`)
	assertErrorCode(t, body, status, http.StatusConflict, "PATH_ALREADY_REGISTERED")

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/projects", `{"path":`+quote(repoB)+`,"projectId":"shared"}`)
	assertErrorCode(t, body, status, http.StatusConflict, "ID_ALREADY_REGISTERED")
}

func TestProjectsAPI_UpdateDeleteRepair(t *testing.T) {
	srv := newTestServer(t)
	repo := gitRepo(t, "repo")

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/projects", `{"path":`+quote(repo)+`,"projectId":"proj"}`)
	if status != http.StatusCreated {
		t.Fatalf("seed create = %d, want 201; body=%s", status, body)
	}

	body, status, _ = doRequest(t, srv, "PATCH", "/api/v1/projects/proj", `{"agent":"claude","runtime":"tmux"}`)
	assertErrorCode(t, body, status, http.StatusNotImplemented, "PROJECT_CONFIG_NOT_IMPLEMENTED")

	body, status, _ = doRequest(t, srv, "PATCH", "/api/v1/projects/proj", `{"path":"elsewhere"}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "IDENTITY_FROZEN")

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/projects/proj/repair", "")
	assertErrorCode(t, body, status, http.StatusBadRequest, "REPAIR_NOT_AVAILABLE")

	body, status, _ = doRequest(t, srv, "DELETE", "/api/v1/projects/proj", "")
	if status != http.StatusOK {
		t.Fatalf("DELETE = %d, want 200; body=%s", status, body)
	}
	var removed struct {
		ProjectID         string `json:"projectId"`
		RemovedStorageDir bool   `json:"removedStorageDir"`
	}
	mustJSON(t, body, &removed)
	if removed.ProjectID != "proj" || removed.RemovedStorageDir {
		t.Fatalf("delete response = %#v", removed)
	}

	body, status, _ = doRequest(t, srv, "GET", "/api/v1/projects/proj", "")
	if status != http.StatusOK {
		t.Fatalf("GET archived project = %d, want 200; body=%s", status, body)
	}

	body, status, _ = doRequest(t, srv, "GET", "/api/v1/projects", "")
	if status != http.StatusOK {
		t.Fatalf("GET projects after archive = %d, want 200; body=%s", status, body)
	}
	var list struct {
		Projects []projectSummary `json:"projects"`
	}
	mustJSON(t, body, &list)
	if len(list.Projects) != 0 {
		t.Fatalf("active projects after archive = %d, want 0", len(list.Projects))
	}
}

func TestProjectsRoutes_LegacyUnregistered(t *testing.T) {
	srv := newTestServer(t)

	cases := []struct {
		method, path, wantCode, why string
		wantStatus                  int
	}{
		{method: "PUT", path: "/api/v1/projects/p1", wantStatus: 405, wantCode: "METHOD_NOT_ALLOWED", why: "R3 PUT not registered"},
		{method: "POST", path: "/api/v1/projects/p1", wantStatus: 405, wantCode: "METHOD_NOT_ALLOWED", why: "R4 repair moved to /repair"},
	}

	for _, tc := range cases {
		t.Run(tc.why, func(t *testing.T) {
			body, status, _ := doRequest(t, srv, tc.method, tc.path, "")
			assertErrorCode(t, body, status, tc.wantStatus, tc.wantCode)
		})
	}
}

func TestProjectsRoutes_MissingRoute(t *testing.T) {
	srv := newTestServer(t)
	body, status, headers := doRequest(t, srv, "GET", "/api/v1/projects/p1/does-not-exist", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotFound, "ROUTE_NOT_FOUND")
}

func TestOpenAPIYAMLServed(t *testing.T) {
	srv := newTestServer(t)
	body, status, headers := doRequest(t, srv, "GET", "/api/v1/openapi.yaml", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if ct := headers.Get("Content-Type"); !strings.HasPrefix(ct, "application/yaml") {
		t.Errorf("Content-Type = %q, want application/yaml*", ct)
	}
	if !strings.Contains(string(body), "openapi: 3.1.0") {
		t.Errorf("served body did not start with an OpenAPI 3.1 doc")
	}
}

type projectSummary struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	SessionPrefix string `json:"sessionPrefix"`
}

type projectBody struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Path          string `json:"path"`
	Repo          string `json:"repo"`
	DefaultBranch string `json:"defaultBranch"`
	Agent         string `json:"agent"`
	Runtime       string `json:"runtime"`
}

type errorBody struct {
	Error   string         `json:"error"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
}

func doRequest(t *testing.T, srv *httptest.Server, method, path, body string) ([]byte, int, http.Header) {
	t.Helper()
	var req *http.Request
	var err error
	if body != "" {
		req, err = http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	} else {
		req, err = http.NewRequest(method, srv.URL+path, nil)
	}
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()
	buf, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return buf, resp.StatusCode, resp.Header
}

func gitRepo(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create git repo fixture: %v", err)
	}
	if out, err := exec.Command("git", "init", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init fixture: %v\n%s", err, out)
	}
	return dir
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func mustJSON(t *testing.T, body []byte, out any) {
	t.Helper()
	if err := json.Unmarshal(body, out); err != nil {
		t.Fatalf("unmarshal: %v\nbody=%s", err, body)
	}
}

func assertJSON(t *testing.T, headers http.Header) {
	t.Helper()
	if ct := headers.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want JSON", ct)
	}
}

func assertErrorCode(t *testing.T, body []byte, status, wantStatus int, wantCode string) {
	t.Helper()
	if status != wantStatus {
		t.Fatalf("status = %d, want %d\nbody=%s", status, wantStatus, body)
	}
	var got errorBody
	mustJSON(t, body, &got)
	if got.Code != wantCode {
		t.Fatalf("code = %q, want %q\nbody=%s", got.Code, wantCode, body)
	}
}
