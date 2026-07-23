package httpd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type fakePreviewSessions struct {
	workspaces map[domain.SessionID]string
}

func (f fakePreviewSessions) GetPreviewWorkspace(_ context.Context, id domain.SessionID) (string, error) {
	workspace, ok := f.workspaces[id]
	if !ok {
		return "", apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	return workspace, nil
}

func TestPreviewProxy_Validation(t *testing.T) {
	workspace := t.TempDir()
	router := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{
		PreviewSessions: fakePreviewSessions{workspaces: map[domain.SessionID]string{"ao-1": workspace}},
	}, ControlDeps{})

	t.Run("missing target is bad request without internal details", func(t *testing.T) {
		rec := previewProxyRequest(router, http.MethodGet, "ao-1", "")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
		if strings.Contains(rec.Body.String(), workspace) {
			t.Fatalf("response leaked workspace path: %q", rec.Body.String())
		}
	})

	t.Run("missing session is not found without service details", func(t *testing.T) {
		rec := previewProxyRequest(router, http.MethodGet, "missing", "file:///tmp/index.html")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
		}
		if strings.Contains(rec.Body.String(), "Unknown session") {
			t.Fatalf("response leaked service detail: %q", rec.Body.String())
		}
	})

	for _, raw := range []string{
		"ftp://127.0.0.1/",
		"http://example.com/",
		"http://192.168.1.10/",
		"http://user@localhost/",
		"http://[::1",
		"http://localhost/_ao/preview/ao-1/",
		"http://localhost/shutdown",
		"http://localhost/internal/telemetry/cli-invoked",
		"http://localhost/api/v1/mobile/status",
	} {
		t.Run(raw, func(t *testing.T) {
			rec := previewProxyRequest(router, http.MethodGet, "ao-1", raw)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
			if strings.Contains(rec.Body.String(), raw) {
				t.Fatalf("response leaked target: %q", rec.Body.String())
			}
		})
	}

	for raw, want := range map[string]string{
		"http://0.0.0.0:5173/": "http://127.0.0.1:5173/",
		"http://[::]:5173/":    "http://[::1]:5173/",
	} {
		t.Run(raw+" normalizes to loopback", func(t *testing.T) {
			target, err := parsePreviewTarget(raw)
			if err != nil {
				t.Fatal(err)
			}
			if got := target.url.String(); got != want {
				t.Fatalf("normalized target = %q, want %q", got, want)
			}
		})
	}
}

func TestPreviewProxy_ValidationRejectsWindowsFileURLOutsideWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows file URLs are valid on Windows")
	}
	if _, err := parsePreviewTarget("file:///C:/workspace/index.html"); err == nil {
		t.Fatal("Windows file URL was accepted on a non-Windows platform")
	}
}

