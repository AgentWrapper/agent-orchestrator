package controllers

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	previewutil "github.com/aoagents/agent-orchestrator/backend/internal/preview"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

const (
	maxPromptLen      = 4096
	maxMessageLen     = 4096
	maxDisplayNameLen = 20
)

var errPreviewFileNotFound = errors.New("preview file not found")

// SessionService is the controller-facing session service contract.
type SessionService interface {
	List(ctx context.Context, filter sessionsvc.ListFilter) ([]domain.Session, error)
	Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, error)
	SpawnOrchestrator(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error)
	Get(ctx context.Context, id domain.SessionID) (domain.Session, error)
	Restore(ctx context.Context, id domain.SessionID) (domain.Session, error)
	Kill(ctx context.Context, id domain.SessionID) (bool, error)
	RollbackSpawn(ctx context.Context, id domain.SessionID) (sessionsvc.RollbackOutcome, error)
	Cleanup(ctx context.Context, project domain.ProjectID) (sessionsvc.CleanupOutcome, error)
	Rename(ctx context.Context, id domain.SessionID, displayName string) error
	SetPreview(ctx context.Context, id domain.SessionID, previewURL string) (domain.Session, error)
	Send(ctx context.Context, id domain.SessionID, message string) error
	ListPRSummaries(ctx context.Context, id domain.SessionID) ([]sessionsvc.PRSummary, error)
	ClaimPR(ctx context.Context, id domain.SessionID, ref string, opts sessionsvc.ClaimPROptions) (sessionsvc.ClaimPRResult, error)
	ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (sessionsvc.WorkspaceFiles, error)
	GetWorkspaceFile(ctx context.Context, id domain.SessionID, path string) (sessionsvc.WorkspaceFileDetail, error)
}

// ActivityRecorder applies an agent activity-state signal to a session. It is
// satisfied directly by *lifecycle.Manager: an activity signal is a pure
// lifecycle reduction (no runtime/workspace teardown), so it bypasses
// SessionService rather than threading a no-op passthrough through the session
// manager.
type ActivityRecorder interface {
	ApplyActivitySignal(ctx context.Context, id domain.SessionID, s ports.ActivitySignal) error
}

// SessionsController owns the session routes. Nil keeps routes registered but
// returns OpenAPI-backed 501s.
type SessionsController struct {
	Svc      SessionService
	Activity ActivityRecorder
}

// Register mounts the session routes on the supplied router.
func (c *SessionsController) Register(r chi.Router) {
	r.Get("/sessions", c.list)
	r.Post("/sessions", c.spawn)
	r.Post("/sessions/cleanup", c.cleanup)
	r.Get("/sessions/{sessionId}", c.get)
	r.Get("/sessions/{sessionId}/preview", c.preview)
	r.Post("/sessions/{sessionId}/preview", c.setPreview)
	r.Delete("/sessions/{sessionId}/preview", c.clearPreview)
	r.Get("/sessions/{sessionId}/preview/files/*", c.previewFile)
	r.Get("/sessions/{sessionId}/workspace/files", c.listWorkspaceFiles)
	r.Get("/sessions/{sessionId}/workspace/file", c.getWorkspaceFile)
	r.Get("/sessions/{sessionId}/pr", c.listPRs)
	r.Post("/sessions/{sessionId}/pr/claim", c.claimPR)
	r.Patch("/sessions/{sessionId}", c.rename)
	r.Post("/sessions/{sessionId}/restore", c.restore)
	r.Post("/sessions/{sessionId}/kill", c.kill)
	r.Post("/sessions/{sessionId}/rollback", c.rollback)
	r.Post("/sessions/{sessionId}/send", c.send)
	r.Post("/sessions/{sessionId}/activity", c.activity)
	r.Get("/orchestrators", c.listOrchestrators)
	r.Post("/orchestrators", c.spawnOrchestrator)
	r.Get("/orchestrators/{id}", c.getOrchestrator)
}

func (c *SessionsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions")
		return
	}
	filter, err := parseSessionListFilter(r)
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_QUERY", err.Error(), nil)
		return
	}
	sessions, err := c.Svc.List(r.Context(), filter)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ListSessionsResponse{Sessions: sessionViews(sessions)})
}

