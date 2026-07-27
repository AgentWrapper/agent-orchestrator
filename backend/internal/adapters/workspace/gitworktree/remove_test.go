package gitworktree

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// shrinkRemoveAllRetry makes the retry budget test-fast, restoring the
// production values afterwards.
func shrinkRemoveAllRetry(t *testing.T, attempts int) {
	t.Helper()
	origAttempts, origBackoff := removeAllAttempts, removeAllBackoff
	removeAllAttempts, removeAllBackoff = attempts, time.Millisecond
	t.Cleanup(func() { removeAllAttempts, removeAllBackoff = origAttempts, origBackoff })
}

// stubRemoveAll replaces the real os.RemoveAll for the duration of a test.
func stubRemoveAll(t *testing.T, fn func(string) error) {
	t.Helper()
	orig := removeAll
	removeAll = fn
	t.Cleanup(func() { removeAll = orig })
}

func TestRemoveAllWithRetryRemovesPopulatedDirectory(t *testing.T) {
	shrinkRemoveAllRetry(t, 3)
	dir := t.TempDir()
	target := filepath.Join(dir, "worktree")
	if err := os.MkdirAll(filepath.Join(target, "nested"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "nested", "file.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := removeAllWithRetry(target); err != nil {
		t.Fatalf("removeAllWithRetry: %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("stat after remove = %v, want not-exist", err)
	}
}

// A path that was never there is success, matching os.RemoveAll's own
// semantics — teardown must be idempotent.
func TestRemoveAllWithRetryTreatsMissingPathAsSuccess(t *testing.T) {
	shrinkRemoveAllRetry(t, 3)
	if err := removeAllWithRetry(filepath.Join(t.TempDir(), "never-existed")); err != nil {
		t.Fatalf("removeAllWithRetry on a missing path: %v", err)
	}
}

// TestRemoveAllWithRetrySucceedsAfterTransientFailure is the regression for the
// Windows sharing violation this retry exists for: `ao session kill` destroys a
// session's scoped shell terminal and then removes its worktree in the same
// request, but the PTY's handle on that directory can outlive the call that
// killed it, so the first removal fails and a moment later succeeds.
func TestRemoveAllWithRetrySucceedsAfterTransientFailure(t *testing.T) {
	shrinkRemoveAllRetry(t, 5)
	sharingViolation := errors.New("The process cannot access the file because it is being used by another process")
	var calls int
	stubRemoveAll(t, func(string) error {
		calls++
		if calls < 3 {
			return sharingViolation
		}
		return nil
	})

	if err := removeAllWithRetry("/managed/worktrees/demo/demo-1"); err != nil {
		t.Fatalf("removeAllWithRetry did not recover from a transient lock: %v", err)
	}
	if calls != 3 {
		t.Errorf("removeAll calls = %d, want 3 (two failures then success)", calls)
	}
}

// A path that never becomes removable must surface the error rather than
// retrying forever — a permanently wedged directory has to fail loudly.
func TestRemoveAllWithRetryGivesUpAndReturnsError(t *testing.T) {
	shrinkRemoveAllRetry(t, 4)
	wedged := errors.New("still locked")
	var calls int
	stubRemoveAll(t, func(string) error {
		calls++
		return wedged
	})

	err := removeAllWithRetry("/managed/worktrees/demo/demo-1")
	if !errors.Is(err, wedged) {
		t.Fatalf("error = %v, want the underlying removal error", err)
	}
	if calls != 4 {
		t.Errorf("removeAll calls = %d, want the full budget of 4", calls)
	}
}

// os.ErrNotExist must short-circuit immediately: a worktree already gone is
// not a failure to retry against.
func TestRemoveAllWithRetryDoesNotRetryMissingPath(t *testing.T) {
	shrinkRemoveAllRetry(t, 5)
	var calls int
	stubRemoveAll(t, func(string) error {
		calls++
		return os.ErrNotExist
	})

	if err := removeAllWithRetry("/managed/worktrees/demo/demo-1"); err != nil {
		t.Fatalf("removeAllWithRetry: %v", err)
	}
	if calls != 1 {
		t.Errorf("removeAll calls = %d, want 1 — a missing path must not be retried", calls)
	}
}
