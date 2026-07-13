package conpty

import (
	"bytes"
	"net"
	"strings"
	"testing"
	"time"
)

// #293 M4: the host used to write to every client synchronously while holding
// the GLOBAL client mutex, with no deadline or queue. One client that stops
// reading fills its socket buffer, so the write blocks — and with it PTY
// pumping, new attaches, client removal, and graceful shutdown for that session.
//
// These tests are cross-platform: host.go is the (untagged) serve engine; only
// the real ConPTY handle is Windows-only, and the fixtures drive a fake PTY.

// slowClient dials the host and reads exactly the scrollback snapshot, then
// stops reading forever. Reading that first frame proves the host has finished
// handleConn's snapshot write and registered the connection.
func slowClient(t *testing.T, addr string) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	buf := make([]byte, 4096)
	if _, err := conn.Read(buf); err != nil {
		t.Fatalf("read snapshot frame: %v", err)
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		t.Fatalf("clear read deadline: %v", err)
	}
	return conn
}

// TestSlowClientDoesNotStallPTYPump: a non-reading client must not stop the host
// from draining the PTY. The marker written after the flood must still land in
// the ring.
func TestSlowClientDoesNotStallPTYPump(t *testing.T) {
	f := startServe(t, 5101)
	defer f.cancel()

	// Seed the ring so the slow client's first frame (the snapshot) is
	// deterministic proof of registration.
	f.ring.Append([]byte("seed\n"))
	_ = slowClient(t, f.addr)

	// Flood far past any socket buffer, then a marker the pump can only reach if
	// it never blocked on the stalled client.
	chunk := bytes.Repeat([]byte("x"), 32*1024)
	go func() {
		for range 512 { // 16 MiB
			if _, err := f.pty.WriteOutput(chunk); err != nil {
				return
			}
		}
		_, _ = f.pty.WriteOutput([]byte("PUMP-MARKER\n"))
	}()

	deadline := time.After(10 * time.Second)
	for {
		if strings.Contains(f.ring.Tail(5), "PUMP-MARKER") {
			return
		}
		select {
		case <-deadline:
			t.Fatal("PTY pump stalled: a non-reading client blocked the broadcast path")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestSlowClientDoesNotBlockNewAttach: while a client refuses to read, a fresh
// client must still attach and receive its scrollback replay.
func TestSlowClientDoesNotBlockNewAttach(t *testing.T) {
	f := startServe(t, 5102)
	defer f.cancel()

	f.ring.Append([]byte("seed\n"))
	_ = slowClient(t, f.addr)

	chunk := bytes.Repeat([]byte("y"), 32*1024)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := f.pty.WriteOutput(chunk); err != nil {
				return
			}
		}
	}()

	// Give the flood time to saturate the stalled client's buffers.
	time.Sleep(200 * time.Millisecond)

	fresh := newTestClient(t, f.addr)
	defer fresh.close()
	typ, payload := fresh.readFrame(t)
	if typ != MsgTerminalData || len(payload) == 0 {
		t.Fatalf("fresh attach frame = type %d, %d bytes; want a terminal-data replay", typ, len(payload))
	}
}

// TestSlowClientDoesNotBlockShutdown: graceful shutdown must not hang behind a
// blocked client write.
func TestSlowClientDoesNotBlockShutdown(t *testing.T) {
	f := startServe(t, 5103)
	defer f.cancel()

	f.ring.Append([]byte("seed\n"))
	_ = slowClient(t, f.addr)

	chunk := bytes.Repeat([]byte("z"), 32*1024)
	stop := make(chan struct{})
	go func() {
		defer close(stop)
		for range 512 {
			if _, err := f.pty.WriteOutput(chunk); err != nil {
				return
			}
		}
	}()

	time.Sleep(200 * time.Millisecond)
	f.cancel()
	f.waitDone(t)
	<-stop
}

// TestConnAdmittedAfterShutdownIsClosed pins #293 M4's remaining hole: the
// accept loop runs until the listener actually closes, so a connection can be
// handed to handleConn after shutdown has already taken its client snapshot.
// Such a client used to be registered anyway — it then sat in Read forever,
// with a live writer goroutine, until the peer happened to disconnect. A
// connection admitted after shutdown began must be closed, not adopted.
func TestConnAdmittedAfterShutdownIsClosed(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	h := &host{
		cfg: ServeConfig{
			SessionID: "test-shutdown-admit",
			Listener:  ln,
			PTY:       newFakePTY(5104),
			Ring:      NewRing(),
		},
		clients:   map[net.Conn]*hostClient{},
		shutdownC: make(chan struct{}),
	}
	h.shutdown()

	peer, admitted := net.Pipe()
	defer func() { _ = peer.Close() }()

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.handleConn(admitted)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handleConn adopted a connection admitted after shutdown; it blocks in Read until the peer disconnects")
	}

	h.mu.Lock()
	registered := len(h.clients)
	h.mu.Unlock()
	if registered != 0 {
		t.Fatalf("clients registered after shutdown = %d, want 0", registered)
	}
	// The host's end must be closed: a net.Pipe read fails immediately once the
	// far end is gone, and would otherwise block forever.
	if _, err := peer.Read(make([]byte, 1)); err == nil {
		t.Fatal("connection admitted after shutdown was left open")
	}
}