func (c *SessionsController) spawn(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions")
		return
	}
	var in SpawnSessionRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.ProjectID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "PROJECT_ID_REQUIRED", "projectId is required", nil)
		return
	}
	if len(in.Prompt) > maxPromptLen {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "PROMPT_TOO_LONG", "prompt is too long", nil)
		return
	}
	// displayName is optional at the API (the desktop new-task dialog omits it
	// and the read model falls back to the session id). `ao spawn` makes it
	// required CLI-side. When present, it is held to the same length cap here so
	// a direct API call cannot exceed it.
	displayName := strings.TrimSpace(in.DisplayName)
	if utf8.RuneCountInString(displayName) > maxDisplayNameLen {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "DISPLAY_NAME_TOO_LONG", "displayName must be 20 characters or fewer", nil)
		return
	}
	if in.Kind == "" {
		in.Kind = domain.KindWorker
	}
	sess, err := c.Svc.Spawn(r.Context(), ports.SpawnConfig{ProjectID: in.ProjectID, IssueID: in.IssueID, Kind: in.Kind, Harness: in.Harness, Branch: in.Branch, Prompt: in.Prompt, DisplayName: displayName})
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, SessionResponse{Session: sessionView(sess)})
}

func (c *SessionsController) get(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}")
		return
	}
	sess, err := c.Svc.Get(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SessionResponse{Session: sessionView(sess)})
}

func (c *SessionsController) preview(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}/preview")
		return
	}
	sess, err := c.Svc.Get(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	entry, ok := discoverPreviewEntry(sess.Metadata.WorkspacePath)
	res := SessionPreviewResponse{SessionID: sessionID(r)}
	if ok {
		res.Entry = entry
		res.PreviewURL, err = previewFileURL(r, sessionID(r), entry)
		if err != nil {
			writePreviewResolveError(w, r, err)
			return
		}
	}
	envelope.WriteJSON(w, http.StatusOK, res)
}

