package gitworktree

import (
	"errors"
	"os"
	"time"
)

// Worktree removal races process exit on Windows. A PTY (or any agent child)
// rooted in the worktree can still hold a handle on that directory for a short
// window AFTER the call that killed it returned — the OS releases handles
// asynchronously during process teardown, and the process is already gone from
// every liveness probe by then. os.RemoveAll fails with
// ERROR_SHARING_VIOLATION / ERROR_ACCESS_DENIED ("The process cannot access the
// file because it is being used by another process"), even though nothing is
// meaningfully using the directory anymore and a retry a moment later succeeds.
//
// This is reachable from `ao session kill` on a session whose scoped shell
// terminals were just destroyed: Session Manager closes the shells, then
// removes the worktree immediately, inside the same request. Measured release
// latency ran past a second with two shells open, so the budget below is
// deliberately generous — a kill that takes a few extra seconds is strictly
// better than one that 500s and strands the worktree.
//
// These are vars, not consts, so tests can drive the loop without sleeping for
// real.
var (
	// removeAllAttempts × the capped backoff below bounds the total wait at
	// roughly 7.75s: 50+100+200+400+500×13 across 18 tries. Sized from measured
	// behaviour — a two-shell session was observed still holding its worktree
	// past the 5s mark — with headroom on top, since the alternative to waiting
	// is a failed kill that strands the worktree. Finite so a genuinely wedged
	// directory still surfaces as an error rather than hanging the request
	// forever.
	removeAllAttempts   = 18
	removeAllBackoff    = 50 * time.Millisecond
	removeAllBackoffCap = 500 * time.Millisecond
	// removeAll is os.RemoveAll in production; tests substitute a stub to drive
	// the retry loop deterministically instead of depending on platform
	// filesystem locking semantics (the real sharing violation only reproduces
	// on Windows).
	removeAll = os.RemoveAll
)

// removeAllWithRetry is os.RemoveAll plus a bounded, backing-off retry for the
// transient Windows sharing violation described above. A path that is already
// gone is success (os.RemoveAll's own semantics), and the last error is
// returned unwrapped so callers can still match on it.
//
// The retry is deliberately unconditional on error identity rather than
// sniffing for a Windows errno: the syscall surface differs across Windows
// versions and filesystems (and Wine/CI shims), and every error os.RemoveAll
// can return here is either transient-and-worth-retrying or permanent-and-
// still-an-error after the budget. The backoff starts short so the common case
// (handle released almost immediately) costs ~50ms, and grows so a slower
// release does not burn the attempt budget in the first half-second.
func removeAllWithRetry(path string) error {
	var err error
	backoff := removeAllBackoff
	for attempt := range removeAllAttempts {
		if err = removeAll(path); err == nil {
			return nil
		}
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if attempt < removeAllAttempts-1 {
			time.Sleep(backoff)
			if backoff *= 2; backoff > removeAllBackoffCap {
				backoff = removeAllBackoffCap
			}
		}
	}
	return err
}
