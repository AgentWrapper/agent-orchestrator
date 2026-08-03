package aobackup

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShouldExclude(t *testing.T) {
	t.Parallel()
	cases := []struct {
		rel  string
		want bool
	}{
		{"running.json", true},
		{"windows-pty-hosts.json", true},
		{"electron/Cache/foo", true},
		{"staging/app.zip", true},
		{"daemon.log", true},
		{"app-state.json", false},
		{"ui-settings.json", false},
		{"update-settings.json", false},
		{"data/ao.db", false},
		{"data/ao.db-wal", false},
		{"data/ao.db-shm", false},
		{"data/worktrees/proj/session", false},
		{"data/skills/using-ao/SKILL.md", false},
		{"data/mobile/config.json", false},
		{"data/foo.tmp", true},
		{"data/bar.lock", true},
		{".running-123.json", true},
		{".app-state-1.json", true},
		{".ao-pre-restore-20260101-000000/data", true},
		{ManifestName, true},
		{"", true},
		{".", true},
	}
	for _, tc := range cases {
		if got := ShouldExclude(tc.rel); got != tc.want {
			t.Errorf("ShouldExclude(%q) = %v, want %v", tc.rel, got, tc.want)
		}
	}
}

func TestCreateRestore_HappyPath(t *testing.T) {
	state := t.TempDir()
	// Durable files that must round-trip.
	mustWrite(t, filepath.Join(state, "app-state.json"), `{"schemaVersion":2}`)
	mustWrite(t, filepath.Join(state, "ui-settings.json"), `{"locale":"en"}`)
	mustWrite(t, filepath.Join(state, "update-settings.json"), `{"channel":"stable"}`)
	mustWrite(t, filepath.Join(state, "data", "ao.db"), "sqlite-bytes")
	mustWrite(t, filepath.Join(state, "data", "ao.db-wal"), "wal")
	mustWrite(t, filepath.Join(state, "data", "worktrees", "proj", "s1", "README.md"), "hello")
	mustWrite(t, filepath.Join(state, "data", "mobile", "config.json"), `{"enabled":false}`)

	// Ephemeral files that must not appear in the archive.
	mustWrite(t, filepath.Join(state, "running.json"), `{"pid":1}`)
	mustWrite(t, filepath.Join(state, "windows-pty-hosts.json"), `[]`)
	mustWrite(t, filepath.Join(state, "electron", "Cache", "x"), "cache")
	mustWrite(t, filepath.Join(state, "staging", "dl.zip"), "dl")
	mustWrite(t, filepath.Join(state, "daemon.log"), "log")
	mustWrite(t, filepath.Join(state, "data", "scratch.tmp"), "tmp")

	archive := filepath.Join(t.TempDir(), "backup.zip")
	rep, err := Create(state, archive)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if rep.Files < 6 {
		t.Fatalf("files = %d, want at least the durable set", rep.Files)
	}
	for _, name := range []string{"running.json", "windows-pty-hosts.json", "electron", "staging", "daemon.log"} {
		if !contains(rep.Excluded, name) {
			t.Errorf("excluded missing %q: %v", name, rep.Excluded)
		}
	}

	// Archive must not contain ephemeral paths.
	assertZipHas(t, archive, "app-state.json", "data/ao.db", "data/worktrees/proj/s1/README.md")
	assertZipLacks(t, archive, "running.json", "electron/Cache/x", "data/scratch.tmp", "daemon.log")

	// Restore into a fresh dir that already has conflicting durable + ephemeral.
	dest := t.TempDir()
	mustWrite(t, filepath.Join(dest, "app-state.json"), `{"old":true}`)
	mustWrite(t, filepath.Join(dest, "running.json"), `{"pid":99}`)
	mustWrite(t, filepath.Join(dest, "electron", "keep-me"), "alive")

	restoreRep, err := Restore(archive, dest, RestoreOptions{})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restoreRep.Files != rep.Files {
		t.Fatalf("restore files = %d, want %d", restoreRep.Files, rep.Files)
	}
	if !contains(restoreRep.Replaced, "app-state.json") {
		t.Fatalf("replaced = %v, want app-state.json", restoreRep.Replaced)
	}
	if restoreRep.PreRestoreDir == "" {
		t.Fatal("expected pre-restore dir when overwriting durable state")
	}

	// Durable content restored.
	assertFile(t, filepath.Join(dest, "app-state.json"), `{"schemaVersion":2}`)
	assertFile(t, filepath.Join(dest, "data", "ao.db"), "sqlite-bytes")
	assertFile(t, filepath.Join(dest, "data", "worktrees", "proj", "s1", "README.md"), "hello")
	assertFile(t, filepath.Join(dest, "ui-settings.json"), `{"locale":"en"}`)

	// Ephemeral local state preserved (not in archive, not deleted).
	assertFile(t, filepath.Join(dest, "running.json"), `{"pid":99}`)
	assertFile(t, filepath.Join(dest, "electron", "keep-me"), "alive")

	// Prior durable value parked under pre-restore.
	assertFile(t, filepath.Join(restoreRep.PreRestoreDir, "app-state.json"), `{"old":true}`)
}

