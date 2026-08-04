//go:build !windows

package daemon

import (
	"os"
	"os/signal"
	"syscall"
)

var sigpipeSink = make(chan os.Signal, 1)

// ignoreBrokenPipeSignal prevents a closed supervisor stdout/stderr pipe from
// killing the daemon before its graceful shutdown can remove running.json.
func ignoreBrokenPipeSignal() {
	signal.Notify(sigpipeSink, syscall.SIGPIPE)
}