func (c *SessionsController) previewFile(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}/preview/files/*")
		return
	}
	sess, err := c.Svc.Get(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	c.serveWorkspacePreviewFile(w, r, sess.Metadata.WorkspacePath, chi.URLParam(r, "*"))
}

// PreviewOrigin serves a workspace preview from its isolated *.localhost
// origin. It returns false when the request host is not a preview origin so the
// daemon router can continue handling its normal API and control surfaces.
//
// The selected entry's directory is mounted at the origin root. For example,
// dist/index.html is reachable at both /dist/ (the persisted URL) and /, while
// /assets/app.css maps to dist/assets/app.css. This mirrors a production static
// server and fixes root-relative URLs without rewriting user-generated files.
func (c *SessionsController) PreviewOrigin(w http.ResponseWriter, r *http.Request) bool {
	id, ok := previewutil.SessionIDFromHost(r.Host)
	if !ok {
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		envelope.WriteAPIError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "METHOD_NOT_ALLOWED",
			r.Method+" not allowed on preview origin", nil)
		return true
	}
	if c.Svc == nil {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PREVIEW_NOT_FOUND", "Preview not found", nil)
		return true
	}
	sess, err := c.Svc.Get(r.Context(), id)
	if err != nil {
		envelope.WriteError(w, r, err)
		return true
	}
	entry, ok := previewOriginEntry(sess)
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "NO_PREVIEW_ENTRY", "No preview entry point found in session workspace", nil)
		return true
	}
	asset := previewOriginAssetPath(entry, r.URL.Path)
	c.serveWorkspacePreviewFile(w, r, sess.Metadata.WorkspacePath, asset)
	return true
}

func previewOriginEntry(sess domain.Session) (string, bool) {
	if entry, ok := previewutil.StoredWorkspaceEntry(sess.Metadata.PreviewURL, sess.ID); ok {
		if stored, exists := previewutil.EntryAtPath(sess.Metadata.WorkspacePath, entry); exists {
			return stored.Path, true
		}
	}
	return discoverPreviewEntry(sess.Metadata.WorkspacePath)
}

func previewOriginAssetPath(entry, requestPath string) string {
	requested := strings.TrimPrefix(path.Clean("/"+requestPath), "/")
	if requested == "" || requested == "." {
		return entry
	}
	root := path.Dir(entry)
	if root == "." {
		return requested
	}
	if requested == root {
		return entry
	}
	requested = strings.TrimPrefix(requested, root+"/")
	return path.Join(root, requested)
}

// serveWorkspacePreviewFile is the single serving path for both the legacy API
// route and isolated preview origins. OpenRoot keeps symlink traversal and the
// subsequent read on the same workspace-confined file handle.
func (c *SessionsController) serveWorkspacePreviewFile(w http.ResponseWriter, r *http.Request, workspacePath, assetPath string) {
	file, info, clean, err := previewutil.OpenWorkspaceFile(workspacePath, assetPath)
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PREVIEW_FILE_NOT_FOUND", "Preview file not found", nil)
		return
	}
	defer func() { _ = file.Close() }()
	if !previewutil.IsMarkdownPath(clean) {
		http.ServeContent(w, r, info.Name(), info.ModTime(), file)
		return
	}

	source, err := io.ReadAll(file)
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PREVIEW_FILE_NOT_FOUND", "Preview file not found", nil)
		return
	}
	rendered, err := previewutil.RenderMarkdown(source, filepath.Base(clean))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Method != http.MethodHead {
		_, _ = w.Write(rendered) //nolint:gosec // G705: preview content is workspace-local and agent-trusted
	}
}

func (c *SessionsController) listWorkspaceFiles(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}/workspace/files")
		return
	}
	files, err := c.Svc.ListWorkspaceFiles(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, workspaceFilesResponse(files))
}

func (c *SessionsController) getWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}/workspace/file")
		return
	}
	relPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if relPath == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "WORKSPACE_PATH_REQUIRED", "path is required", nil)
		return
	}
	file, err := c.Svc.GetWorkspaceFile(r.Context(), sessionID(r), relPath)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, workspaceFileResponse(file))
}

// setPreview persists the browser preview URL the desktop app opens for a
// session and fans out a session_updated CDC event so the dashboard's browser
// panel reacts live. The target is resolved as follows:
//
//   - An empty url opens the workspace's static entry point (index.html and
//     friends), falling back to the session's existing preview target only
//     when no entry point exists.
//   - An explicit workspace-local path (e.g. `index.html`, `./dist/index.html`)
//     is served through the preview/files route so local files load.
//   - Anything else (http(s)/file URLs, host:port dev servers) is kept verbatim.
//
// Every call bumps the session's preview revision, so re-running `ao preview`
// with the same target still refreshes the panel.
func (c *SessionsController) setPreview(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/preview")
		return
	}
	var in SetSessionPreviewRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	// Get first so a missing session is rejected with the normal 404 before any
	// write, and so autodetect/local resolution has the workspace path to probe.
	sess, err := c.Svc.Get(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	// ponytail: no URL sanitization on preview target; agent-trusted for now
	previewURL := strings.TrimSpace(in.URL)
	if previewURL == "" {
		if entry, ok := discoverPreviewEntry(sess.Metadata.WorkspacePath); ok {
			previewURL, err = previewFileURL(r, sessionID(r), entry)
			if err != nil {
				writePreviewResolveError(w, r, err)
				return
			}
		} else if existing := strings.TrimSpace(sess.Metadata.PreviewURL); existing != "" {
			var resolveErr error
			previewURL, resolveErr = resolvePreviewTarget(r, sessionID(r), sess.Metadata.WorkspacePath, existing)
			if resolveErr != nil {
				writePreviewResolveError(w, r, resolveErr)
				return
			}
		} else {
			envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "NO_PREVIEW_ENTRY", "No preview entry point found in session workspace", nil)
			return
		}
	} else {
		var resolveErr error
		previewURL, resolveErr = resolvePreviewTarget(r, sessionID(r), sess.Metadata.WorkspacePath, previewURL)
		if resolveErr != nil {
			writePreviewResolveError(w, r, resolveErr)
			return
		}
	}
	updated, err := c.Svc.SetPreview(r.Context(), sessionID(r), previewURL)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SessionResponse{Session: sessionView(updated)})
}

// clearPreview resets a session's browser preview to empty (`ao preview
// clear`). Unlike setPreview with an empty url it never autodetects: it persists
// an empty target so the desktop browser panel returns to its blank state. The
// write still bumps the preview revision, so the panel hears the change over
// CDC even though the url field is now empty.
func (c *SessionsController) clearPreview(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "DELETE", "/api/v1/sessions/{sessionId}/preview")
		return
	}
	updated, err := c.Svc.SetPreview(r.Context(), sessionID(r), "")
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SessionResponse{Session: sessionView(updated)})
}

func (c *SessionsController) listPRs(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}/pr")
		return
	}
	prs, err := c.Svc.ListPRSummaries(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ListSessionPRsResponse{SessionID: sessionID(r), PRs: sessionPRSummaries(prs)})
}

func (c *SessionsController) claimPR(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/pr/claim")
		return
	}
	var in ClaimPRRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if strings.TrimSpace(in.PR) == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "PR_REQUIRED", "pr is required", nil)
		return
	}
	allowTakeover := true
	if in.AllowTakeover != nil {
		allowTakeover = *in.AllowTakeover
	}
	res, err := c.Svc.ClaimPR(r.Context(), sessionID(r), in.PR, sessionsvc.ClaimPROptions{AllowTakeover: allowTakeover})
	if err != nil {
		writeSessionPRError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ClaimPRResponse{OK: true, SessionID: sessionID(r), PRs: sessionPRFacts(res.PRs), BranchChanged: res.BranchChanged, TakenOverFrom: nonNilSessionIDs(res.TakenOverFrom)})
}

func (c *SessionsController) rename(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "PATCH", "/api/v1/sessions/{sessionId}")
		return
	}
	var in RenameSessionRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	displayName := strings.TrimSpace(in.DisplayName)
	if displayName == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "DISPLAY_NAME_REQUIRED", "displayName is required", nil)
		return
	}
	if err := c.Svc.Rename(r.Context(), sessionID(r), displayName); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, RenameSessionResponse{OK: true, SessionID: sessionID(r), DisplayName: displayName})
}

func (c *SessionsController) restore(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/restore")
		return
	}
	sess, err := c.Svc.Restore(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, RestoreSessionResponse{OK: true, SessionID: sessionID(r), Session: sessionView(sess)})
}

func (c *SessionsController) kill(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/kill")
		return
	}
	freed, err := c.Svc.Kill(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, KillSessionResponse{OK: true, SessionID: sessionID(r), Freed: freed})
}

// rollback undoes a partially-completed spawn: if the session row is still in
// seed state (no workspace, no runtime handle yet), the row is deleted
// outright. If anything observable has landed it falls back to Kill so the
// runtime/workspace are torn down. Used by `ao spawn --claim-pr` to undo a
// session whose claim step failed, avoiding the orphan terminated row a
// plain Kill would leave behind.
func (c *SessionsController) rollback(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/rollback")
		return
	}
	out, err := c.Svc.RollbackSpawn(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, RollbackSessionResponse{OK: true, SessionID: sessionID(r), Deleted: out.Deleted, Killed: out.Killed})
}

func (c *SessionsController) cleanup(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/cleanup")
		return
	}
	out, err := c.Svc.Cleanup(r.Context(), domain.ProjectID(r.URL.Query().Get("project")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	skipped := make([]CleanupSkippedSession, 0, len(out.Skipped))
	for _, skip := range out.Skipped {
		skipped = append(skipped, CleanupSkippedSession{SessionID: skip.SessionID, Reason: skip.Reason})
	}
	envelope.WriteJSON(w, http.StatusOK, CleanupSessionsResponse{OK: true, Cleaned: out.Cleaned, Skipped: skipped})
}

func (c *SessionsController) send(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/send")
		return
	}
	var in SendSessionMessageRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.Message == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "MESSAGE_REQUIRED", "Message is required", nil)
		return
	}
	if len(in.Message) > maxMessageLen {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "MESSAGE_TOO_LONG", "Message is too long", nil)
		return
	}
	message := domain.SanitizeControlChars(in.Message)
	if err := c.Svc.Send(r.Context(), sessionID(r), message); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SendSessionMessageResponse{OK: true, SessionID: sessionID(r), Message: message})
}

// activity records an agent activity-state signal reported by an agent hook
// (via `ao hooks <agent> <event>`). It funnels through the single
// lifecycle.Manager so the reaper and hooks never race on the session's
// activity/termination columns.
func (c *SessionsController) activity(w http.ResponseWriter, r *http.Request) {
	if c.Activity == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/activity")
		return
	}
	var in SetActivityRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	state := domain.ActivityState(in.State)
	if state != "" {
		switch state {
		case domain.ActivityActive, domain.ActivityIdle, domain.ActivityWaitingInput, domain.ActivityBlocked, domain.ActivityExited:
		default:
			envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_ACTIVITY_STATE", "Unknown activity state", nil)
			return
		}
	}
	agentSessionID := capActivityMeta(domain.SanitizeControlChars(strings.TrimSpace(in.AgentSessionID)))
	if state == "" && agentSessionID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "ACTIVITY_OR_SESSION_ID_REQUIRED", "Activity state or agent session ID is required", nil)
		return
	}
	// The correlation fields ride the same lenient decode: absent on old CLIs.
	// They are externally-supplied strings headed for logs and in-memory maps,
	// so sanitize control chars and cap their length (a truncated id could
	// never match its pre/post counterpart, so overlong values are dropped by
	// the CLI; the cap here is defense against non-AO callers).
	sig := ports.ActivitySignal{
		Valid:          state != "",
		State:          state,
		Event:          capActivityMeta(domain.SanitizeControlChars(in.Event)),
		ToolName:       capActivityMeta(domain.SanitizeControlChars(in.ToolName)),
		ToolUseID:      capActivityMeta(domain.SanitizeControlChars(in.ToolUseID)),
		AgentSessionID: agentSessionID,
	}
	if err := c.Activity.ApplyActivitySignal(r.Context(), sessionID(r), sig); err != nil {
		if errors.Is(err, ports.ErrSessionNotFound) {
			envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "SESSION_NOT_FOUND", "Unknown session", nil)
			return
		}
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SetActivityResponse{OK: true, SessionID: sessionID(r), State: in.State})
}

// capActivityMeta bounds an optional activity correlation string; overlong
// values are dropped, not truncated (see the comment at its call site).
func capActivityMeta(v string) string {
	const maxLen = 256
	if len(v) > maxLen {
		return ""
	}
	return v
}

func (c *SessionsController) spawnOrchestrator(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/orchestrators")
		return
	}
	var in SpawnOrchestratorRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.ProjectID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "PROJECT_ID_REQUIRED", "projectId is required", nil)
		return
	}
	sess, err := c.Svc.SpawnOrchestrator(r.Context(), in.ProjectID, in.Clean)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, SpawnOrchestratorResponse{
		Orchestrator: OrchestratorResponse{ID: sess.ID, ProjectID: sess.ProjectID},
	})
}

func (c *SessionsController) listOrchestrators(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/orchestrators")
		return
	}
	sessions, err := c.Svc.List(r.Context(), sessionsvc.ListFilter{OrchestratorOnly: true})
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ListSessionsResponse{Sessions: sessionViews(sessions)})
}

func (c *SessionsController) getOrchestrator(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/orchestrators/{id}")
		return
	}
	sess, err := c.Svc.Get(r.Context(), orchestratorID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if sess.Kind != domain.KindOrchestrator {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "SESSION_NOT_FOUND", "Unknown session", nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SessionResponse{Session: sessionView(sess)})
}

func sessionID(r *http.Request) domain.SessionID {
	return domain.SessionID(chi.URLParam(r, "sessionId"))
}

func orchestratorID(r *http.Request) domain.SessionID {
	return domain.SessionID(chi.URLParam(r, "id"))
}

func parseSessionListFilter(r *http.Request) (sessionsvc.ListFilter, error) {
	q := r.URL.Query()
	filter := sessionsvc.ListFilter{ProjectID: domain.ProjectID(q.Get("project"))}
	if raw := q.Get("active"); raw != "" {
		active, err := strconv.ParseBool(raw)
		if err != nil {
			return sessionsvc.ListFilter{}, errors.New("active must be a boolean")
		}
		filter.Active = &active
	}
	if raw := q.Get("orchestratorOnly"); raw != "" {
		orchestratorOnly, err := strconv.ParseBool(raw)
		if err != nil {
			return sessionsvc.ListFilter{}, errors.New("orchestratorOnly must be a boolean")
		}
		filter.OrchestratorOnly = orchestratorOnly
	}
	if raw := q.Get("fresh"); raw != "" {
		fresh, err := strconv.ParseBool(raw)
		if err != nil {
			return sessionsvc.ListFilter{}, errors.New("fresh must be a boolean")
		}
		filter.Fresh = fresh
	}
	return filter, nil
}

func writeSessionPRError(w http.ResponseWriter, r *http.Request, err error) {
	var claimed ports.PRClaimedByActiveSessionError
	switch {
	case errors.Is(err, sessionsvc.ErrInvalidPRRef):
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_PR_REF", "PR reference must be a github.com PR URL or a number", nil)
	case errors.Is(err, sessionsvc.ErrPRNotFound):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PR_NOT_FOUND", "Unknown PR", nil)
	case errors.Is(err, sessionsvc.ErrPRNotOpen):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "PR_NOT_OPEN", "PR is not open", nil)
	case errors.As(err, &claimed):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "PR_CLAIMED_BY_ACTIVE_SESSION", "PR is already claimed by active session "+string(claimed.Owner)+" (omit --no-takeover to steal)", map[string]any{"ownerSessionId": string(claimed.Owner)})
	case errors.Is(err, sessionsvc.ErrSessionNotClaimable):
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "SESSION_NOT_CLAIMABLE", "Session cannot claim PRs", nil)
	case errors.Is(err, sessionsvc.ErrSessionNoWorkspace):
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "SESSION_NO_WORKSPACE", "Session has no workspace", nil)
	case errors.Is(err, sessionsvc.ErrProjectMismatch):
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "PR_PROJECT_MISMATCH", "PR does not belong to the session project", nil)
	case errors.Is(err, sessionsvc.ErrSCMUnavailable):
		envelope.WriteAPIError(w, r, http.StatusServiceUnavailable, "unavailable", "SCM_UNAVAILABLE", "SCM unavailable", nil)
	default:
		envelope.WriteError(w, r, err)
	}
}

func discoverPreviewEntry(workspacePath string) (string, bool) {
	entry, ok := previewutil.DiscoverEntry(workspacePath)
	return entry.Path, ok
}

// resolveLocalPreview maps a workspace-local path (e.g. "index.html" or
// "./dist/index.html") to its preview/files proxy URL when the path resolves to
// a regular file inside the session workspace. It returns ok=false for anything
// that already looks like a URL (an http(s)/file scheme, or a host:port dev
// server) and for paths that escape the workspace or do not point at a file, so
// the caller keeps those targets verbatim.
func resolveLocalPreview(r *http.Request, id domain.SessionID, workspacePath, raw string) (string, bool, error) {
	if raw == "" || hasURLScheme(raw) {
		return "", false, nil
	}
	entry, ok := previewutil.EntryAtPath(workspacePath, raw)
	if !ok {
		return "", false, nil
	}
	resolved, err := previewFileURL(r, id, entry.Path)
	return resolved, true, err
}

func resolvePreviewTarget(r *http.Request, id domain.SessionID, workspacePath, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if isAbsolutePreviewPath(raw) {
		return absolutePreviewFileURL(raw)
	}
	if resolved, ok, err := resolveLocalPreview(r, id, workspacePath, raw); ok || err != nil {
		return resolved, err
	}
	return raw, nil
}

func isAbsolutePreviewPath(raw string) bool {
	return filepath.IsAbs(raw) || isWindowsAbsolutePath(raw)
}

func isWindowsAbsolutePath(raw string) bool {
	return len(raw) >= 3 && ((raw[0] >= 'a' && raw[0] <= 'z') || (raw[0] >= 'A' && raw[0] <= 'Z')) && raw[1] == ':' && (raw[2] == '\\' || raw[2] == '/')
}

func absolutePreviewFileURL(raw string) (string, error) {
	file, err := filepath.Abs(raw)
	if err != nil {
		return "", errPreviewFileNotFound
	}
	info, err := os.Stat(file)
	if err != nil || info.IsDir() {
		return "", errPreviewFileNotFound
	}
	filePath := filepath.ToSlash(file)
	if filepath.VolumeName(file) != "" || isWindowsAbsolutePath(filePath) {
		filePath = "/" + filePath
	}
	return (&url.URL{Scheme: "file", Path: filePath}).String(), nil
}

func writePreviewResolveError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, errPreviewFileNotFound) {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PREVIEW_FILE_NOT_FOUND", "Preview file not found", nil)
		return
	}
	if errors.Is(err, previewutil.ErrPreviewHostUnsupported) {
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "PREVIEW_SESSION_ID_UNSUPPORTED", "Session ID is too long for an isolated preview hostname", nil)
		return
	}
	envelope.WriteError(w, r, err)
}

// hasURLScheme reports whether raw begins with an RFC-3986 "scheme:" prefix
// (http:, https:, file:, or a host:port like localhost:5173). It mirrors the
// renderer's withDefaultScheme heuristic so the daemon and browser panel agree
// on what counts as a URL versus a workspace-relative path.
func hasURLScheme(raw string) bool {
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c == ':' {
			return i > 0
		}
		isSchemeChar := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '+' || c == '.' || c == '-'
		if !isSchemeChar {
			return false
		}
	}
	return false
}

func previewFileURL(r *http.Request, id domain.SessionID, entry string) (string, error) {
	return previewutil.FileURL("http://"+r.Host, id, entry)
}

func sessionView(s domain.Session) SessionView {
	return SessionView{Session: s, Branch: s.Metadata.Branch, PreviewURL: s.Metadata.PreviewURL, PreviewRevision: s.Metadata.PreviewRevision, PRs: sessionPRFacts(s.PRs)}
}

func sessionViews(sessions []domain.Session) []SessionView {
	out := make([]SessionView, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, sessionView(s))
	}
	return out
}

func sessionPRFacts(prs []domain.PRFacts) []SessionPRFacts {
	out := make([]SessionPRFacts, 0, len(prs))
	for _, pr := range prs {
		out = append(out, SessionPRFacts{URL: pr.URL, Number: pr.Number, State: prState(pr), CI: pr.CI, Review: pr.Review, Mergeability: pr.Mergeability, ReviewComments: pr.ReviewComments, UpdatedAt: pr.UpdatedAt})
	}
	return out
}

func sessionPRSummaries(prs []sessionsvc.PRSummary) []SessionPRSummary {
	out := make([]SessionPRSummary, 0, len(prs))
	for _, pr := range prs {
		out = append(out, NewSessionPRSummary(pr))
	}
	return out
}

func workspaceFilesResponse(files sessionsvc.WorkspaceFiles) ListWorkspaceFilesResponse {
	out := make([]WorkspaceFileSummary, 0, len(files.Files))
	for _, file := range files.Files {
		out = append(out, WorkspaceFileSummary{
			Path:      file.Path,
			Status:    file.Status,
			Additions: file.Additions,
			Deletions: file.Deletions,
			Size:      file.Size,
			Binary:    file.Binary,
		})
	}
	return ListWorkspaceFilesResponse{SessionID: files.SessionID, Files: out, Truncated: files.Truncated}
}

func workspaceFileResponse(file sessionsvc.WorkspaceFileDetail) WorkspaceFileResponse {
	return WorkspaceFileResponse{
		SessionID:        file.SessionID,
		Path:             file.Path,
		Status:           file.Status,
		Additions:        file.Additions,
		Deletions:        file.Deletions,
		Size:             file.Size,
		Binary:           file.Binary,
		Deleted:          file.Deleted,
		Content:          file.Content,
		ContentTruncated: file.ContentTruncated,
		Diff:             file.Diff,
		DiffTruncated:    file.DiffTruncated,
	}
}

func prState(pr domain.PRFacts) string {
	switch {
	case pr.Merged:
		return string(domain.PRStateMerged)
	case pr.Closed:
		return string(domain.PRStateClosed)
	case pr.Draft:
		return string(domain.PRStateDraft)
	default:
		return string(domain.PRStateOpen)
	}
}

func nonNilSessionIDs(ids []domain.SessionID) []domain.SessionID {
	if ids == nil {
		return []domain.SessionID{}
	}
	return ids
}
