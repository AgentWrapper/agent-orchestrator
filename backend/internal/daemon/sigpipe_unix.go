//go:build !windows

package daemon

import (
	"os"
	"os/signal"
	"sync"
	"syscall"
)

var (
	brokenPipeSignal     = make(chan os.Signal, 1)
	ignoreBrokenPipeOnce sync.Once
)

func ignoreBrokenPipeSignal() {
	ignoreBrokenPipeOnce.Do(func() {
		// A daemon spawned by the desktop supervisor logs to stdout/stderr pipes.
		// If that supervisor exits first, POSIX may deliver SIGPIPE on the next
		// write to fd 1 or 2. Catch and discard it so the write returns EPIPE and
		// the daemon can follow its normal supervisor-disconnect shutdown path.
		signal.Notify(brokenPipeSignal, syscall.SIGPIPE)
	})
}