func TestCreate_RefusesExistingArchive(t *testing.T) {
	state := t.TempDir()
	mustWrite(t, filepath.Join(state, "app-state.json"), `{}`)
	archive := filepath.Join(t.TempDir(), "exists.zip")
	mustWrite(t, archive, "nope")
	if _, err := Create(state, archive); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("err = %v, want already exists", err)
	}
}

func TestRestore_DryRunDoesNotWrite(t *testing.T) {
	state := t.TempDir()
	mustWrite(t, filepath.Join(state, "app-state.json"), `{"v":1}`)
	archive := filepath.Join(t.TempDir(), "b.zip")
	if _, err := Create(state, archive); err != nil {
		t.Fatal(err)
	}
	dest := t.TempDir()
	mustWrite(t, filepath.Join(dest, "app-state.json"), `{"v":2}`)
	rep, err := Restore(archive, dest, RestoreOptions{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Files < 1 {
		t.Fatalf("files = %d", rep.Files)
	}
	assertFile(t, filepath.Join(dest, "app-state.json"), `{"v":2}`)
	ents, _ := os.ReadDir(dest)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".ao-pre-restore-") {
			t.Fatalf("dry-run created pre-restore dir %s", e.Name())
		}
	}
}

func TestRestore_RejectsZipSlip(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "evil.zip")
	if err := writeEvilZip(archive); err != nil {
		t.Fatal(err)
	}
	dest := t.TempDir()
	if _, err := Restore(archive, dest, RestoreOptions{}); err == nil {
		t.Fatal("expected zip-slip rejection")
	}
}

func TestRestore_RejectsBadManifest(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "bad.zip")
	f, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("app-state.json")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte(`{}`))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	if _, err := Restore(archive, t.TempDir(), RestoreOptions{}); err == nil || !strings.Contains(err.Error(), ManifestName) {
		t.Fatalf("err = %v, want missing manifest", err)
	}
}

func writeEvilZip(path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	// Valid-looking manifest so we reach member extraction.
	mw, err := zw.Create(ManifestName)
	if err != nil {
		return err
	}
	_, _ = mw.Write([]byte(`{"format":"ao-state-backup","schemaVersion":1,"createdAt":"2026-01-01T00:00:00Z","files":1,"bytes":1}` + "\n"))
	ew, err := zw.Create("../escape.txt")
	if err != nil {
		return err
	}
	_, _ = ew.Write([]byte("pwned"))
	return zw.Close()
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertFile(t *testing.T, path, want string) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(b) != want {
		t.Fatalf("%s = %q, want %q", path, b, want)
	}
}

func assertZipHas(t *testing.T, archive string, names ...string) {
	t.Helper()
	zr, err := zip.OpenReader(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	have := map[string]bool{}
	for _, f := range zr.File {
		have[filepath.ToSlash(f.Name)] = true
	}
	for _, n := range names {
		if !have[n] {
			t.Errorf("archive missing %q", n)
		}
	}
}

func assertZipLacks(t *testing.T, archive string, names ...string) {
	t.Helper()
	zr, err := zip.OpenReader(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	have := map[string]bool{}
	for _, f := range zr.File {
		have[filepath.ToSlash(f.Name)] = true
	}
	for _, n := range names {
		if have[n] {
			t.Errorf("archive unexpectedly has %q", n)
		}
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
