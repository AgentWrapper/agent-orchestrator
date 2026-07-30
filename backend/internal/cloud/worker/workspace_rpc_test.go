package worker

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceInspectorListsReadsAndDiffsRepository(t *testing.T) {
	workspace := t.TempDir()
	runWorkspaceTestCommand(t, workspace, "git", "init", "-q")
	runWorkspaceTestCommand(t, workspace, "git", "config", "user.email", "test@example.com")
	runWorkspaceTestCommand(t, workspace, "git", "config", "user.name", "AO Test")
	if err := os.WriteFile(filepath.Join(workspace, "README.md"), []byte("# AO\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runWorkspaceTestCommand(t, workspace, "git", "add", "README.md")
	runWorkspaceTestCommand(t, workspace, "git", "commit", "-qm", "initial")
	if err := os.WriteFile(filepath.Join(workspace, "README.md"), []byte("# AO Cloud\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	runner := &Runner{workspaceDir: workspace}
	listed, err := runner.listWorkspace("")
	if err != nil {
		t.Fatal(err)
	}
	entries, ok := listed["entries"].([]workspaceEntry)
	if !ok || len(entries) == 0 {
		t.Fatalf("workspace entries = %#v", listed["entries"])
	}
	opened, err := runner.readWorkspaceFile("README.md")
	if err != nil {
		t.Fatal(err)
	}
	if opened["content"] != "# AO Cloud\n" {
		t.Fatalf("file content = %#v", opened["content"])
	}
	diff, err := runner.workspaceDiff(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff["unstaged"].(string), "+# AO Cloud") {
		t.Fatalf("workspace diff = %#v", diff)
	}
}

func TestWorkspaceInspectorRejectsSymlinkEscape(t *testing.T) {
	workspace := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "outside")); err != nil {
		t.Fatal(err)
	}
	runner := &Runner{workspaceDir: workspace}
	if _, err := runner.readWorkspaceFile("outside"); err == nil ||
		!strings.Contains(err.Error(), "escapes") {
		t.Fatalf("read symlink error = %v", err)
	}
}

func TestWorkspacePreviewOnlyReachesRequestedLocalhostPort(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<h1>AO preview</h1>"))
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port

	runner := &Runner{workspaceDir: t.TempDir()}
	response, err := runner.previewLocalhost(context.Background(), workspaceRequest{
		Port: port,
		Path: "/",
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := response["body"].(string)
	body, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "<h1>AO preview</h1>" {
		t.Fatalf("preview body = %q", body)
	}
	if _, err := runner.previewLocalhost(context.Background(), workspaceRequest{
		Port: 80,
		Path: "/",
	}); err == nil {
		t.Fatal("privileged preview port was accepted")
	}
}

func TestWorkspaceFilePreviewServesRepositoryAssets(t *testing.T) {
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "site"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(workspace, "site", "index.html"),
		[]byte(`<img src="logo.png"><h1>AO preview</h1>`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	runner := &Runner{workspaceDir: workspace}
	response, err := runner.previewWorkspaceFile(workspaceRequest{
		Path:   "site/index.html",
		Method: http.MethodGet,
	})
	if err != nil {
		t.Fatal(err)
	}
	if contentType, _ := response["contentType"].(string); !strings.Contains(contentType, "text/html") {
		t.Fatalf("content type = %q", contentType)
	}
	encoded, _ := response["body"].(string)
	body, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `<img src="logo.png"><h1>AO preview</h1>` {
		t.Fatalf("preview body = %q", body)
	}
	if _, err := runner.previewWorkspaceFile(workspaceRequest{
		Path: "../outside.html",
	}); err == nil {
		t.Fatal("workspace file preview accepted a path escape")
	}
}

func runWorkspaceTestCommand(t *testing.T, dir, name string, args ...string) {
	t.Helper()
	command := exec.Command(name, args...)
	command.Dir = dir
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("%s failed: %v: %s", name, err, output)
	}
}
