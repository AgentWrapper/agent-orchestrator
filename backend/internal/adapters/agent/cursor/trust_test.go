package cursor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestCursorSlugifyPathMatchesCursorAgent(t *testing.T) {
	// Slugs verified against real cursor-agent project-storage dirs: runs of
	// non-alphanumeric characters collapse to a single "-", leading/trailing
	// dashes are trimmed, and case is preserved (no lowercasing).
	cases := map[string]string{
		"/Users/biley/.ao/data/worktrees/agent-orchestrator/agent-orchestrator-2": "Users-biley-ao-data-worktrees-agent-orchestrator-agent-orchestrator-2",
		"/Users/biley/work/projects/agent-orchestrator/frontend":                  "Users-biley-work-projects-agent-orchestrator-frontend",
		"/Users/biley/work/bbsource":                                              "Users-biley-work-bbsource",
	}
	for path, want := range cases {
		if got := cursorSlugifyPath(path); got != want {
			t.Errorf("cursorSlugifyPath(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestEnsureWorkspaceTrustedWritesMarker(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	workspace := "/Users/example/.ao/data/worktrees/repo/agent-abc123"
	if err := ensureWorkspaceTrusted(workspace); err != nil {
		t.Fatalf("ensureWorkspaceTrusted: %v", err)
	}

	markerPath := filepath.Join(cursorProjectStorageDir(workspace), cursorTrustMarkerName)
	data, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatalf("read marker: %v", err)
	}
	var marker struct {
		TrustedAt     string `json:"trustedAt"`
		WorkspacePath string `json:"workspacePath"`
		TrustMethod   string `json:"trustMethod"`
	}
	if err := json.Unmarshal(data, &marker); err != nil {
		t.Fatalf("marker is not valid JSON: %v (%s)", err, data)
	}
	if marker.WorkspacePath != workspace {
		t.Errorf("workspacePath = %q, want %q", marker.WorkspacePath, workspace)
	}
	if marker.TrustedAt == "" {
		t.Error("trustedAt is empty")
	}
	if marker.TrustMethod == "" {
		t.Error("trustMethod is empty")
	}
}

func TestEnsureWorkspaceTrustedIsIdempotent(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	workspace := "/Users/example/repo"
	markerPath := filepath.Join(cursorProjectStorageDir(workspace), cursorTrustMarkerName)

	// Pre-seed a marker with distinctive content; a second call must not clobber
	// it (cursor-agent only checks existence, so re-writing would be churn).
	if err := os.MkdirAll(filepath.Dir(markerPath), 0o750); err != nil {
		t.Fatal(err)
	}
	sentinel := []byte(`{"trustedAt":"preexisting"}`)
	if err := os.WriteFile(markerPath, sentinel, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ensureWorkspaceTrusted(workspace); err != nil {
		t.Fatalf("ensureWorkspaceTrusted: %v", err)
	}

	got, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(sentinel) {
		t.Errorf("existing marker was overwritten: got %s", got)
	}
}

func TestEnsureWorkspaceTrustedEmptyPathIsNoop(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	if err := ensureWorkspaceTrusted("   "); err != nil {
		t.Fatalf("ensureWorkspaceTrusted(blank) = %v, want nil", err)
	}
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("blank workspace path created files: %#v", entries)
	}
}

func TestEnsureWorkspaceTrustedSeedsSymlinkResolvedPath(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	// A real workspace dir plus a symlink pointing at it. cursor-agent derives
	// trust from its resolved cwd, so the resolved target must be seeded even
	// when AO launches with the symlink path.
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "workspace-link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	if err := ensureWorkspaceTrusted(link); err != nil {
		t.Fatalf("ensureWorkspaceTrusted: %v", err)
	}

	resolved, err := filepath.EvalSymlinks(link)
	if err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(cursorProjectStorageDir(resolved), cursorTrustMarkerName)
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("resolved-path marker missing: %v", err)
	}
}

func TestGetLaunchCommandSeedsWorkspaceTrust(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	plugin := &Plugin{resolvedBinary: "cursor-agent"}
	workspace := "/Users/example/.ao/data/worktrees/repo/agent-launch"

	if _, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:   ports.PermissionModeBypassPermissions,
		Prompt:        "do the thing",
		WorkspacePath: workspace,
	}); err != nil {
		t.Fatal(err)
	}

	markerPath := filepath.Join(cursorProjectStorageDir(workspace), cursorTrustMarkerName)
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("GetLaunchCommand did not seed trust marker: %v", err)
	}
}

func TestGetRestoreCommandSeedsWorkspaceTrust(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	plugin := &Plugin{resolvedBinary: "cursor-agent"}
	workspace := "/Users/example/.ao/data/worktrees/repo/agent-restore"

	if _, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Permissions: ports.PermissionModeAuto,
		Session: ports.SessionRef{
			WorkspacePath: workspace,
			Metadata:      map[string]string{ports.MetadataKeyAgentSessionID: "chat-1"},
		},
	}); err != nil || !ok {
		t.Fatalf("GetRestoreCommand = (ok=%v, err=%v)", ok, err)
	}

	markerPath := filepath.Join(cursorProjectStorageDir(workspace), cursorTrustMarkerName)
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("GetRestoreCommand did not seed trust marker: %v", err)
	}
}
