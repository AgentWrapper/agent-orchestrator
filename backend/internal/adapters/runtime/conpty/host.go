// Package conpty - host.go implements the serve engine for the pty-host
// detached process. It owns the agent's PTY (via the ptyConn seam), exposes
// it over a loopback TCP socket using the B1 binary protocol, replays
// scrollback to new clients, fans output to all connected clients, and shuts
// down gracefully (ConPTY dispose first, then clients, then listener).
//
// This file is cross-platform; only the real conptyConn impl is Windows-tagged.
package conpty

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"sync"
	"time"
)

// ptyConn is the host's handle to the running agent's pseudo-terminal.
// The real impl (conptyConn) lives in host_conpty_windows.go; tests use a fake.
type ptyConn interface {
	io.Reader // PTY output (raw bytes from the terminal)
	io.Writer // PTY input (keystrokes to the terminal)
	Resize(cols, rows int) error
	Close() error          // dispose the ConPTY
	Done() <-chan struct{} // closed when the child process exits
	ExitCode() (int, bool) // (code, true) once exited; (0, false) while running
	PID() int
}

// ServeConfig carries everything the host needs.
type ServeConfig struct {
	SessionID string
	Listener  net.Listener // caller provides (loopback); engine owns Accept loop
	PTY       ptyConn
	Ring      *Ring
}

// Serve runs the host event loop until the listener closes or Shutdown is
// invoked via the returned ShutdownFunc. It pumps PTY output into the ring
// and broadcasts to all clients, accepts new clients (replaying ring snapshot),
// and dispatches client messages. On PTY exit it broadcasts a status update
// but stays alive (keep-alive, mirroring tmux behavior). Returns when shut down.
func Serve(ctx context.Context, cfg ServeConfig) error {
	h := &host{
		cfg:       cfg,
		clients:   make(map[net.Conn]*hostClient),
		shutdownC: make(chan struct{}),
	}
	return h.run(ctx)
}

// clientQueueDepth bounds each client's pending-frame queue. A client that
// stops draining its socket fills this queue and is then evicted, instead of
// blocking the PTY pump (and every other client) behind its stalled write.
// Deep enough to absorb a normal reader's jitter, shallow enough that a dead
// reader is detected within one screen of output.
const clientQueueDepth = 256

// host holds the mutable state for a single pty-host session.
type host struct {
	cfg     ServeConfig
	mu      sync.Mutex
	clients map[net.Conn]*hostClient

	shutdownOnce sync.Once
	shutdownC    chan struct{} // closed when Shutdown is called
}

// hostClient is one connected client: its connection plus the bounded queue its
// own writer goroutine drains. Socket writes happen ONLY in that goroutine, so
// no write is ever performed under the host's global client mutex.
type hostClient struct {
	conn      net.Conn
	sendC     chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

// enqueue offers a frame to the client's queue without ever blocking. A full
// queue means the client is not reading: evict it. Dropping frames for that one
// client is the only alternative to stalling the whole session, and a client
// that fell behind by a full queue has already lost the stream — it must
// reattach for a fresh scrollback replay.
func (h *host) enqueue(c *hostClient, msg []byte) {
	select {
	case c.sendC <- msg:
	case <-c.done:
	default:
		h.removeClient(c)
	}
}

// pumpClient drains the client's queue onto its socket. Blocking here is safe:
// it holds no lock.
func (h *host) pumpClient(c *hostClient) {
	for {
		select {
		case <-c.done:
			return
		case frame := <-c.sendC:
			if _, err := c.conn.Write(frame); err != nil {
				h.removeClient(c)
				return
			}
		}
	}
}

// removeClient unregisters and closes a client. Idempotent; safe to call from
// the pump, the reader, the broadcaster, and shutdown.
func (h *host) removeClient(c *hostClient) {
	h.mu.Lock()
	if h.clients[c.conn] == c {
		delete(h.clients, c.conn)
	}
	h.mu.Unlock()
	c.close()
}

func (c *hostClient) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

// snapshotClients copies the current client set so fan-out never holds the
// global mutex across a send.
func (h *host) snapshotClients() []*hostClient {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]*hostClient, 0, len(h.clients))
	for _, c := range h.clients {
		out = append(out, c)
	}
	return out
}

