//go:build linux

package metrics

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestIsManagedScope(t *testing.T) {
	cases := map[string]bool{
		"/user.slice/user-1007.slice/user@1007.service/app.slice/tmux-spawn-abc.scope": true,
		"/user.slice/.../app.slice/ao.service":                                         false,
		"/user.slice/user-1007.slice/session-3.scope":                                  false, // .scope but not tmux-spawn
		"tmux-spawn-x.scope":     true,
		"/foo/tmux-spawn-.scope": true,
		"":                       false,
	}
	for cg, want := range cases {
		if got := isManagedScope(cg); got != want {
			t.Errorf("isManagedScope(%q) = %v, want %v", cg, got, want)
		}
	}
}

// TestTmuxPaneListerTimeoutIsError verifies a wedged tmux exec surfaces the
// context deadline as an ERROR, not a silent "no panes". CommandContext kills
// the process on deadline, so Wait returns an *exec.ExitError ("signal:
// killed"); the collector must still classify a cancelled context as a failure.
func TestTmuxPaneListerTimeoutIsError(t *testing.T) {
	// `sleep 5` will outlive an already-expired context, forcing the deadline.
	l := tmuxPaneLister{binary: "sleep"}
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()
	time.Sleep(5 * time.Millisecond) // ensure the ctx is already past its deadline

	// Reuse the lister but through a context that is already dead: the inner
	// WithTimeout inherits the dead parent, so the command is cancelled at once.
	_, err := l.panes(ctx)
	if err == nil {
		t.Fatal("a cancelled/timed-out tmux exec must return an error, not nil (silent no-panes)")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("want DeadlineExceeded, got %v", err)
	}
}

// TestTmuxPaneListerNonzeroExitIsNoPanes: a nonzero exit from a runnable binary
// (no tmux server) is "no panes", not a tick failure.
func TestTmuxPaneListerNoServerExitIsNoPanes(t *testing.T) {
	l := tmuxPaneLister{binary: "testdata/tmux-no-server"}
	panes, err := l.panes(context.Background())
	if err != nil {
		t.Fatalf("no-server exit must degrade to no panes, got err=%v", err)
	}
	if len(panes) != 0 {
		t.Fatalf("want zero panes, got %d", len(panes))
	}
}

func TestTmuxPaneListerOtherNonzeroExitIsError(t *testing.T) {
	l := tmuxPaneLister{binary: "false"}
	if _, err := l.panes(context.Background()); err == nil {
		t.Fatal("unexpected nonzero tmux exits must return an error")
	}
}

// TestTmuxPaneListerMissingBinaryIsError: a binary not on PATH is a genuine
// failure (the observer must not report a healthy fleet it cannot see).
func TestTmuxPaneListerMissingBinaryIsError(t *testing.T) {
	l := tmuxPaneLister{binary: "definitely-not-a-real-binary-xyz"}
	if _, err := l.panes(context.Background()); err == nil {
		t.Fatal("missing tmux binary must return an error")
	}
}

func TestCgroupV2MemReaderAnchorsAbsoluteCgroupUnderRoot(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "user.slice", "ao.scope")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(path, "memory.current"), []byte("12345\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	got, ok := (cgroupV2MemReader{root: root}).memBytes("/user.slice/ao.scope")
	if !ok || got != 12345 {
		t.Fatalf("memBytes should read under the configured root for absolute cgroups, got %d ok=%v", got, ok)
	}
	if _, err := os.Stat(filepath.Join("/user.slice/ao.scope", "memory.current")); err == nil {
		t.Fatal("test unexpectedly created/read an absolute /user.slice path")
	}
}
