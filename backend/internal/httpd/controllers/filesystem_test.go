package controllers_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
)

type filesystemResponse struct {
	Path        string  `json:"path"`
	Parent      *string `json:"parent"`
	Directories []struct {
		Name string `json:"name"`
		Path string `json:"path"`
	} `json:"directories"`
}

func newFilesystemTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func filesystemPath(path string) string {
	return "/api/v1/filesystem/directories?" + url.Values{"path": {path}}.Encode()
}

func TestFilesystemAPI_ListDirectories(t *testing.T) {
	srv := newFilesystemTestServer(t)
	base := t.TempDir()
	current := filepath.Join(base, "current")
	linkedTarget := filepath.Join(base, "linked-target")
	for _, path := range []string{
		current,
		linkedTarget,
		filepath.Join(current, ".hidden"),
		filepath.Join(current, "alpha"),
		filepath.Join(current, "Beta"),
	} {
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatalf("mkdir %q: %v", path, err)
		}
	}
	if err := os.WriteFile(filepath.Join(current, "regular.txt"), []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("write regular file: %v", err)
	}
	linked := true
	if err := os.Symlink(linkedTarget, filepath.Join(current, "linked")); err != nil {
		if runtime.GOOS != "windows" {
			t.Fatalf("symlink directory: %v", err)
		}
		linked = false
	}

	body, status, headers := doRequest(t, srv, http.MethodGet, filesystemPath(current), "")
	if status != http.StatusOK {
		t.Fatalf("GET directories = %d, want 200; body=%s", status, body)
	}
	assertJSON(t, headers)

	var got filesystemResponse
	mustJSON(t, body, &got)
	if got.Path != current {
		t.Fatalf("path = %q, want %q", got.Path, current)
	}
	if got.Parent == nil || *got.Parent != base {
		t.Fatalf("parent = %v, want %q", got.Parent, base)
	}

	wantNames := []string{".hidden", "alpha", "Beta"}
	if linked {
		wantNames = append(wantNames, "linked")
	}
	gotNames := make([]string, len(got.Directories))
	for i, entry := range got.Directories {
		gotNames[i] = entry.Name
		wantPath := filepath.Join(current, entry.Name)
		if entry.Path != wantPath {
			t.Fatalf("directories[%d].path = %q, want %q", i, entry.Path, wantPath)
		}
	}
	if !reflect.DeepEqual(gotNames, wantNames) {
		t.Fatalf("directory names = %v, want %v", gotNames, wantNames)
	}
}

func TestFilesystemAPI_DefaultsToHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if err := os.Mkdir(filepath.Join(home, "code"), 0o755); err != nil {
		t.Fatalf("mkdir home child: %v", err)
	}
	srv := newFilesystemTestServer(t)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/filesystem/directories", "")
	if status != http.StatusOK {
		t.Fatalf("GET directories without path = %d, want 200; body=%s", status, body)
	}
	var got filesystemResponse
	mustJSON(t, body, &got)
	if got.Path != home {
		t.Fatalf("path = %q, want home %q", got.Path, home)
	}
	if len(got.Directories) != 1 || got.Directories[0].Name != "code" {
		t.Fatalf("directories = %#v, want code", got.Directories)
	}
}

func TestFilesystemAPI_RejectsExplicitEmptyPath(t *testing.T) {
	srv := newFilesystemTestServer(t)
	body, status, headers := doRequest(t, srv, http.MethodGet, "/api/v1/filesystem/directories?path=", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusBadRequest, "ABSOLUTE_PATH_REQUIRED")
}

func TestFilesystemAPI_AcceptsRoot(t *testing.T) {
	srv := newFilesystemTestServer(t)
	root := filepath.VolumeName(t.TempDir()) + string(filepath.Separator)
	body, status, _ := doRequest(t, srv, http.MethodGet, filesystemPath(root), "")
	if status != http.StatusOK {
		t.Fatalf("GET filesystem root = %d, want 200; body=%s", status, body)
	}
	var got filesystemResponse
	mustJSON(t, body, &got)
	if got.Path != root {
		t.Fatalf("path = %q, want filesystem root", got.Path)
	}
	if got.Parent != nil {
		t.Fatalf("parent = %q, want null", *got.Parent)
	}
	if got.Directories == nil {
		t.Fatal("directories = nil, want JSON array")
	}
}

func TestFilesystemAPI_PathErrors(t *testing.T) {
	srv := newFilesystemTestServer(t)
	regularFile := filepath.Join(t.TempDir(), "regular.txt")
	if err := os.WriteFile(regularFile, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("write regular file: %v", err)
	}

	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantCode   string
	}{
		{name: "relative", path: "relative/path", wantStatus: http.StatusBadRequest, wantCode: "ABSOLUTE_PATH_REQUIRED"},
		{name: "missing", path: filepath.Join(t.TempDir(), "missing"), wantStatus: http.StatusNotFound, wantCode: "DIRECTORY_NOT_FOUND"},
		{name: "regular file", path: regularFile, wantStatus: http.StatusUnprocessableEntity, wantCode: "NOT_A_DIRECTORY"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, status, headers := doRequest(t, srv, http.MethodGet, filesystemPath(tt.path), "")
			assertJSON(t, headers)
			assertErrorCode(t, body, status, tt.wantStatus, tt.wantCode)
			var envelope map[string]json.RawMessage
			if err := json.Unmarshal(body, &envelope); err != nil {
				t.Fatalf("decode error envelope: %v", err)
			}
			for _, field := range []string{"error", "code", "message"} {
				if _, ok := envelope[field]; !ok {
					t.Fatalf("error envelope missing %q: %s", field, body)
				}
			}
		})
	}
}