// run is the main event loop.
func (h *host) run(ctx context.Context) error {
	// Pump PTY output to ring + broadcast.
	go h.pumpPTY()

	// Watch for ctx cancellation and trigger shutdown.
	go func() {
		select {
		case <-ctx.Done():
			h.shutdown()
		case <-h.shutdownC:
		}
	}()

	// runAcceptLoop accepts connections until the listener closes. A listener
	// close is normal (shutdown or external) and is treated as success.
	h.runAcceptLoop()
	return nil
}

// runAcceptLoop runs the Accept loop until the listener closes or returns an
// error. Listener-close errors are swallowed; they signal normal shutdown.
func (h *host) runAcceptLoop() {
	for {
		conn, err := h.cfg.Listener.Accept()
		if err != nil {
			return
		}
		go h.handleConn(conn)
	}
}

// shutdown is idempotent: disposes the ConPTY, closes clients, closes the
// listener. Mirrors the pty-host.ts shutdown() function.
// ponytail: 50ms sleep after pty.Close() gives the OS ConPTY helper
// (conpty_console_list_agent.exe) time to release cleanly; avoids the
// 0x800700e8 error dialog on Windows.
func (h *host) shutdown() {
	h.shutdownOnce.Do(func() {
		close(h.shutdownC)

		// 1. Dispose the ConPTY first (critical ordering).
		_ = h.cfg.PTY.Close()

		// 2. Brief grace so the OS ConPTY helper can clean up.
		time.Sleep(50 * time.Millisecond)

		// 3. Close all client connections. The close happens outside the lock: a
		// client whose socket is full must not be able to hold shutdown behind it.
		h.mu.Lock()
		clients := make([]*hostClient, 0, len(h.clients))
		for _, c := range h.clients {
			clients = append(clients, c)
		}
		h.clients = make(map[net.Conn]*hostClient)
		h.mu.Unlock()
		for _, c := range clients {
			c.close()
		}

		// 4. Close the listener to unblock Accept.
		_ = h.cfg.Listener.Close()
	})
}

// pumpPTY reads PTY output continuously, appends to the ring, and broadcasts
// to clients. On PTY exit it flushes the partial line and sends a status
// update but does NOT close the listener (keep-alive).
func (h *host) pumpPTY() {
	buf := make([]byte, 32*1024)
	for {
		n, err := h.cfg.PTY.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			h.cfg.Ring.Append(chunk)
			if frame, err := EncodeMessage(MsgTerminalData, chunk); err == nil {
				h.broadcast(frame)
			}
		}
		if err != nil {
			break
		}
	}

	// PTY reader is done (process exited or PTY closed). Wait for the Done
	// signal so ExitCode is populated before we send the status broadcast.
	<-h.cfg.PTY.Done()

	h.cfg.Ring.FlushPartial()

	code, _ := h.cfg.PTY.ExitCode()
	pid := h.cfg.PTY.PID()
	h.broadcast(statusFrame(false, pid, &code))
	// Keep-alive: do NOT shutdown here. The host stays up so clients can
	// still connect and read scrollback.
}

// broadcast queues msg for every connected client. It never writes to a socket
// under the global mutex: it copies the client set, then offers the frame to
// each client's bounded queue, evicting any client that has stopped reading.
func (h *host) broadcast(msg []byte) {
	for _, c := range h.snapshotClients() {
		h.enqueue(c, msg)
	}
}

// sendTo queues msg for a single client (best-effort; evicts a stalled one).
func (h *host) sendTo(conn net.Conn, msg []byte) {
	h.mu.Lock()
	c, ok := h.clients[conn]
	h.mu.Unlock()
	if !ok {
		return
	}
	h.enqueue(c, msg)
}

