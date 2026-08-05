package worker

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAcceptedWorkerTokenIsPublishedForCloudCLI(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("AO_DATA_DIR", dataDir)
	client := NewClient("https://cloud.example", nil)
	client.acceptToken("renewed-token")

	contents, err := os.ReadFile(filepath.Join(dataDir, "worker-token"))
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "renewed-token" {
		t.Fatalf("worker token file = %q", contents)
	}
	info, err := os.Stat(filepath.Join(dataDir, "worker-token"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("worker token mode = %o, want 600", info.Mode().Perm())
	}
}
