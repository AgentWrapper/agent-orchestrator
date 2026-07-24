package conpty

import (
	"io"
	"path/filepath"
	"testing"
)

func TestRunHostRejectsMissingWorkingDirectory(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	code := RunHost([]string{"sess-1", missing, "agent.exe"}, io.Discard)
	if code != 1 {
		t.Fatalf("RunHost code = %d, want 1", code)
	}
}
