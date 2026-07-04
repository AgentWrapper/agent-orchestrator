package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

type fakeSessionService struct {
	sessions        map[domain.SessionID]domain.Session
	sent            string
	cleanupProjects []domain.ProjectID
	cleanupResult   []domain.SessionID
	cleanupSkipped  []sessionsvc.CleanupSkipped
	spawnErr        error
	claimErr        error
	listPRErr       error
}

func newFakeSessionService() *fakeSessionService {
	now := time.Now().UTC()
	s := domain.Session{SessionRecord: domain.SessionRecord{ID: "ao-1", ProjectID: "ao", Kind: domain.KindWorker, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}, CreatedAt: now, UpdatedAt: now}, Status: domain.StatusIdle, TerminalHandleID: "ao-1/terminal_0"}
	return &fakeSessionService{sessions: map[domain.SessionID]domain.Session{s.ID: s}}
}

func (f *fakeSessionService) List(_ context.Context, filter sessionsvc.ListFilter) ([]domain.Session, error) {
	var out []domain.Session
	for _, s := range f.sessions {
		if filter.ProjectID != "" && s.ProjectID != filter.ProjectID {
			continue
		}
		if filter.Active != nil && s.IsTerminated == *filter.Active {
			continue
		}
		if filter.OrchestratorOnly && s.Kind != domain.KindOrchestrator {
			continue
		}
		out = append(out, s)
	}
	return out, nil
}

func (f *fakeSessionService) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.Session, error) {
	if f.spawnErr != nil {
		return domain.Session{}, f.spawnErr
	}
	now := time.Now().UTC()
	s := domain.Session{SessionRecord: domain.SessionRecord{ID: domain.SessionID(string(cfg.ProjectID) + "-2"), ProjectID: cfg.ProjectID, IssueID: cfg.IssueID, Kind: cfg.Kind, Harness: cfg.Harness, DisplayName: cfg.DisplayName, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}, CreatedAt: now, UpdatedAt: now}, Status: domain.StatusIdle}
	f.sessions[s.ID] = s
	return s, nil
}

func (f *fakeSessionService) SpawnOrchestrator(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error) {
	if clean {
		active := true
		existing, err := f.List(ctx, sessionsvc.ListFilter{ProjectID: projectID, Active: &active, OrchestratorOnly: true})
		if err != nil {
			return domain.Session{}, err
		}
		for _, o := range existing {
			if _, err := f.Kill(ctx, o.ID); err != nil {
				return domain.Session{}, err
			}
		}
	}
	return f.Spawn(ctx, ports.SpawnConfig{ProjectID: projectID, Kind: domain.KindOrchestrator})
}

