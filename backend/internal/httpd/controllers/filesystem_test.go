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

func createDirectoryBody(parentPath, name string) string {
	body, _ := json.Marshal(map[string]string{"parentPath": parentPath, "name": name})
	return string(body)
}

func TestFilesystemAPI_CreateDirectory(t *testing.T) {
	srv := newFilesystemTestServer(t)
	parent := t.TempDir()
	body, status, headers := doRequest(t, srv, http.MethodPost,
		"/api/v1/filesystem/directories", createDirectoryBody(parent, "new-project"))
	assertJSON(t, headers)
	if status != http.StatusCreated {
		t.Fatalf("POST directory = %d, want 201; body=%s", status, body)
	}
	var got struct{ Name, Path string }
	mustJSON(t, body, &got)
	want := filepath.Join(parent, "new-project")
	if got.Name != "new-project" || got.Path != want {
		t.Fatalf("response = %#v, want path %q", got, want)
	}
	info, err := os.Stat(want)
	if err != nil || !info.IsDir() {
		t.Fatalf("created directory stat = (%v, %v)", info, err)
	}
}

func TestFilesystemAPI_CreateDirectoryValidation(t *testing.T) {
	srv := newFilesystemTestServer(t)
	parent := t.TempDir()

	existingFileParent := t.TempDir()
	if err := os.WriteFile(filepath.Join(existingFileParent, "existing"), []byte("file"), 0o644); err != nil {
		t.Fatalf("write existing file: %v", err)
	}
	existingDirectoryParent := t.TempDir()
	if err := os.Mkdir(filepath.Join(existingDirectoryParent, "existing"), 0o755); err != nil {
		t.Fatalf("mkdir existing directory: %v", err)
	}
	missingParent := filepath.Join(t.TempDir(), "missing")
	fileParent := filepath.Join(t.TempDir(), "parent-file")
	if err := os.WriteFile(fileParent, []byte("file"), 0o644); err != nil {
		t.Fatalf("write parent file: %v", err)
	}
	unknownBody, err := json.Marshal(map[string]any{
		"parentPath": parent,
		"name":       "unknown-field",
		"unknown":    true,
	})
	if err != nil {
		t.Fatalf("marshal unknown-field body: %v", err)
	}

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "hidden", body: createDirectoryBody(parent, ".hidden"), wantStatus: http.StatusCreated},
		{name: "invalid JSON", body: "{", wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON"},
		{name: "unknown JSON field", body: string(unknownBody), wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON"},
		{name: "trailing JSON", body: createDirectoryBody(parent, "trailing") + " {}", wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON"},
		{name: "relative parent", body: createDirectoryBody("relative/path", "child"), wantStatus: http.StatusBadRequest, wantCode: "ABSOLUTE_PATH_REQUIRED"},
		{name: "blank parent", body: createDirectoryBody("", "child"), wantStatus: http.StatusBadRequest, wantCode: "ABSOLUTE_PATH_REQUIRED"},
		{name: "blank name", body: createDirectoryBody(parent, ""), wantStatus: http.StatusBadRequest, wantCode: "INVALID_DIRECTORY_NAME"},
		{name: "whitespace name", body: createDirectoryBody(parent, " "), wantStatus: http.StatusBadRequest, wantCode: "INVALID_DIRECTORY_NAME"},
		{name: "dot name", body: createDirectoryBody(parent, "."), wantStatus: http.StatusBadRequest, wantCode: "INVALID_DIRECTORY_NAME"},
		{name: "dot dot name", body: createDirectoryBody(parent, ".."), wantStatus: http.StatusBadRequest, wantCode: "INVALID_DIRECTORY_NAME"},
		{name: "slash name", body: createDirectoryBody(parent, "nested/name"), wantStatus: http.StatusBadRequest, wantCode: "INVALID_DIRECTORY_NAME"},
		{name: "backslash name", body: createDirectoryBody(parent, `nested\name`), wantStatus: http.StatusBadRequest, wantCode: "INVALID_DIRECTORY_NAME"},
		{name: "NUL name", body: createDirectoryBody(parent, "nul\x00name"), wantStatus: http.StatusBadRequest, wantCode: "INVALID_DIRECTORY_NAME"},
		{name: "existing file", body: createDirectoryBody(existingFileParent, "existing"), wantStatus: http.StatusConflict, wantCode: "DIRECTORY_ALREADY_EXISTS"},
		{name: "existing directory", body: createDirectoryBody(existingDirectoryParent, "existing"), wantStatus: http.StatusConflict, wantCode: "DIRECTORY_ALREADY_EXISTS"},
		{name: "missing parent", body: createDirectoryBody(missingParent, "child"), wantStatus: http.StatusNotFound, wantCode: "DIRECTORY_NOT_FOUND"},
		{name: "file parent", body: createDirectoryBody(fileParent, "child"), wantStatus: http.StatusUnprocessableEntity, wantCode: "NOT_A_DIRECTORY"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, status, headers := doRequest(t, srv, http.MethodPost, "/api/v1/filesystem/directories", tt.body)
			assertJSON(t, headers)
			if tt.wantStatus == http.StatusCreated {
				if status != tt.wantStatus {
					t.Fatalf("POST directory = %d, want %d; body=%s", status, tt.wantStatus, body)
				}
				var got struct{ Name, Path string }
				mustJSON(t, body, &got)
				if got.Name != ".hidden" || got.Path != filepath.Join(parent, ".hidden") {
					t.Fatalf("response = %#v, want hidden directory under %q", got, parent)
				}
				info, err := os.Stat(got.Path)
				if err != nil || !info.IsDir() {
					t.Fatalf("created hidden directory stat = (%v, %v)", info, err)
				}
				return
			}
			assertErrorCode(t, body, status, tt.wantStatus, tt.wantCode)
		})
	}
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
