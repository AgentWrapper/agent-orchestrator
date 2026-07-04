package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// previewCapture records the request body and path the CLI hit, plus whether
// the daemon was contacted at all.
type previewCapture struct {
	body   string
	path   string
	method string
	called bool
}

// previewServer wires an httptest server expecting POST or DELETE on
// /api/v1/sessions/{id}/preview and captures what the CLI sent.
func previewServer(t *testing.T, status int, respBody string) (*httptest.Server, *previewCapture) {
	t.Helper()
	capture := &previewCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodDelete {
			http.NotFound(w, r)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/v1/sessions/") || !strings.HasSuffix(r.URL.Path, "/preview") {
			http.NotFound(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		capture.called = true
		capture.body = string(body)
		capture.path = r.URL.Path
		capture.method = r.Method
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func TestPreview_WithURLArg(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "aa-47")
	cfg := setConfigEnv(t)
	srv, capture := previewServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "preview", "http://localhost:5173")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/sessions/aa-47/preview" {
		t.Errorf("path = %q, want /api/v1/sessions/aa-47/preview", capture.path)
	}
	var req struct {
		Url string `json:"url"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	if req.Url != "http://localhost:5173" {
		t.Errorf("captured url = %q, want %q", req.Url, "http://localhost:5173")
	}
}

func TestPreview_NoArgPostsEmptyURL(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "aa-47")
	cfg := setConfigEnv(t)
	srv, capture := previewServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "preview")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.body != `{"url":""}` {
		t.Errorf("captured body = %q, want %q", capture.body, `{"url":""}`)
	}
}

func TestPreview_RelativePathResolvedToAbsolute(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "bb-12")
	cfg := setConfigEnv(t)
	srv, capture := previewServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	tmpDir := t.TempDir()
	tmpFile := filepath.Join(tmpDir, "test.md")
	if err := os.WriteFile(tmpFile, []byte("# hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	origDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tmpDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(origDir) })

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "preview", "test.md")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var req struct {
		Url string `json:"url"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	// Normalize via EvalSymlinks so the test passes on macOS where /var
	// is a symlink to /private/var (filepath.Abs resolves through Chdir
	// and the kernel tracks the real path).
	want := tmpFile
	if resolved, err := filepath.EvalSymlinks(tmpFile); err == nil {
		want = resolved
	}
	if req.Url != want {
		t.Errorf("captured url = %q, want %q", req.Url, want)
	}
}

func TestPreview_RelativePathNonExistentPassedThrough(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "cc-34")
	cfg := setConfigEnv(t)
	srv, capture := previewServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "preview", "nonexistent.md")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var req struct {
		Url string `json:"url"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	// Should pass through verbatim when the file doesn't exist.
	if req.Url != "nonexistent.md" {
		t.Errorf("captured url = %q, want %q", req.Url, "nonexistent.md")
	}
}

func TestPreviewClear_DeletesSessionPreview(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "aa-47")
	cfg := setConfigEnv(t)
	srv, capture := previewServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "preview", "clear")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", capture.method)
	}
	if capture.path != "/api/v1/sessions/aa-47/preview" {
		t.Errorf("path = %q, want /api/v1/sessions/aa-47/preview", capture.path)
	}
}

func TestPreviewClear_MissingSessionIDIsUsageError(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "")
	cfg := setConfigEnv(t)
	srv, capture := previewServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "preview", "clear")
	if err == nil {
		t.Fatal("expected usage error when AO_SESSION_ID is unset")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2", got)
	}
	if capture.called {
		t.Fatal("daemon should not be contacted when AO_SESSION_ID is unset")
	}
}

func TestPreview_MissingSessionIDIsUsageError(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "")
	cfg := setConfigEnv(t)
	srv, capture := previewServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "preview", "http://localhost:5173")
	if err == nil {
		t.Fatal("expected usage error when AO_SESSION_ID is unset")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2", got)
	}
	if !strings.Contains(err.Error(), "AO_SESSION_ID is not set") {
		t.Fatalf("error missing usage message: %v", err)
	}
	if capture.called {
		t.Fatal("daemon should not be contacted when AO_SESSION_ID is unset")
	}
}

func TestPreview_HelpIncludesExamples(t *testing.T) {
	out, _, err := executeCLI(t, Deps{}, "preview", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Examples section present.
	if !strings.Contains(out, "EXAMPLES") && !strings.Contains(out, "Examples") {
		t.Errorf("help output missing Examples section:\n%s", out)
	}
	// Relative path example present.
	if !strings.Contains(out, "README.md") {
		t.Errorf("help output missing README.md example:\n%s", out)
	}
}

func TestPreview_BlankSessionIDIsUsageError(t *testing.T) {
	t.Setenv("AO_SESSION_ID", " \t ")
	cfg := setConfigEnv(t)
	srv, capture := previewServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "preview")
	if err == nil {
		t.Fatal("expected usage error when AO_SESSION_ID is blank")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2", got)
	}
	if capture.called {
		t.Fatal("daemon should not be contacted when AO_SESSION_ID is blank")
	}
}