func (f *fakeSessionService) Get(_ context.Context, id domain.SessionID) (domain.Session, error) {
	s, ok := f.sessions[id]
	if !ok {
		return domain.Session{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	return s, nil
}

func (f *fakeSessionService) SetPreview(_ context.Context, id domain.SessionID, previewURL string) (domain.Session, error) {
	s, ok := f.sessions[id]
	if !ok {
		return domain.Session{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	s.Metadata.PreviewURL = previewURL
	// Mirror the store: every set bumps the revision, even when the URL is
	// unchanged, so the controller's refresh contract can be exercised here.
	s.Metadata.PreviewRevision++
	f.sessions[id] = s
	return s, nil
}

func (f *fakeSessionService) Restore(_ context.Context, id domain.SessionID) (domain.Session, error) {
	s := f.sessions[id]
	s.IsTerminated = false
	s.Status = domain.StatusIdle
	f.sessions[id] = s
	return s, nil
}

func (f *fakeSessionService) SwitchHarness(_ context.Context, id domain.SessionID, harness domain.AgentHarness, _ string) (domain.Session, error) {
	s := f.sessions[id]
	s.Harness = harness
	s.IsTerminated = false
	s.Status = domain.StatusIdle
	f.sessions[id] = s
	return s, nil
}

func (f *fakeSessionService) Kill(_ context.Context, id domain.SessionID) (bool, error) {
	s := f.sessions[id]
	s.IsTerminated = true
	s.Status = domain.StatusTerminated
	f.sessions[id] = s
	return true, nil
}

func (f *fakeSessionService) RollbackSpawn(_ context.Context, id domain.SessionID) (sessionsvc.RollbackOutcome, error) {
	if _, ok := f.sessions[id]; ok {
		delete(f.sessions, id)
		return sessionsvc.RollbackOutcome{Deleted: true}, nil
	}
	return sessionsvc.RollbackOutcome{}, nil
}

func (f *fakeSessionService) Cleanup(_ context.Context, project domain.ProjectID) (sessionsvc.CleanupOutcome, error) {
	f.cleanupProjects = append(f.cleanupProjects, project)
	cleaned := f.cleanupResult
	if cleaned == nil {
		cleaned = []domain.SessionID{"ao-1"}
	}
	return sessionsvc.CleanupOutcome{Cleaned: cleaned, Skipped: f.cleanupSkipped}, nil
}

func (f *fakeSessionService) Rename(_ context.Context, id domain.SessionID, displayName string) error {
	s, ok := f.sessions[id]
	if !ok {
		return apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	s.DisplayName = displayName
	f.sessions[id] = s
	return nil
}

func (f *fakeSessionService) Send(_ context.Context, _ domain.SessionID, message string) error {
	f.sent = message
	return nil
}

func (f *fakeSessionService) ListPRs(_ context.Context, id domain.SessionID) ([]domain.PRFacts, error) {
	if f.listPRErr != nil {
		return nil, f.listPRErr
	}
	if _, ok := f.sessions[id]; !ok {
		return nil, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	return []domain.PRFacts{{URL: "https://github.com/aoagents/agent-orchestrator/pull/142", Number: 142, CI: domain.CIPassing, Review: domain.ReviewRequired, Mergeability: domain.MergeMergeable, UpdatedAt: time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)}}, nil
}

func (f *fakeSessionService) ListPRSummaries(_ context.Context, id domain.SessionID) ([]sessionsvc.PRSummary, error) {
	if f.listPRErr != nil {
		return nil, f.listPRErr
	}
	if _, ok := f.sessions[id]; !ok {
		return nil, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	return []sessionsvc.PRSummary{{
		URL:          "https://github.com/aoagents/agent-orchestrator/pull/142",
		HTMLURL:      "https://github.com/aoagents/agent-orchestrator/pull/142",
		Number:       142,
		Title:        "Wire SCM summaries",
		State:        domain.PRStateOpen,
		Provider:     "github",
		Repo:         "aoagents/agent-orchestrator",
		Author:       "ada",
		SourceBranch: "codex/scm-observer-v1",
		TargetBranch: "main",
		HeadSHA:      "abc123",
		CI: sessionsvc.PRCISummary{State: domain.CIFailing, FailingChecks: []sessionsvc.PRFailingCheck{{
			Name:       "unit",
			Status:     domain.PRCheckFailed,
			Conclusion: "failure",
			URL:        "https://github.com/aoagents/agent-orchestrator/actions/runs/1",
		}}},
		Review: sessionsvc.PRReviewSummary{
			Decision:                   domain.ReviewChangesRequest,
			HasUnresolvedHumanComments: true,
			UnresolvedBy: []sessionsvc.PRUnresolvedReviewer{{
				ReviewerID: "reviewer-a",
				Count:      1,
				ReviewURL:  "https://github.com/aoagents/agent-orchestrator/pull/142#pullrequestreview-1",
				Links:      []sessionsvc.PRReviewCommentLink{{URL: "https://github.com/aoagents/agent-orchestrator/pull/142#discussion_r1", File: "main.go", Line: 12}},
			}},
		},
		Mergeability: sessionsvc.PRMergeabilitySummary{
			State:   domain.MergeConflicting,
			Reasons: []string{"conflicts"},
			PRURL:   "https://github.com/aoagents/agent-orchestrator/pull/142",
		},
		UpdatedAt: time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC),
	}}, nil
}

func (f *fakeSessionService) ClaimPR(_ context.Context, id domain.SessionID, ref string, opts sessionsvc.ClaimPROptions) (sessionsvc.ClaimPRResult, error) {
	if f.claimErr != nil {
		return sessionsvc.ClaimPRResult{}, f.claimErr
	}
	if _, ok := f.sessions[id]; !ok {
		return sessionsvc.ClaimPRResult{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	prs, _ := f.ListPRs(context.Background(), id)
	return sessionsvc.ClaimPRResult{PRs: prs, TakenOverFrom: []domain.SessionID{}, BranchChanged: true}, nil
}

func newSessionTestServer(t *testing.T, svc *fakeSessionService) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Sessions: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSessionsRoutes_DefaultToStubsWithoutService(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/sessions", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}

func TestSessionsAPI_ListSpawnGetAndActions(t *testing.T) {
	svc := newFakeSessionService()
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{Branch: "qa/modal-worker", WorkspacePath: "/tmp/private-worktree", RuntimeHandleID: "runtime-1", Prompt: "private prompt"}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/sessions?project=ao", "")
	if status != http.StatusOK {
		t.Fatalf("GET sessions = %d, want 200; body=%s", status, body)
	}
	var list struct {
		Sessions []sessionBody `json:"sessions"`
	}
	mustJSON(t, body, &list)
	if len(list.Sessions) != 1 || list.Sessions[0].ID != "ao-1" || list.Sessions[0].Status != string(domain.StatusIdle) || list.Sessions[0].TerminalHandleID != "ao-1/terminal_0" {
		t.Fatalf("list = %#v", list)
	}
	if list.Sessions[0].Branch != "qa/modal-worker" {
		t.Fatalf("branch = %q, want qa/modal-worker", list.Sessions[0].Branch)
	}
	var rawList struct {
		Sessions []map[string]any `json:"sessions"`
	}
	mustJSON(t, body, &rawList)
	if _, ok := rawList.Sessions[0]["metadata"]; ok {
		t.Fatalf("list leaked metadata: %s", body)
	}
	if _, ok := rawList.Sessions[0]["workspacePath"]; ok {
		t.Fatalf("list leaked workspacePath: %s", body)
	}
	if _, ok := rawList.Sessions[0]["prompt"]; ok {
		t.Fatalf("list leaked prompt: %s", body)
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/sessions", `{"projectId":"ao","issueId":"ISS-1","kind":"worker","harness":"codex","prompt":"fix","displayName":"my worker"}`)
	if status != http.StatusCreated {
		t.Fatalf("POST session = %d, want 201; body=%s", status, body)
	}
	var spawned struct {
		Session sessionBody `json:"session"`
	}
	mustJSON(t, body, &spawned)
	if spawned.Session.ID != "ao-2" || spawned.Session.IssueID != "ISS-1" || spawned.Session.Harness != "codex" {
		t.Fatalf("spawned = %#v", spawned)
	}
	if spawned.Session.DisplayName != "my worker" {
		t.Fatalf("spawned displayName = %q, want %q", spawned.Session.DisplayName, "my worker")
	}

	body, status, _ = doRequest(t, srv, "GET", "/api/v1/sessions/ao-2", "")
	if status != http.StatusOK {
		t.Fatalf("GET session = %d, want 200; body=%s", status, body)
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/sessions/ao-2/send", "{\"message\":\"con\\u0000tinue\"}")
	if status != http.StatusOK || svc.sent != "continue" {
		t.Fatalf("send status=%d sent=%q body=%s", status, svc.sent, body)
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/sessions/ao-2/kill", "")
	if status != http.StatusOK {
		t.Fatalf("kill = %d, want 200; body=%s", status, body)
	}
	var killed struct {
		SessionID string `json:"sessionId"`
		Freed     bool   `json:"freed"`
	}
	mustJSON(t, body, &killed)
	if killed.SessionID != "ao-2" || !killed.Freed {
		t.Fatalf("kill response = %#v", killed)
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/sessions/ao-2/restore", "")
	if status != http.StatusOK {
		t.Fatalf("restore = %d, want 200; body=%s", status, body)
	}

	body, status, _ = doRequest(t, srv, "PATCH", "/api/v1/sessions/ao-2", `{"displayName":"Renamed"}`)
	if status != http.StatusOK {
		t.Fatalf("rename = %d, want 200; body=%s", status, body)
	}
	var renamed struct {
		OK          bool   `json:"ok"`
		SessionID   string `json:"sessionId"`
		DisplayName string `json:"displayName"`
	}
	mustJSON(t, body, &renamed)
	if !renamed.OK || renamed.SessionID != "ao-2" || renamed.DisplayName != "Renamed" {
		t.Fatalf("rename response = %#v", renamed)
	}
	if svc.sessions["ao-2"].DisplayName != "Renamed" {
		t.Fatalf("session displayName not updated: %+v", svc.sessions["ao-2"])
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/orchestrators", `{"projectId":"ao"}`)
	if status != http.StatusCreated {
		t.Fatalf("orchestrator = %d, want 201; body=%s", status, body)
	}
}

func TestSessionsAPI_PreviewDiscoversAndServesStaticIndex(t *testing.T) {
	svc := newFakeSessionService()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "index.html"), []byte(`<link rel="stylesheet" href="styles.css"><script src="app.js"></script>`), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "styles.css"), []byte(`body { color: red; }`), 0o644); err != nil {
		t.Fatalf("write css: %v", err)
	}
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{WorkspacePath: workspace}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/sessions/ao-1/preview", "")
	if status != http.StatusOK {
		t.Fatalf("preview = %d, want 200; body=%s", status, body)
	}
	var preview struct {
		SessionID  string `json:"sessionId"`
		PreviewURL string `json:"previewUrl"`
		Entry      string `json:"entry"`
	}
	mustJSON(t, body, &preview)
	if preview.SessionID != "ao-1" || preview.Entry != "index.html" || preview.PreviewURL == "" {
		t.Fatalf("preview response = %#v", preview)
	}
	if strings.Contains(preview.PreviewURL, workspace) {
		t.Fatalf("preview leaked workspace path: %s", preview.PreviewURL)
	}
	if !strings.Contains(preview.PreviewURL, "/index.html") {
		t.Fatalf("preview URL = %q, want index.html asset path", preview.PreviewURL)
	}
	parsed, err := url.Parse(preview.PreviewURL)
	if err != nil {
		t.Fatalf("parse preview URL: %v", err)
	}
	body, status, headers := doRequest(t, srv, "GET", parsed.RequestURI(), "")
	if status != http.StatusOK {
		t.Fatalf("preview file = %d, want 200; body=%s", status, body)
	}
	if !strings.Contains(headers.Get("Content-Type"), "text/html") {
		t.Fatalf("content type = %q, want text/html", headers.Get("Content-Type"))
	}
	if !strings.Contains(string(body), "styles.css") {
		t.Fatalf("preview body did not serve index: %s", body)
	}
}

func TestSessionsAPI_SetPreviewExplicitURLPersists(t *testing.T) {
	svc := newFakeSessionService()
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{"url":"http://localhost:5173/"}`)
	if status != http.StatusOK {
		t.Fatalf("set preview = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Session struct {
			PreviewURL string `json:"previewUrl"`
		} `json:"session"`
	}
	mustJSON(t, body, &resp)
	if resp.Session.PreviewURL != "http://localhost:5173/" {
		t.Fatalf("response previewUrl = %q, want explicit url", resp.Session.PreviewURL)
	}
	if got := svc.sessions["ao-1"].Metadata.PreviewURL; got != "http://localhost:5173/" {
		t.Fatalf("persisted previewUrl = %q, want explicit url", got)
	}
}

func TestSessionsAPI_SetPreviewEmptyURLAutodetectsIndex(t *testing.T) {
	svc := newFakeSessionService()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "index.html"), []byte(`<html></html>`), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{WorkspacePath: workspace}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{}`)
	if status != http.StatusOK {
		t.Fatalf("set preview = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Session struct {
			PreviewURL string `json:"previewUrl"`
		} `json:"session"`
	}
	mustJSON(t, body, &resp)
	if !strings.Contains(resp.Session.PreviewURL, "/index.html") {
		t.Fatalf("response previewUrl = %q, want autodetected index.html URL", resp.Session.PreviewURL)
	}
	if strings.Contains(resp.Session.PreviewURL, workspace) {
		t.Fatalf("preview leaked workspace path: %s", resp.Session.PreviewURL)
	}
}

func TestSessionsAPI_SetPreviewEmptyURLPrefersWorkspaceEntryOverExistingTarget(t *testing.T) {
	svc := newFakeSessionService()
	workspace := t.TempDir()
	// An index.html exists, so bare `ao preview` returns to the workspace entry
	// instead of sticking to the last explicit target.
	if err := os.WriteFile(filepath.Join(workspace, "index.html"), []byte(`<html></html>`), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{WorkspacePath: workspace, PreviewURL: "http://localhost:4321/docs"}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{}`)
	if status != http.StatusOK {
		t.Fatalf("set preview = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Session struct {
			PreviewURL string `json:"previewUrl"`
		} `json:"session"`
	}
	mustJSON(t, body, &resp)
	if !strings.HasSuffix(resp.Session.PreviewURL, "/preview/files/index.html") {
		t.Fatalf("response previewUrl = %q, want workspace index files URL", resp.Session.PreviewURL)
	}
}

func TestSessionsAPI_SetPreviewEmptyURLNormalizesExistingRelativeTarget(t *testing.T) {
	svc := newFakeSessionService()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "index.html"), []byte(`<html></html>`), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{WorkspacePath: workspace, PreviewURL: "index.html"}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{}`)
	if status != http.StatusOK {
		t.Fatalf("set preview = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Session struct {
			PreviewURL string `json:"previewUrl"`
		} `json:"session"`
	}
	mustJSON(t, body, &resp)
	if !strings.HasSuffix(resp.Session.PreviewURL, "/preview/files/index.html") {
		t.Fatalf("response previewUrl = %q, want index.html files URL", resp.Session.PreviewURL)
	}
	if got := svc.sessions["ao-1"].Metadata.PreviewURL; got != resp.Session.PreviewURL {
		t.Fatalf("persisted previewUrl = %q, want normalized response URL %q", got, resp.Session.PreviewURL)
	}
}

func TestSessionsAPI_SetPreviewEmptyURLReusesExistingTargetWhenNoEntryExists(t *testing.T) {
	svc := newFakeSessionService()
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{WorkspacePath: t.TempDir(), PreviewURL: "http://localhost:4321/docs"}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{}`)
	if status != http.StatusOK {
		t.Fatalf("set preview = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Session struct {
			PreviewURL string `json:"previewUrl"`
		} `json:"session"`
	}
	mustJSON(t, body, &resp)
	if resp.Session.PreviewURL != "http://localhost:4321/docs" {
		t.Fatalf("response previewUrl = %q, want reused existing target", resp.Session.PreviewURL)
	}
}

func TestSessionsAPI_SetPreviewLocalRelativePathResolvesToFilesURL(t *testing.T) {
	svc := newFakeSessionService()
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "dist"), 0o755); err != nil {
		t.Fatalf("mkdir dist: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "dist", "index.html"), []byte(`<html></html>`), 0o644); err != nil {
		t.Fatalf("write dist index: %v", err)
	}
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{WorkspacePath: workspace}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{"url":"./dist/index.html"}`)
	if status != http.StatusOK {
		t.Fatalf("set preview = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Session struct {
			PreviewURL string `json:"previewUrl"`
		} `json:"session"`
	}
	mustJSON(t, body, &resp)
	if !strings.HasSuffix(resp.Session.PreviewURL, "/preview/files/dist/index.html") {
		t.Fatalf("response previewUrl = %q, want dist/index.html files URL", resp.Session.PreviewURL)
	}
	if strings.Contains(resp.Session.PreviewURL, workspace) {
		t.Fatalf("preview leaked workspace path: %s", resp.Session.PreviewURL)
	}
	// The resolved files URL actually serves the local file.
	parsed, err := url.Parse(resp.Session.PreviewURL)
	if err != nil {
		t.Fatalf("parse preview URL: %v", err)
	}
	fileBody, fileStatus, _ := doRequest(t, srv, "GET", parsed.RequestURI(), "")
	if fileStatus != http.StatusOK {
		t.Fatalf("serve local file = %d, want 200; body=%s", fileStatus, fileBody)
	}
}

func TestSessionsAPI_SetPreviewAbsoluteFilePathPersistsFileURL(t *testing.T) {
	svc := newFakeSessionService()
	file := filepath.Join(t.TempDir(), "implementation_plan.html")
	if err := os.WriteFile(file, []byte(`<html></html>`), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{"url":`+strconv.Quote(file)+`}`)
	if status != http.StatusOK {
		t.Fatalf("set preview = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Session struct {
			PreviewURL string `json:"previewUrl"`
		} `json:"session"`
	}
	mustJSON(t, body, &resp)
	parsed, err := url.Parse(resp.Session.PreviewURL)
	if err != nil {
		t.Fatalf("parse preview url: %v", err)
	}
	if parsed.Scheme != "file" {
		t.Fatalf("previewUrl = %q, want file URL", resp.Session.PreviewURL)
	}
}

func TestSessionsAPI_SetPreviewMissingAbsoluteFilePathFailsWithoutOverwriting(t *testing.T) {
	svc := newFakeSessionService()
	missing := filepath.Join(t.TempDir(), "implmentation_plan.html")
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{PreviewURL: "http://localhost:4321/docs"}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{"url":`+strconv.Quote(missing)+`}`)
	if status != http.StatusNotFound {
		t.Fatalf("set missing absolute preview = %d, want 404; body=%s", status, body)
	}
	if got := svc.sessions["ao-1"].Metadata.PreviewURL; got != "http://localhost:4321/docs" {
		t.Fatalf("persisted previewUrl = %q, want existing target preserved", got)
	}
}

func TestSessionsAPI_SetPreviewBumpsRevisionOnSameURL(t *testing.T) {
	svc := newFakeSessionService()
	srv := newSessionTestServer(t, svc)

	readRevision := func() int64 {
		body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{"url":"http://localhost:5173/"}`)
		if status != http.StatusOK {
			t.Fatalf("set preview = %d, want 200; body=%s", status, body)
		}
		var resp struct {
			Session struct {
				PreviewRevision int64 `json:"previewRevision"`
			} `json:"session"`
		}
		mustJSON(t, body, &resp)
		return resp.Session.PreviewRevision
	}
	first := readRevision()
	second := readRevision()
	if second <= first {
		t.Fatalf("revision did not advance on same-URL re-run: first=%d second=%d", first, second)
	}
}

func TestSessionsAPI_ClearPreviewResetsURL(t *testing.T) {
	svc := newFakeSessionService()
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{PreviewURL: "http://localhost:5173/"}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "DELETE", "/api/v1/sessions/ao-1/preview", "")
	if status != http.StatusOK {
		t.Fatalf("clear preview = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Session struct {
			PreviewURL string `json:"previewUrl"`
		} `json:"session"`
	}
	mustJSON(t, body, &resp)
	if resp.Session.PreviewURL != "" {
		t.Fatalf("response previewUrl = %q, want empty after clear", resp.Session.PreviewURL)
	}
	if got := svc.sessions["ao-1"].Metadata.PreviewURL; got != "" {
		t.Fatalf("persisted previewUrl = %q, want empty after clear", got)
	}
}

func TestSessionsAPI_ClearPreviewNotFound(t *testing.T) {
	srv := newSessionTestServer(t, newFakeSessionService())

	body, status, _ := doRequest(t, srv, "DELETE", "/api/v1/sessions/missing-1/preview", "")
	assertErrorCode(t, body, status, http.StatusNotFound, "SESSION_NOT_FOUND")
}

func TestSessionsAPI_SetPreviewEmptyURLNoEntry(t *testing.T) {
	svc := newFakeSessionService()
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{WorkspacePath: t.TempDir()}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{}`)
	assertErrorCode(t, body, status, http.StatusNotFound, "NO_PREVIEW_ENTRY")
}

func TestSessionsAPI_SetPreviewNotFound(t *testing.T) {
	srv := newSessionTestServer(t, newFakeSessionService())

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/missing-1/preview", `{"url":"http://x"}`)
	assertErrorCode(t, body, status, http.StatusNotFound, "SESSION_NOT_FOUND")
}

func TestSessionsAPI_SpawnBranchNotFetchedReturnsTypedError(t *testing.T) {
	svc := newFakeSessionService()
	svc.spawnErr = apierr.Invalid("BRANCH_NOT_FETCHED", `workspace: branch is not fetched: "feature/missing"`, nil)
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions", `{"projectId":"ao","kind":"worker","branch":"feature/missing","prompt":"fix"}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "BRANCH_NOT_FETCHED")
}

// TestSessionsAPI_SpawnRejectsOverlongDisplayName asserts the spawn endpoint
// caps displayName at 20 characters even though the field itself is optional
// (the desktop new-task dialog omits it). `ao spawn` enforces the same limit
// CLI-side before the request is sent.
func TestSessionsAPI_SpawnRejectsOverlongDisplayName(t *testing.T) {
	srv := newSessionTestServer(t, newFakeSessionService())

	overlong := strings.Repeat("x", 21)
	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions", `{"projectId":"ao","harness":"codex","displayName":"`+overlong+`"}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "DISPLAY_NAME_TOO_LONG")
}

func TestSessionsAPI_RenameNotFound(t *testing.T) {
	srv := newSessionTestServer(t, newFakeSessionService())

	body, status, _ := doRequest(t, srv, "PATCH", "/api/v1/sessions/missing-1", `{"displayName":"Renamed"}`)
	assertErrorCode(t, body, status, http.StatusNotFound, "SESSION_NOT_FOUND")
}

func TestSessionsAPI_RenameValidation(t *testing.T) {
	srv := newSessionTestServer(t, newFakeSessionService())

	body, status, _ := doRequest(t, srv, "PATCH", "/api/v1/sessions/ao-1", `{"displayName":"  "}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "DISPLAY_NAME_REQUIRED")

	body, status, _ = doRequest(t, srv, "PATCH", "/api/v1/sessions/ao-1", `{`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_JSON")
}

func TestSessionsAPI_ListOrchestratorsOnly(t *testing.T) {
	svc := newFakeSessionService()
	now := time.Now().UTC()
	svc.sessions["ao-orch"] = domain.Session{
		SessionRecord: domain.SessionRecord{
			ID:        "ao-orch",
			ProjectID: "ao",
			Kind:      domain.KindOrchestrator,
			Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
			CreatedAt: now,
			UpdatedAt: now,
		},
		Status: domain.StatusIdle,
	}
	svc.sessions["other-orch"] = domain.Session{
		SessionRecord: domain.SessionRecord{
			ID:        "other-orch",
			ProjectID: "other",
			Kind:      domain.KindOrchestrator,
			Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
			CreatedAt: now,
			UpdatedAt: now,
		},
		Status: domain.StatusIdle,
	}
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/orchestrators", "")
	if status != http.StatusOK {
		t.Fatalf("GET orchestrators = %d, want 200; body=%s", status, body)
	}
	var list struct {
		Sessions []sessionBody `json:"sessions"`
	}
	mustJSON(t, body, &list)
	if len(list.Sessions) != 2 {
		t.Fatalf("len(orchestrators) = %d, want 2; body=%s", len(list.Sessions), body)
	}
	got := map[string]string{}
	for _, sess := range list.Sessions {
		got[sess.ID] = sess.Kind
	}
	if got["ao-orch"] != string(domain.KindOrchestrator) || got["other-orch"] != string(domain.KindOrchestrator) {
		t.Fatalf("missing orchestrators: %#v", got)
	}
	if _, ok := got["ao-1"]; ok {
		t.Fatalf("worker session leaked into orchestrator list: %#v", got)
	}
}

func TestSessionsAPI_SendValidation(t *testing.T) {
	srv := newSessionTestServer(t, newFakeSessionService())

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/send", `{"message":""}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "MESSAGE_REQUIRED")
}

func TestSessionsAPI_CleanupWithProjectFilter(t *testing.T) {
	svc := newFakeSessionService()
	svc.cleanupResult = []domain.SessionID{"ao-1"}
	svc.cleanupSkipped = []sessionsvc.CleanupSkipped{{SessionID: "ao-2", Reason: "workspace has uncommitted changes"}}
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/cleanup?project=ao", "")
	if status != http.StatusOK {
		t.Fatalf("cleanup = %d, want 200; body=%s", status, body)
	}
	var got struct {
		OK      bool     `json:"ok"`
		Cleaned []string `json:"cleaned"`
		Skipped []struct {
			SessionID string `json:"sessionId"`
			Reason    string `json:"reason"`
		} `json:"skipped"`
	}
	mustJSON(t, body, &got)
	if !got.OK || len(got.Cleaned) != 1 || got.Cleaned[0] != "ao-1" {
		t.Fatalf("cleanup response = %#v", got)
	}
	if len(got.Skipped) != 1 || got.Skipped[0].SessionID != "ao-2" || got.Skipped[0].Reason != "workspace has uncommitted changes" {
		t.Fatalf("cleanup skipped = %#v, want preserved workspace with reason", got.Skipped)
	}
	if len(svc.cleanupProjects) != 1 || svc.cleanupProjects[0] != "ao" {
		t.Fatalf("cleanupProjects = %#v, want [ao]", svc.cleanupProjects)
	}
}

func TestSessionsAPI_CleanupWithoutProjectFilter(t *testing.T) {
	svc := newFakeSessionService()
	svc.cleanupResult = []domain.SessionID{"ao-1", "other-1"}
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/cleanup", "")
	if status != http.StatusOK {
		t.Fatalf("cleanup = %d, want 200; body=%s", status, body)
	}
	var got struct {
		Cleaned []string `json:"cleaned"`
	}
	mustJSON(t, body, &got)
	if len(got.Cleaned) != 2 || got.Cleaned[0] != "ao-1" || got.Cleaned[1] != "other-1" {
		t.Fatalf("cleanup response = %#v", got)
	}
	if len(svc.cleanupProjects) != 1 || svc.cleanupProjects[0] != "" {
		t.Fatalf("cleanupProjects = %#v, want empty project filter", svc.cleanupProjects)
	}
}

type sessionBody struct {
	ID               string `json:"id"`
	ProjectID        string `json:"projectId"`
	IssueID          string `json:"issueId"`
	Kind             string `json:"kind"`
	Harness          string `json:"harness"`
	DisplayName      string `json:"displayName"`
	Branch           string `json:"branch"`
	Status           string `json:"status"`
	TerminalHandleID string `json:"terminalHandleId"`
}

func TestSessionsAPI_PRRoutes(t *testing.T) {
	srv := newSessionTestServer(t, newFakeSessionService())

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/sessions/ao-1/pr", "")
	if status != http.StatusOK {
		t.Fatalf("GET PRs = %d body=%s", status, body)
	}
	var listed struct {
		SessionID string `json:"sessionId"`
		PRs       []struct {
			URL    string `json:"url"`
			Number int    `json:"number"`
			Title  string `json:"title"`
			State  string `json:"state"`
			CI     struct {
				State         string `json:"state"`
				FailingChecks []struct {
					Name       string `json:"name"`
					Status     string `json:"status"`
					Conclusion string `json:"conclusion"`
					URL        string `json:"url"`
					LogTail    string `json:"logTail"`
				} `json:"failingChecks"`
			} `json:"ci"`
			Review struct {
				Decision     string `json:"decision"`
				UnresolvedBy []struct {
					ReviewerID string `json:"reviewerId"`
					Count      int    `json:"count"`
					ReviewURL  string `json:"reviewUrl"`
					Links      []struct {
						URL  string `json:"url"`
						File string `json:"file"`
						Line int    `json:"line"`
						Body string `json:"body"`
					} `json:"links"`
				} `json:"unresolvedBy"`
			} `json:"review"`
			Mergeability struct {
				State         string   `json:"state"`
				Reasons       []string `json:"reasons"`
				PRURL         string   `json:"prUrl"`
				ConflictFiles []struct {
					Path string `json:"path"`
				} `json:"conflictFiles"`
			} `json:"mergeability"`
		} `json:"prs"`
	}
	mustJSON(t, body, &listed)
	if listed.SessionID != "ao-1" || len(listed.PRs) != 1 || listed.PRs[0].State != "open" || listed.PRs[0].Title == "" {
		t.Fatalf("GET shape = %#v", listed)
	}
	if checks := listed.PRs[0].CI.FailingChecks; len(checks) != 1 || checks[0].Name != "unit" || checks[0].LogTail != "" {
		t.Fatalf("failing checks = %#v", checks)
	}
	if reviewers := listed.PRs[0].Review.UnresolvedBy; len(reviewers) != 1 || reviewers[0].ReviewerID != "reviewer-a" || reviewers[0].ReviewURL == "" || reviewers[0].Links[0].Body != "" {
		t.Fatalf("reviewers = %#v", reviewers)
	}
	if merge := listed.PRs[0].Mergeability; merge.State != "conflicting" || len(merge.ConflictFiles) != 0 || merge.PRURL == "" {
		t.Fatalf("mergeability = %#v", merge)
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/pr/claim", `{"pr":"142"}`)
	if status != http.StatusOK {
		t.Fatalf("claim = %d body=%s", status, body)
	}
	var claimed struct {
		OK            bool     `json:"ok"`
		SessionID     string   `json:"sessionId"`
		PRs           []any    `json:"prs"`
		BranchChanged bool     `json:"branchChanged"`
		TakenOverFrom []string `json:"takenOverFrom"`
	}
	mustJSON(t, body, &claimed)
	if !claimed.OK || claimed.SessionID != "ao-1" || len(claimed.PRs) != 1 || !claimed.BranchChanged || len(claimed.TakenOverFrom) != 0 {
		t.Fatalf("claim shape = %#v", claimed)
	}
}

func TestSessionsAPI_ClaimPRErrors(t *testing.T) {
	cases := []struct {
		name string
		body string
		err  error
		code int
		want string
	}{
		{"bad json", `{`, nil, http.StatusBadRequest, "INVALID_JSON"},
		{"missing pr", `{}`, nil, http.StatusBadRequest, "PR_REQUIRED"},
		{"invalid ref", `{"pr":"x"}`, sessionsvc.ErrInvalidPRRef, http.StatusBadRequest, "INVALID_PR_REF"},
		{"session missing", `{"pr":"142"}`, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session"), http.StatusNotFound, "SESSION_NOT_FOUND"},
		{"pr missing", `{"pr":"142"}`, sessionsvc.ErrPRNotFound, http.StatusNotFound, "PR_NOT_FOUND"},
		{"not open", `{"pr":"142"}`, sessionsvc.ErrPRNotOpen, http.StatusConflict, "PR_NOT_OPEN"},
		{"claimed", `{"pr":"142","allowTakeover":false}`, ports.PRClaimedByActiveSessionError{Owner: "ao-2"}, http.StatusConflict, "PR_CLAIMED_BY_ACTIVE_SESSION"},
		{"not claimable", `{"pr":"142"}`, sessionsvc.ErrSessionNotClaimable, http.StatusUnprocessableEntity, "SESSION_NOT_CLAIMABLE"},
		{"mismatch", `{"pr":"142"}`, sessionsvc.ErrProjectMismatch, http.StatusUnprocessableEntity, "PR_PROJECT_MISMATCH"},
		{"scm", `{"pr":"142"}`, sessionsvc.ErrSCMUnavailable, http.StatusServiceUnavailable, "SCM_UNAVAILABLE"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := newFakeSessionService()
			svc.claimErr = tc.err
			srv := newSessionTestServer(t, svc)
			body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/pr/claim", tc.body)
			assertErrorCode(t, body, status, tc.code, tc.want)
		})
	}
}
