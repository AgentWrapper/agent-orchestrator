package controllers_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// #293 H2: the preview/files route must confine reads to the session workspace
// AFTER symlink resolution. A workspace-local symlink pointing at a host file
// the daemon can read (credentials, /etc/passwd, ...) must not be served.

const outsideSentinel = "OUTSIDE-THE-WORKSPACE-SECRET"

// previewSymlinkWorkspace builds a workspace whose entries escape it:
// secret.html -> ../outside/secret.html, notes.md -> ../outside/notes.md and
// a symlinked directory link/ -> ../outside.
func previewSymlinkWorkspace(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	outside := filepath.Join(root, "outside")
	for _, dir := range []string{workspace, outside} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.html"), []byte(outsideSentinel), 0o600); err != nil {
		t.Fatalf("write outside html: %v", err)
	}
	if err := os.WriteFile(filepath.Join(outside, "notes.md"), []byte("# "+outsideSentinel), 0o600); err != nil {
		t.Fatalf("write outside md: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.html"), filepath.Join(workspace, "secret.html")); err != nil {
		t.Fatalf("symlink html: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "notes.md"), filepath.Join(workspace, "notes.md")); err != nil {
		t.Fatalf("symlink md: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "link")); err != nil {
		t.Fatalf("symlink dir: %v", err)
	}
	// A legitimate workspace-local file, to prove confinement did not break the
	// happy path.
	if err := os.WriteFile(filepath.Join(workspace, "index.html"), []byte("<p>inside</p>"), 0o600); err != nil {
		t.Fatalf("write index: %v", err)
	}
	return workspace
}

func TestSessionsAPI_PreviewFileRejectsOutwardSymlink(t *testing.T) {
	svc := newFakeSessionService()
	workspace := previewSymlinkWorkspace(t)
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{WorkspacePath: workspace}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	for _, target := range []string{
		"secret.html",            // file symlink out of the workspace
		"notes.md",               // markdown render path
		"link/secret.html",       // through a symlinked directory
		"../outside/secret.html", // lexical escape (already rejected; kept as a guard)
	} {
		body, status, _ := doRequest(t, srv, "GET", "/api/v1/sessions/ao-1/preview/files/"+target, "")
		if status != http.StatusNotFound {
			t.Fatalf("preview file %q = %d, want 404; body=%s", target, status, body)
		}
		if strings.Contains(string(body), outsideSentinel) {
			t.Fatalf("preview file %q leaked an outside file: %s", target, body)
		}
	}

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/sessions/ao-1/preview/files/index.html", "")
	if status != http.StatusOK || !strings.Contains(string(body), "inside") {
		t.Fatalf("workspace-local preview = %d (%s), want 200 with the file body", status, body)
	}
}

// TestSessionsAPI_SetPreviewRejectsOutwardSymlink covers the sibling surface:
// `ao preview <path>` must not resolve a workspace-local symlink to an outside
// file and hand back a preview/files URL for it.
func TestSessionsAPI_SetPreviewRejectsOutwardSymlink(t *testing.T) {
	svc := newFakeSessionService()
	workspace := previewSymlinkWorkspace(t)
	s := svc.sessions["ao-1"]
	s.Metadata = domain.SessionMetadata{WorkspacePath: workspace}
	svc.sessions["ao-1"] = s
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/preview", `{"url":"secret.html"}`)
	if status != http.StatusOK {
		t.Fatalf("set preview = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Session struct {
			PreviewURL string `json:"previewUrl"`
		} `json:"session"`
	}
	mustJSON(t, body, &resp)
	// An escaping target is never proxied through preview/files; it is kept
	// verbatim (and the files route refuses it).
	if strings.Contains(resp.Session.PreviewURL, "/preview/files/") {
		t.Fatalf("set preview proxied an outward symlink: %q", resp.Session.PreviewURL)
	}
}