func TestNormalizePreviewFileURLPath(t *testing.T) {
	for _, tc := range []struct {
		name string
		goos string
		raw  string
		want string
		ok   bool
	}{
		{name: "POSIX path", goos: "darwin", raw: "/workspace/index.html", want: "/workspace/index.html", ok: true},
		{name: "Windows drive URL", goos: "windows", raw: "/C:/workspace/index.html", want: `C:\workspace\index.html`, ok: true},
		{name: "POSIX rejects Windows drive URL", goos: "darwin", raw: "/C:/workspace/index.html"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := normalizePreviewFileURLPath(tc.goos, tc.raw)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("normalizePreviewFileURLPath(%q, %q) = (%q, %v), want (%q, %v)", tc.goos, tc.raw, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestIsPOSIXAbsolutePreviewFileURLPath(t *testing.T) {
	for raw, want := range map[string]bool{
		"/workspace/index.html":    true,
		"workspace/index.html":     false,
		"/C:/workspace/index.html": false,
	} {
		if got := isPOSIXAbsolutePreviewFileURLPath(raw); got != want {
			t.Fatalf("isPOSIXAbsolutePreviewFileURLPath(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestPreviewProxy_Files(t *testing.T) {
	workspace := t.TempDir()
	writePreviewFile(t, filepath.Join(workspace, "index.html"), "<h1>hello</h1>")
	writePreviewFile(t, filepath.Join(workspace, "README.md"), "# Hello")
	if err := os.Mkdir(filepath.Join(workspace, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	writePreviewFile(t, outside, "secret")
	if err := os.Symlink(outside, filepath.Join(workspace, "escape.txt")); err != nil {
		t.Fatal(err)
	}

	router := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{
		PreviewSessions: fakePreviewSessions{workspaces: map[domain.SessionID]string{"ao-1": workspace}},
	}, ControlDeps{})

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method+" serves HTML", func(t *testing.T) {
			rec := previewProxyRequest(router, method, "ao-1", previewFileTarget(filepath.Join(workspace, "index.html")))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
				t.Fatalf("Content-Type = %q, want text/html", got)
			}
			if method == http.MethodGet && rec.Body.String() != "<h1>hello</h1>" {
				t.Fatalf("body = %q", rec.Body.String())
			}
			if method == http.MethodHead && rec.Body.Len() != 0 {
				t.Fatalf("HEAD body = %q, want empty", rec.Body.String())
			}
		})
	}

	t.Run("markdown is rendered", func(t *testing.T) {
		rec := previewProxyRequest(router, http.MethodGet, "ao-1", previewFileTarget(filepath.Join(workspace, "README.md")))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
		}
		if !strings.Contains(rec.Body.String(), "<h1>Hello</h1>") {
			t.Fatalf("markdown response = %q, want rendered heading", rec.Body.String())
		}
	})

	for _, raw := range []string{
		previewFileTarget(filepath.Join(workspace, "missing.html")),
		previewFileTarget(filepath.Join(workspace, "assets")),
		previewFileTarget(outside),
		previewFileTarget(filepath.Join(workspace, "escape.txt")),
	} {
		t.Run(raw+" is not served", func(t *testing.T) {
			rec := previewProxyRequest(router, http.MethodGet, "ao-1", raw)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
			}
			if strings.Contains(rec.Body.String(), "secret") || strings.Contains(rec.Body.String(), workspace) {
				t.Fatalf("response leaked file detail: %q", rec.Body.String())
			}
		})
	}

	rec := previewProxyRequest(router, http.MethodPost, "ao-1", previewFileTarget(filepath.Join(workspace, "index.html")))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestPreviewProxy_FilesResolveRequestPathRelativeToEntry(t *testing.T) {
	workspace := t.TempDir()
	entry := filepath.Join(workspace, "dist", "index.html")
	writePreviewFile(t, entry, "entry")
	writePreviewFile(t, filepath.Join(workspace, "dist", "assets", "app.css"), "asset")
	outside := filepath.Join(t.TempDir(), "secret.css")
	writePreviewFile(t, outside, "secret")
	if err := os.Symlink(outside, filepath.Join(workspace, "dist", "assets", "escape.css")); err != nil {
		t.Fatal(err)
	}

	router := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{
		PreviewSessions: fakePreviewSessions{workspaces: map[domain.SessionID]string{"ao-1": workspace}},
	}, ControlDeps{})

	for _, tc := range []struct {
		name        string
		requestPath string
		wantStatus  int
		wantBody    string
	}{
		{name: "entry path", requestPath: "/index.html", wantStatus: http.StatusOK, wantBody: "entry"},
		{name: "asset path", requestPath: "/assets/app.css", wantStatus: http.StatusOK, wantBody: "asset"},
		{name: "asset symlink escape", requestPath: "/assets/escape.css", wantStatus: http.StatusNotFound},
		{name: "parent traversal escape", requestPath: "/../../secret.css", wantStatus: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := previewProxyRequestPath(router, http.MethodGet, "ao-1", previewFileTarget(entry), tc.requestPath)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Fatalf("body = %q, want %q", rec.Body.String(), tc.wantBody)
			}
			if strings.Contains(rec.Body.String(), "secret") {
				t.Fatalf("response leaked escaped asset: %q", rec.Body.String())
			}
		})
	}
}

func previewProxyRequest(router http.Handler, method, sessionID, target string) *httptest.ResponseRecorder {
	return previewProxyRequestPath(router, method, sessionID, target, "/")
}

func previewProxyRequestPath(router http.Handler, method, sessionID, target, requestPath string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/_ao/preview/"+sessionID+requestPath, nil)
	if target != "" {
		req.Header.Set("X-AO-Preview-Target", target)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func previewFileTarget(file string) string {
	return (&url.URL{Scheme: "file", Path: file}).String()
}

func writePreviewFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
