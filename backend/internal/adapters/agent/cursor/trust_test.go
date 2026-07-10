package cursor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
	if err := ensureWorkspaceTrusted(context.Background(), workspace, nil); err != nil {
		t.Fatalf("ensureWorkspaceTrusted: %v", err)
	}

	markerPath := filepath.Join(cursorProjectStorageDir(workspace, nil), cursorTrustMarkerName)
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
	markerPath := filepath.Join(cursorProjectStorageDir(workspace, nil), cursorTrustMarkerName)

	// Pre-seed a marker with distinctive content; a second call must not clobber
	// it (cursor-agent only checks existence, so re-writing would be churn).
	if err := os.MkdirAll(filepath.Dir(markerPath), 0o750); err != nil {
		t.Fatal(err)
	}
	sentinel := []byte(`{"trustedAt":"preexisting"}`)
	if err := os.WriteFile(markerPath, sentinel, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ensureWorkspaceTrusted(context.Background(), workspace, nil); err != nil {
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

func TestEnsureWorkspaceTrustedEnvOverrideWinsOverDaemonEnv(t *testing.T) {
	// A project-level env.CURSOR_DATA_DIR override is exported over the daemon's
	// environment for the spawned cursor-agent, so the trust marker must be
	// written under the override — not the daemon's CURSOR_DATA_DIR — or the
	// child still prompts (the exact gap flagged in PR review).
	daemonDir := t.TempDir()
	overrideDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", daemonDir)

	workspace := "/Users/example/.ao/data/worktrees/repo/agent-env-override"
	env := map[string]string{"CURSOR_DATA_DIR": overrideDir}
	if err := ensureWorkspaceTrusted(context.Background(), workspace, env); err != nil {
		t.Fatalf("ensureWorkspaceTrusted: %v", err)
	}

	overrideMarker := filepath.Join(cursorProjectStorageDir(workspace, env), cursorTrustMarkerName)
	if !strings.HasPrefix(overrideMarker, overrideDir+string(os.PathSeparator)) {
		t.Fatalf("marker path %q not under env override dir %q", overrideMarker, overrideDir)
	}
	if _, err := os.Stat(overrideMarker); err != nil {
		t.Fatalf("marker missing under env override dir: %v", err)
	}
	daemonEntries, err := os.ReadDir(daemonDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(daemonEntries) != 0 {
		t.Fatalf("marker leaked into daemon CURSOR_DATA_DIR: %#v", daemonEntries)
	}
}

func TestEnsureWorkspaceTrustedEmptyPathIsNoop(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	if err := ensureWorkspaceTrusted(context.Background(), "   ", nil); err != nil {
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

	if err := ensureWorkspaceTrusted(context.Background(), link, nil); err != nil {
		t.Fatalf("ensureWorkspaceTrusted: %v", err)
	}

	resolved, err := filepath.EvalSymlinks(link)
	if err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(cursorProjectStorageDir(resolved, nil), cursorTrustMarkerName)
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

	markerPath := filepath.Join(cursorProjectStorageDir(workspace, nil), cursorTrustMarkerName)
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("GetLaunchCommand did not seed trust marker: %v", err)
	}
}

func TestGetLaunchCommandSeedsTrustUnderEnvOverride(t *testing.T) {
	daemonDir := t.TempDir()
	overrideDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", daemonDir)

	plugin := &Plugin{resolvedBinary: "cursor-agent"}
	workspace := "/Users/example/.ao/data/worktrees/repo/agent-launch-env"
	env := map[string]string{"CURSOR_DATA_DIR": overrideDir}

	if _, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:   ports.PermissionModeBypassPermissions,
		Prompt:        "do the thing",
		WorkspacePath: workspace,
		Env:           env,
	}); err != nil {
		t.Fatal(err)
	}

	markerPath := filepath.Join(cursorProjectStorageDir(workspace, env), cursorTrustMarkerName)
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("GetLaunchCommand did not seed trust marker under env override: %v", err)
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

	markerPath := filepath.Join(cursorProjectStorageDir(workspace, nil), cursorTrustMarkerName)
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("GetRestoreCommand did not seed trust marker: %v", err)
	}
}

