//go:build !windows

package supervisor

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// TestListen_basic verifies that Listen returns a listener whose address is
// <dir(runFilePath)>/supervise.sock, that the socket file exists on disk, and
// that a Dial to that address succeeds.
func TestListen_basic(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	runFile := filepath.Join(dir, "running.json")

	ln, addr, err := Listen(runFile)
	if err != nil {
		t.Fatalf("Listen: unexpected error: %v", err)
	}
	defer ln.Close()

	wantSock := filepath.Join(dir, "supervise.sock")
	if addr != wantSock {
		t.Errorf("addr = %q, want %q", addr, wantSock)
	}

	// Socket file must exist after Listen.
	if _, err := os.Stat(wantSock); err != nil {
		t.Errorf("socket file missing after Listen: %v", err)
	}

	// Dialing the returned address must succeed.
	conn, err := net.Dial("unix", addr)
	if err != nil {
		t.Fatalf("Dial(%q): %v", addr, err)
	}
	conn.Close()
}

// TestListen_staleSocket verifies that a pre-existing file at the socket path
// does not prevent Listen from succeeding (the stale file is removed first).
func TestListen_staleSocket(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	runFile := filepath.Join(dir, "running.json")
	sockPath := filepath.Join(dir, "supervise.sock")

	// Pre-create a regular file to simulate a stale socket.
	if err := os.WriteFile(sockPath, []byte("stale"), 0o600); err != nil {
		t.Fatalf("pre-create stale file: %v", err)
	}

	ln, _, err := Listen(runFile)
	if err != nil {
		t.Fatalf("Listen with stale socket: unexpected error: %v", err)
	}
	ln.Close()
}

// TestListen_unlinkOnClose verifies that closing the listener removes the
// socket file from the filesystem (Go stdlib default for UnixListener).
func TestListen_unlinkOnClose(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	runFile := filepath.Join(dir, "running.json")
	sockPath := filepath.Join(dir, "supervise.sock")

	ln, _, err := Listen(runFile)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	ln.Close()

	if _, err := os.Stat(sockPath); !os.IsNotExist(err) {
		t.Errorf("socket file still present after Close (err=%v); expected not-exist", err)
	}
}
