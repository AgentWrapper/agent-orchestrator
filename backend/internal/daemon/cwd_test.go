package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStabilizeWorkingDirectoryChdirsToDataDir(t *testing.T) {
	oldCWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldCWD); err != nil {
			t.Fatalf("restore cwd: %v", err)
		}
	})

	dataDir := filepath.Join(t.TempDir(), "ao-data")
	if err := stabilizeWorkingDirectory(dataDir); err != nil {
		t.Fatalf("stabilizeWorkingDirectory: %v", err)
	}
	got, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if got = cleanSymlinkedPath(t, got); got != cleanSymlinkedPath(t, dataDir) {
		t.Fatalf("cwd = %q, want %q", got, dataDir)
	}
}

func TestStabilizeWorkingDirectoryRequiresDataDir(t *testing.T) {
	if err := stabilizeWorkingDirectory(""); err == nil {
		t.Fatal("stabilizeWorkingDirectory empty dir: got nil, want error")
	}
}

func cleanSymlinkedPath(t *testing.T, p string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}