func TestGetRestoreCommandSeedsTrustUnderEnvOverride(t *testing.T) {
	daemonDir := t.TempDir()
	overrideDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", daemonDir)

	plugin := &Plugin{resolvedBinary: "cursor-agent"}
	workspace := "/Users/example/.ao/data/worktrees/repo/agent-restore-env"
	env := map[string]string{"CURSOR_DATA_DIR": overrideDir}

	if _, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Permissions: ports.PermissionModeAuto,
		Env:         env,
		Session: ports.SessionRef{
			WorkspacePath: workspace,
			Metadata:      map[string]string{ports.MetadataKeyAgentSessionID: "chat-2"},
		},
	}); err != nil || !ok {
		t.Fatalf("GetRestoreCommand = (ok=%v, err=%v)", ok, err)
	}

	markerPath := filepath.Join(cursorProjectStorageDir(workspace, env), cursorTrustMarkerName)
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("GetRestoreCommand did not seed trust marker under env override: %v", err)
	}
}

func TestCursorProjectStorageDirHonorsEnvHomeOverride(t *testing.T) {
	daemonHome := t.TempDir()
	childHome := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", "")
	t.Setenv("HOME", daemonHome)

	workspace := "/Users/example/.ao/data/worktrees/repo/agent-home-override"
	env := map[string]string{"HOME": childHome}

	dir := cursorProjectStorageDir(workspace, env)
	want := filepath.Join(childHome, ".cursor", "projects", cursorSlugifyPath(workspace))
	if dir != want {
		t.Fatalf("cursorProjectStorageDir = %q, want %q (env HOME override must win over the daemon's home)", dir, want)
	}
}

func TestCursorProjectStorageDirResolvesRelativeBaseAgainstWorkspace(t *testing.T) {
	// The spawned cursor-agent resolves a relative CURSOR_DATA_DIR against its
	// own cwd — the workspace — so the marker must land there, not relative to
	// the daemon's cwd.
	workspace := t.TempDir()
	env := map[string]string{"CURSOR_DATA_DIR": ".cursor-data"}

	dir := cursorProjectStorageDir(workspace, env)
	want := filepath.Join(workspace, ".cursor-data", "projects", cursorSlugifyPath(workspace))
	if dir != want {
		t.Fatalf("cursorProjectStorageDir = %q, want %q (relative base must resolve against the workspace)", dir, want)
	}
}

func TestCleanupWorkspaceStateRemovesAOManagedMarker(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	plugin := &Plugin{}
	workspace := "/Users/example/.ao/data/worktrees/repo/agent-cleanup"
	if err := ensureWorkspaceTrusted(context.Background(), workspace, nil); err != nil {
		t.Fatalf("ensureWorkspaceTrusted: %v", err)
	}
	markerPath := filepath.Join(cursorProjectStorageDir(workspace, nil), cursorTrustMarkerName)
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("marker not seeded: %v", err)
	}

	if err := plugin.CleanupWorkspaceState(context.Background(), workspace, nil); err != nil {
		t.Fatalf("CleanupWorkspaceState: %v", err)
	}
	if _, err := os.Stat(markerPath); !os.IsNotExist(err) {
		t.Fatalf("AO-managed marker still present after cleanup: %v", err)
	}
}

func TestCleanupWorkspaceStatePreservesUserTrustDecision(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	plugin := &Plugin{}
	workspace := "/Users/example/repo-user-trusted"
	markerPath := filepath.Join(cursorProjectStorageDir(workspace, nil), cursorTrustMarkerName)
	if err := os.MkdirAll(filepath.Dir(markerPath), 0o750); err != nil {
		t.Fatal(err)
	}
	// A marker cursor-agent wrote after the user answered its prompt (no
	// ao-managed trustMethod) records a real user decision.
	native := []byte(`{"trustedAt":"2026-01-01T00:00:00Z","workspacePath":"/Users/example/repo-user-trusted"}`)
	if err := os.WriteFile(markerPath, native, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := plugin.CleanupWorkspaceState(context.Background(), workspace, nil); err != nil {
		t.Fatalf("CleanupWorkspaceState: %v", err)
	}
	got, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatalf("user trust marker was removed: %v", err)
	}
	if string(got) != string(native) {
		t.Fatalf("user trust marker was modified: %s", got)
	}
}

func TestCleanupWorkspaceStateMissingMarkerIsNoop(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("CURSOR_DATA_DIR", dataDir)

	plugin := &Plugin{}
	if err := plugin.CleanupWorkspaceState(context.Background(), "/Users/example/never-seeded", nil); err != nil {
		t.Fatalf("CleanupWorkspaceState on unseeded workspace: %v", err)
	}
}
