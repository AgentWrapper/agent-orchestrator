// attach.go - Daytona Attach: a ports.Stream over the sandbox's PTY
// WebSocket. Every AO client attach creates its own fresh PTY session running
// `tmux attach`, so multiple viewers share the tmux window exactly like the
// local tmux adapter (largest client drives the shared grid via tmux's
// window-size largest). All connectivity is outbound: daemon → Daytona's
// toolbox proxy; the sandbox exposes no inbound port.
package daytona

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.Attacher = (*Runtime)(nil)

// Attach opens a fresh attach Stream for the session, sized rows x cols from
// birth (0 means unknown; the terminal manager resizes on join). ctx
// cancellation terminates the stream.
func (r *Runtime) Attach(ctx context.Context, handle ports.RuntimeHandle, rows, cols uint16) (ports.Stream, error) {
	id, err := handleID(handle)
	if err != nil {
		return nil, err
	}
	sb, found, err := r.sandboxForHandle(ctx, id)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("daytona runtime: no sandbox for session %s", id)
	}
	if sb.State != StateStarted {
		return nil, fmt.Errorf("daytona runtime: sandbox for session %s is %s; cannot attach while parked", id, sb.State)
	}
	if rows == 0 {
		rows = 50
	}
	if cols == 0 {
		cols = 220
	}
	conn, err := r.client.OpenPTY(ctx, sb.ID, PTYSpec{
		ID:   attachPTYID(id),
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		return nil, fmt.Errorf("daytona runtime: open pty for %s: %w", id, err)
	}
	// Daytona's PTY create takes no command: the PTY runs the sandbox user's
	// shell, and the first input line execs the tmux attach client. tmux's
	// full-screen repaint immediately overwrites the echoed command line.
	if _, err := conn.Write([]byte(attachCommand(id))); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("daytona runtime: start attach for %s: %w", id, err)
	}
	s := &ptyStream{conn: conn}
	go func() {
		<-ctx.Done()
		_ = s.Close()
	}()
	return s, nil
}

// attachPTYID names one attach's PTY session; unique per attach so concurrent
// viewers never collide on Daytona's per-sandbox PTY id namespace.
func attachPTYID(handle string) string {
	var suffix [4]byte
	_, _ = rand.Read(suffix[:])
	base := handle
	if len(base) > 32 {
		base = base[:32]
	}
	return "ao-attach-" + base + "-" + hex.EncodeToString(suffix[:])
}

// ptyStream adapts a PTYConn to ports.Stream (Resize signature).
type ptyStream struct {
	conn PTYConn
}

var _ ports.Stream = (*ptyStream)(nil)

func (s *ptyStream) Read(b []byte) (int, error)  { return s.conn.Read(b) }
func (s *ptyStream) Write(b []byte) (int, error) { return s.conn.Write(b) }
func (s *ptyStream) Close() error                { return s.conn.Close() }

func (s *ptyStream) Resize(rows, cols uint16) error {
	return s.conn.Resize(rows, cols)
}
