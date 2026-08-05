package workspacewatch

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// openDescriptors counts this process's open file descriptors. Readdirnames
// avoids stat'ing each entry, which trips over descriptors closed mid-scan.
func openDescriptors(t *testing.T) (int, bool) {
	t.Helper()
	dir, err := os.Open("/dev/fd")
	if err != nil {
		return 0, false
	}
	defer func() { _ = dir.Close() }()
	names, err := dir.Readdirnames(-1)
	if err != nil {
		return 0, false
	}
	return len(names), true
}

// TestWatchReleasesDescriptorsOnCancel pins the descriptor accounting of a
// cancelled watch. The kqueue backend keeps one descriptor per watched file, so
// a workspace watcher that does not release them on teardown costs roughly two
// thousand descriptors per stream against a 61,440 per-process cap on macOS:
// a handful of workspace views wedge the whole daemon, and every later
// operation that needs a descriptor (spawning git, opening the next watcher)
// fails with a bare 500. fsnotify v1.9.0 leaked exactly this way, because
// kqueue.Close marked the watcher closed before its removal loop ran, which
// made every removal a no-op.
func TestWatchReleasesDescriptorsOnCancel(t *testing.T) {
	baseline, ok := openDescriptors(t)
	if !ok {
		t.Skip("descriptor counting is unavailable on this platform")
	}

	root := t.TempDir()
	for d := range 20 {
		dir := filepath.Join(root, fmt.Sprintf("dir-%02d", d))
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatalf("create dir: %v", err)
		}
		for f := range 20 {
			name := filepath.Join(dir, fmt.Sprintf("file-%02d.txt", f))
			if err := os.WriteFile(name, []byte("x"), 0o600); err != nil {
				t.Fatalf("create file: %v", err)
			}
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	changes, err := Watch(ctx, root)
	if err != nil {
		t.Fatalf("watch: %v", err)
	}

	watching, _ := openDescriptors(t)
	if watching <= baseline {
		t.Fatalf("watching descriptors = %d, want more than the %d baseline", watching, baseline)
	}

	cancel()
	for range changes { //nolint:revive // drain until the watcher closes the channel
	}

	// Teardown is asynchronous; poll rather than sleep a fixed interval.
	deadline := time.Now().Add(10 * time.Second)
	var after int
	for time.Now().Before(deadline) {
		after, _ = openDescriptors(t)
		if after <= baseline {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("descriptors after cancel = %d, want at most the %d baseline (leaked %d of the %d opened)",
		after, baseline, after-baseline, watching-baseline)
}
