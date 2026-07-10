//go:build !windows

package codex

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestValidateModelTimeoutKillsProbeDescendants: exec.CommandContext's default
// cancel kills only the direct child. `codex exec` spawns descendants that hold
// the output pipe, so without a process-group kill they survive the deadline,
// keep the provider call alive, and accumulate across timed-out config writes.
func TestValidateModelTimeoutKillsProbeDescendants(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")

	// The grandchild outlives its parent unless the whole group is killed.
	bin := writeFakeScript(t, `#!/bin/sh
sleep 30 &
echo $! > "$AO_CHILD_PID_FILE"
wait
`)
	t.Setenv("AO_CHILD_PID_FILE", pidFile)

	plugin := &Plugin{resolvedBinary: bin}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	if err := plugin.ValidateModel(ctx, "gpt-5.5"); err == nil {
		t.Fatal("ValidateModel err = nil, want timeout")
	}

	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("read child pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("parse child pid %q: %v", raw, err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })

	// Give the group kill a moment to land, then assert the descendant is gone.
	deadline := time.Now().Add(probeWaitDelay + 3*time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return // signal 0 failed: the process is gone. Success.
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("probe descendant pid %d survived the timeout — the process group was not killed", pid)
}
