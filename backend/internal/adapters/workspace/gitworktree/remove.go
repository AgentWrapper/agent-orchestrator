package gitworktree

import (
	"errors"
	"os"
	"time"
)

// Worktree removal races process exit on Windows. A PTY (or any agent child)
// rooted in the worktree can still hold a handle on that directory for a short
// window AFTER the call that killed it returned — the OS releases handles
// asynchronously during process teardown. os.RemoveAll then fails with
// ERROR_SHARING_VIOLATION / ERROR_ACCESS_DENIED ("The process cannot access the
// file because it is being used by another process"), even though nothing is
// meaningfully using the directory anymore and a retry a moment later succeeds.
//
// This is reachable from `ao session kill` on a session whose scoped shell
// terminal was just destroyed: Session Manager closes the shell, then removes
// the worktree immediately, inside the same request.
//
// These are vars, not consts, so tests can shrink the wait without sleeping for
// real. The total budget (~1.05s across 7 attempts) is sized to outlast normal
// Windows handle-release latency while still failing fast enough that a
// genuinely wedged directory surfaces as an error rather than hanging the
// request.
var (
	removeAllAttempts = 7
	removeAllBackoff  = 150 * time.Millisecond
	// removeAll is os.RemoveAll in production; tests substitute a stub to drive
	// the retry loop deterministically instead of depending on platform
	// filesystem locking semantics (the real sharing violation only reproduces
	// on Windows).
	removeAll = os.RemoveAll
)

// removeAllWithRetry is os.RemoveAll plus a bounded retry for the transient
// Windows sharing violation described above. A path that is already gone is
// success (os.RemoveAll's own semantics), and the last error is returned
// unwrapped so callers can still match on it.
//
// The retry is deliberately unconditional on error identity rather than
// sniffing for a Windows errno: the syscall surface differs across Windows
// versions and filesystems (and Wine/CI shims), and every error os.RemoveAll
// can return here is either transient-and-worth-retrying or permanent-and-
// still-an-error after the budget. Retrying a permanent failure costs about a
// second on a path that was going to fail anyway.
func removeAllWithRetry(path string) error {
	var err error
	for attempt := range removeAllAttempts {
		if err = removeAll(path); err == nil {
			return nil
		}
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if attempt < removeAllAttempts-1 {
			time.Sleep(removeAllBackoff)
		}
	}
	return err
}
