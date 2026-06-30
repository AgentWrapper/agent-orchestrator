//go:build !windows

package supervisor

import (
	"net"
	"os"
	"path/filepath"
)

// Listen creates a Unix domain socket listener alongside the run-file.
// The socket path is a sibling of runFilePath: <dir(runFilePath)>/supervise.sock.
// Any stale socket file is removed before binding (ignored if absent).
// The returned net.Listener unlinks the socket on Close (Go stdlib default for UnixListener).
// Returns (listener, socketPath, error).
func Listen(runFilePath string) (net.Listener, string, error) {
	sockPath := filepath.Join(filepath.Dir(runFilePath), "supervise.sock")
	// Remove stale socket; ignore not-exist error.
	_ = os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return nil, "", err
	}
	return ln, sockPath, nil
}
