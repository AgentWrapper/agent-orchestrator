package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/aobackup"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

func writeMinimalState(t *testing.T, stateDir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(stateDir, "data", "worktrees", "demo"), 0o750); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"app-state.json":                       `{"schemaVersion":2,"appPath":"/Apps/AO"}`,
		"ui-settings.json":                     `{"locale":"en"}`,
		"update-settings.json":                 `{"channel":"stable"}`,
		filepath.Join("data", "ao.db"):         "db",
		filepath.Join("data", "ao.db-wal"):     "wal",
		filepath.Join("data", "skills", "x.md"): "skill",
		// pid 0 is never "live" per runfile.CheckStale; this file only exists
		// so create's exclude list can observe it.
		"running.json": `{"pid":0,"port":3001}`,
		"windows-pty-hosts.json":               `[]`,
		filepath.Join("electron", "Cache", "c"): "cache",
	}
	for rel, body := range files {
		path := filepath.Join(stateDir, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// backupConfigEnv points AO_RUN_FILE / AO_DATA_DIR at a full ~/.ao-shaped tree
// so backup uses dirname(runFile) as the state root (matching production).
func backupConfigEnv(t *testing.T) (stateDir string) {
	t.Helper()
	stateDir = t.TempDir()
	t.Setenv("AO_RUN_FILE", filepath.Join(stateDir, "running.json"))
	t.Setenv("AO_DATA_DIR", filepath.Join(stateDir, "data"))
	t.Setenv("AO_PORT", "3001")
	t.Setenv("AO_REQUEST_TIMEOUT", "")
	t.Setenv("AO_SHUTDOWN_TIMEOUT", "")
	return stateDir
}

func TestBackupCreateRestore_HappyPath(t *testing.T) {
	stateDir := backupConfigEnv(t)
	writeMinimalState(t, stateDir)

	archive := filepath.Join(t.TempDir(), "roundtrip.zip")
	out, _, err := executeCLI(t, Deps{}, "backup", "create", archive)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !strings.Contains(out, "Backup written") {
		t.Fatalf("create out = %q", out)
	}

	// Wipe durable state; leave an ephemeral file that must survive restore.
	_ = os.Remove(filepath.Join(stateDir, "app-state.json"))
	_ = os.RemoveAll(filepath.Join(stateDir, "data"))
	if err := os.WriteFile(filepath.Join(stateDir, "running.json"), []byte(`{"pid":42}`), 0o600); err != nil {
		t.Fatal(err)
	}

	out, _, err = executeCLI(t, Deps{}, "backup", "restore", archive, "--yes")
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if !strings.Contains(out, "Restore complete") {
		t.Fatalf("restore out = %q", out)
	}

	body, err := os.ReadFile(filepath.Join(stateDir, "app-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "schemaVersion") {
		t.Fatalf("app-state.json not restored: %s", body)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "data", "ao.db")); err != nil {
		t.Fatalf("data/ao.db missing after restore: %v", err)
	}
	// Ephemeral handshake must not be clobbered by the archive.
	runBody, err := os.ReadFile(filepath.Join(stateDir, "running.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(runBody) != `{"pid":42}` {
		t.Fatalf("running.json = %q, want local ephemeral preserved", runBody)
	}
}

func TestBackupCreate_JSON(t *testing.T) {
	stateDir := backupConfigEnv(t)
	writeMinimalState(t, stateDir)
	archive := filepath.Join(t.TempDir(), "j.zip")

	out, _, err := executeCLI(t, Deps{}, "backup", "create", archive, "--json")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var rep aobackup.CreateReport
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("parse %q: %v", out, err)
	}
	if rep.Files < 1 || rep.Archive == "" {
		t.Fatalf("report = %+v", rep)
	}
	if !containsString(rep.Excluded, "running.json") {
		t.Fatalf("excluded = %v, want running.json", rep.Excluded)
	}
}

func TestBackupCreate_DefaultPath(t *testing.T) {
	stateDir := backupConfigEnv(t)
	writeMinimalState(t, stateDir)

	cwd := t.TempDir()
	orig, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(cwd); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(orig) })

	fixed := time.Date(2026, 8, 4, 12, 30, 0, 0, time.UTC)
	out, _, err := executeCLI(t, Deps{Now: func() time.Time { return fixed }}, "backup", "create")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wantName := "ao-backup-20260804-123000.zip"
	if !strings.Contains(out, wantName) {
		t.Fatalf("out = %q, want default name %s", out, wantName)
	}
	if _, err := os.Stat(filepath.Join(cwd, wantName)); err != nil {
		t.Fatalf("default archive missing: %v", err)
	}
}

func TestBackupCreate_RefusesWhenDaemonRunning(t *testing.T) {
	stateDir := backupConfigEnv(t)
	writeMinimalState(t, stateDir)
	runFile := filepath.Join(stateDir, "running.json")
	if err := runfile.Write(runFile, runfile.Info{PID: os.Getpid(), Port: 3001, StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	_, _, err := executeCLI(t, Deps{}, "backup", "create", filepath.Join(t.TempDir(), "x.zip"))
	if err == nil || !strings.Contains(err.Error(), "daemon is running") {
		t.Fatalf("err = %v, want daemon running refusal", err)
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("ExitCode = %d, want 2 (usageError)", got)
	}
}

func TestBackupRestore_RefusesWhenDaemonRunning(t *testing.T) {
	stateDir := backupConfigEnv(t)
	writeMinimalState(t, stateDir)
	archive := filepath.Join(t.TempDir(), "b.zip")
	if _, err := aobackup.Create(stateDir, archive); err != nil {
		t.Fatal(err)
	}
	if err := runfile.Write(filepath.Join(stateDir, "running.json"), runfile.Info{
		PID: os.Getpid(), Port: 3001, StartedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	_, _, err := executeCLI(t, Deps{}, "backup", "restore", archive, "--yes")
	if err == nil || !strings.Contains(err.Error(), "daemon is running") {
		t.Fatalf("err = %v, want daemon running refusal", err)
	}
}

func TestBackupRestore_DryRun(t *testing.T) {
	stateDir := backupConfigEnv(t)
	writeMinimalState(t, stateDir)
	archive := filepath.Join(t.TempDir(), "b.zip")
	if _, err := aobackup.Create(stateDir, archive); err != nil {
		t.Fatal(err)
	}
	// Change a durable file; dry-run must leave it alone.
	if err := os.WriteFile(filepath.Join(stateDir, "app-state.json"), []byte(`{"changed":true}`), 0o600); err != nil {
		t.Fatal(err)
	}

	out, _, err := executeCLI(t, Deps{}, "backup", "restore", archive, "--dry-run")
	if err != nil {
		t.Fatalf("restore dry-run: %v", err)
	}
	if !strings.Contains(out, "Dry run") {
		t.Fatalf("out = %q", out)
	}
	body, _ := os.ReadFile(filepath.Join(stateDir, "app-state.json"))
	if string(body) != `{"changed":true}` {
		t.Fatalf("dry-run mutated app-state.json: %s", body)
	}
}

func TestBackupRestore_RequiresPath(t *testing.T) {
	backupConfigEnv(t)
	_, _, err := executeCLI(t, Deps{}, "backup", "restore")
	if err == nil {
		t.Fatal("expected usage error")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("ExitCode = %d, want 2", got)
	}
}

func TestBackupHelpMentionsDaemonStop(t *testing.T) {
	out, _, err := executeCLI(t, Deps{}, "backup", "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"create", "restore", "running.json", "daemon"} {
		if !strings.Contains(out, want) {
			t.Fatalf("help missing %q:\n%s", want, out)
		}
	}
}

func containsString(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