// handleConn manages the lifecycle of a single client connection.
func (h *host) handleConn(conn net.Conn) {
	// Scrollback replay: take the ring snapshot, QUEUE it as this client's first
	// frame, and add the client to the broadcast set — all under a SINGLE h.mu
	// hold. broadcast() takes h.mu to copy the client set, so it cannot
	// interleave: any PTY chunk that arrives is either already in this snapshot,
	// or is queued strictly after the client joins the set. Doing this in two
	// separate locks would let a chunk slip into the gap (in neither the snapshot
	// nor this client's stream) and be silently dropped.
	//
	// The snapshot is only ENQUEUED here (the queue is empty, so it cannot
	// block); the socket write happens in the client's own pump goroutine, so no
	// socket write is ever performed under the global mutex.
	c := &hostClient{conn: conn, sendC: make(chan []byte, clientQueueDepth), done: make(chan struct{})}
	h.mu.Lock()
	// Shutdown is checked UNDER the same lock that registers the client, and
	// shutdown closes shutdownC before it takes that lock to snapshot the client
	// set. So either this client joins the set before the snapshot (and shutdown
	// closes it), or it sees the closed channel here and is refused — a
	// connection the accept loop admitted in the shutdown window is never adopted
	// and left blocked in Read until its peer happens to disconnect.
	select {
	case <-h.shutdownC:
		h.mu.Unlock()
		c.close()
		return
	default:
	}
	snap := h.cfg.Ring.Snapshot()
	if len(snap) > 0 {
		if snapFrame, err := EncodeMessage(MsgTerminalData, snap); err == nil {
			c.sendC <- snapFrame
		}
	}
	h.clients[conn] = c
	h.mu.Unlock()

	go h.pumpClient(c)

	defer h.removeClient(c)

	parser := NewMessageParser(func(msgType byte, payload []byte) {
		h.handleClientMsg(conn, msgType, payload)
	})

	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			parser.Feed(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// handleClientMsg dispatches a decoded client message. Mirrors handleClientMessage
// from pty-host.ts.
func (h *host) handleClientMsg(conn net.Conn, msgType byte, payload []byte) {
	switch msgType {
	case MsgTerminalInput:
		if _, alive := h.cfg.PTY.ExitCode(); !alive {
			_, _ = h.cfg.PTY.Write(payload)
		}

	case MsgResize:
		if _, alive := h.cfg.PTY.ExitCode(); !alive {
			var rp ResizePayload
			if err := json.Unmarshal(payload, &rp); err == nil {
				_ = h.cfg.PTY.Resize(rp.Cols, rp.Rows)
			}
			// Malformed resize: ignore (matches TS behavior).
		}

	case MsgGetOutputReq:
		lines := 50 // default matches TS
		var req GetOutputReq
		if err := json.Unmarshal(payload, &req); err == nil && req.Lines > 0 {
			lines = req.Lines
		}
		text := h.cfg.Ring.Tail(lines)
		if frame, err := EncodeMessage(MsgGetOutputRes, []byte(text)); err == nil {
			h.sendTo(conn, frame)
		}

	case MsgStatusReq:
		code, exited := h.cfg.PTY.ExitCode()
		alive := !exited
		pid := h.cfg.PTY.PID()
		var codePtr *int
		if exited {
			codePtr = &code
		}
		h.sendTo(conn, statusFrame(alive, pid, codePtr))

	case MsgKillReq:
		// Trigger graceful shutdown; returns immediately (idempotent).
		go h.shutdown()
	}
}

// statusFrame builds a MsgStatusRes frame.
func statusFrame(alive bool, pid int, exitCode *int) []byte {
	sp := StatusPayload{Alive: alive, PID: pid, ExitCode: exitCode}
	b, _ := json.Marshal(sp)
	frame, _ := EncodeMessage(MsgStatusRes, b) // b is small JSON, never overflows uint32
	return frame
}
