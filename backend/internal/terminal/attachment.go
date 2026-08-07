package terminal

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Source is what the terminal needs from the runtime: open an attach Stream and
// a liveness check used to decide whether a dropped Stream should be re-attached
// or treated as a clean exit. The runtime adapters (tmux/conpty) satisfy
// it via Attach/IsAlive; the interface lives here, next to its only consumer, so
// terminal does not depend on a concrete adapter.
type Source interface {
	ports.Attacher
	IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error)
}

// reattach policy: a Stream that drops is re-attached while the underlying
// session is still alive, up to maxReattach consecutive failures. An attach that
// survived longer than reattachResetGrace before dropping resets the counter, so
// a long-lived pane that blips recovers but a tight crash-loop gives up.
const (
	defaultMaxReattach       = 5
	defaultReattachResetTime = 5 * time.Second
)

// attachment is ONE client's hold on a pane: a private attach Stream opened per
// mux open, streaming to a single sink. The runtime is the multiplexer — it owns
// the session's screen state and scrollback, and answers every fresh attach with
// its init handshake (alt screen, bracketed paste, scrollback replay) followed by
// a faithful repaint. That handshake is why the Stream is per-client and there is
// no terminal-layer replay buffer: a byte ring can replay recent output, but the
// one-time mode negotiation at the head of the stream scrolls out of any bounded
// buffer. A fresh attach per client makes the runtime re-send it, every time, by
// construction.
//
// onOpen fires once the attach Stream is actually ready to accept input. onData
// must not block: the WS layer funnels frames onto its own buffered writer.
// onExit fires at most once, when the attach loop gives up (runtime dead,
// attach failure cap) — never on close().
type attachment struct {
	id     string
	handle ports.RuntimeHandle
	src    Source
	log    *slog.Logger
	onOpen func()
	onData func(data []byte)
	onExit func()

	maxReattach int
	resetGrace  time.Duration

	mu           sync.Mutex
	pty          ports.Stream
	cancel       context.CancelFunc
	rows         uint16 // last size the client asked for; re-applied on every attach
	cols         uint16
	closed       bool
	exited       bool
	opened       bool
	inputReady   bool
	pendingInput [][]byte
	// draining is true while a releaseInput loop is actively dequeuing and
	// writing pendingInput. A second caller (e.g. a reattach's own setPTY)
	// finds it true and does not start a competing loop — the active loop
	// already re-reads a.pty fresh before every write, so it naturally hands
	// remaining input to whatever Stream ends up current.
	draining bool

	// inputGate, when set by the Manager before run() starts, delays flipping
	// inputReady until the pane's shared gate opens (see setPTY) — giving a
	// just-launched agent's TUI time to reach raw mode before trusting
	// keystrokes to it. nil disables the hold entirely (e.g. attachments built
	// directly in tests, bypassing Manager).
	inputGate        *inputGate
	inputGraceWindow time.Duration
}

func newAttachment(id string, handle ports.RuntimeHandle, src Source, onOpen func(), onData func([]byte), onExit func(), log *slog.Logger) *attachment {
	if log == nil {
		log = slog.Default()
	}
	if onData == nil {
		onData = func([]byte) {}
	}
	return &attachment{
		id:          id,
		handle:      handle,
		src:         src,
		log:         log,
		onOpen:      onOpen,
		onData:      onData,
		onExit:      onExit,
		maxReattach: defaultMaxReattach,
		resetGrace:  defaultReattachResetTime,
	}
}

// run drives attach → read-loop → re-attach until the pane exits cleanly, the
// attachment is closed, or ctx is cancelled. It is started once per attachment.
func (a *attachment) run(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	if !a.setRunCancel(cancel) {
		cancel()
		return
	}
	defer a.clearRunCancel(cancel)

	failures := 0
	for {
		if a.shouldStop(ctx) {
			return
		}

		// Gate EVERY attach (including the first) on the runtime actually
		// being alive. A mux attach resurrects EXITED sessions — re-running
		// the serialized agent command — so attaching to a dead handle would
		// re-create a runtime the daemon already destroyed, outside lifecycle
		// control. A definitive "not alive" is a clean exit. A probe ERROR is
		// not proof of death: it retries with backoff up to the same
		// consecutive-failure cap as attach failures.
		alive, err := a.src.IsAlive(ctx, a.handle)
		if a.shouldStop(ctx) {
			return
		}
		if err != nil {
			failures++
			if failures > a.maxReattach {
				a.fail("liveness probe: " + err.Error())
				return
			}
			if !a.backoff(ctx, failures) {
				return
			}
			continue
		}
		if !alive {
			a.markExited()
			return
		}

		rows, cols := a.size()
		if a.shouldStop(ctx) {
			return
		}
		p, err := a.src.Attach(ctx, a.handle, rows, cols)
		if a.shouldStop(ctx) {
			if p != nil {
				_ = p.Close()
			}
			return
		}
		if err != nil {
			failures++
			if failures > a.maxReattach {
				a.fail("attach: " + err.Error())
				return
			}
			if !a.backoff(ctx, failures) {
				return
			}
			continue
		}

		if !a.setPTY(ctx, p) {
			_ = p.Close()
			return
		}
		start := time.Now()
		a.copyOut(p)
		a.clearPTY(p)
		_ = p.Close()
		if a.shouldStop(ctx) {
			return
		}

		if time.Since(start) >= a.resetGrace {
			failures = 0
		}
		failures++

		if failures > a.maxReattach {
			a.markExited()
			return
		}
		if !a.backoff(ctx, failures) {
			return
		}
		a.log.Debug("terminal re-attaching", "id", a.id, "failures", failures)
	}
}

// copyOut pumps PTY output to the sink until the PTY closes or errors.
func (a *attachment) copyOut(p ports.Stream) {
	buf := make([]byte, 32*1024)
	for {
		n, err := p.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			a.onData(chunk)
		}
		if err != nil {
			return
		}
	}
}

// backoff sleeps between attach attempts; false means ctx was cancelled.
// Whether another attempt is warranted at all (liveness, failure cap) is
// decided at the top of the run loop, so a re-attach and a first attach share
// one gate.
func (a *attachment) backoff(ctx context.Context, failures int) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(reattachBackoff(failures)):
		return true
	}
}

func reattachBackoff(failures int) time.Duration {
	d := time.Duration(failures) * 200 * time.Millisecond
	if d > time.Second {
		d = time.Second
	}
	return d
}

// write sends client keystrokes to the PTY. Input that arrives after open but
// before the attach PTY is published is buffered and flushed as soon as setPTY
// runs, so a fast user cannot type into the attach race and lose bytes.
func (a *attachment) write(p []byte) error {
	if len(p) == 0 {
		return nil
	}
	chunk := append([]byte(nil), p...)

	a.mu.Lock()
	if a.closed || a.exited {
		a.mu.Unlock()
		return errors.New("terminal: attachment closed")
	}
	pty := a.pty
	if pty == nil || !a.inputReady {
		a.pendingInput = append(a.pendingInput, chunk)
		a.mu.Unlock()
		return nil
	}
	a.mu.Unlock()
	_, err := pty.Write(chunk)
	return err
}

// resize records the client's grid and applies it to the live PTY. The size is
// remembered so an attach that is still in flight (or a later re-attach) starts
// at the client's grid instead of the kernel default — the open frame's
// cols/rows land here before the PTY exists.
func (a *attachment) resize(rows, cols uint16) error {
	a.mu.Lock()
	a.rows, a.cols = rows, cols
	pty := a.pty
	a.mu.Unlock()
	if pty == nil {
		return nil
	}
	return pty.Resize(rows, cols)
}

// size returns the client's last requested grid (zero before the first
// open/resize recorded one). The attach path reads it so the Stream starts at
// the client's grid instead of the kernel default.
func (a *attachment) size() (rows, cols uint16) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.rows, a.cols
}

// setPTY publishes a freshly attached Stream and replays the client's last
// requested size onto it (see resize) — the attach already started at the size
// read in run, but a resize frame can land between that read and registration
// here; the replay (Resize) converges the late case.
//
// It returns as soon as the Stream is published so run's copyOut starts
// reading output immediately — the pane's boot output (attach handshake,
// repaint) must never wait on the input hold below. Releasing buffered input
// happens on a separate goroutine gated on inputGate, which is shared across
// every attach of this pane (see Manager.inputGateFor): the gate's timer only
// ever starts on the pane's first successful publish, not on this attempt's
// open request, so a slow Attach or a failed-then-retried attach never lets
// the hold expire early or double-count.
func (a *attachment) setPTY(ctx context.Context, p ports.Stream) bool {
	a.mu.Lock()
	if a.closed || a.exited {
		a.mu.Unlock()
		return false
	}
	a.pty = p
	a.inputReady = false
	rows, cols := a.rows, a.cols
	shouldOpen := !a.opened
	if shouldOpen {
		a.opened = true
	}
	onOpen := a.onOpen
	gate := a.inputGate
	window := a.inputGraceWindow
	a.mu.Unlock()
	if rows > 0 && cols > 0 {
		_ = p.Resize(rows, cols)
	}
	if shouldOpen && onOpen != nil {
		onOpen()
	}

	if gate == nil {
		a.releaseInput(ctx)
		return true
	}
	gate.start(window)
	go a.releaseInputWhenGateOpens(ctx, gate)
	return true
}

// rearmInput re-blocks this ALREADY-ATTACHED client behind a fresh gate,
// because a new agent process has just been launched into the pane it is
// still attached to. A tmux restart replaces the process inside the pane
// without disturbing its attached clients, so no reattach — and therefore no
// setPTY — will happen for this attachment: swapping the gate alone would
// leave inputReady true and let the replacement TUI's first keystrokes race
// raw-mode entry exactly as before. The timer is started here rather than
// deferred to setPTY for the same reason: with a live PTY there is no later
// publish to start it, and an unarmed gate would block input forever.
//
// With no PTY yet (the pane's first launch, armed before any client attached)
// this only records the gate; setPTY starts it on the first successful
// publish, so a slow attach cannot burn the window before the pane is up.
func (a *attachment) rearmInput(ctx context.Context, gate *inputGate, window time.Duration) {
	a.mu.Lock()
	if a.closed || a.exited {
		a.mu.Unlock()
		return
	}
	a.inputGate = gate
	a.inputGraceWindow = window
	a.inputReady = false
	pty := a.pty
	a.mu.Unlock()

	if pty == nil {
		return
	}
	gate.start(window)
	go a.releaseInputWhenGateOpens(ctx, gate)
}

// releaseInputWhenGateOpens waits for the pane's shared gate to open. If ctx
// ends first (daemon shutdown, attachment closed) — wait reports which one
// actually happened — buffered input is abandoned rather than flushed: a
// waiter racing Manager.Close must never forward keystrokes after shutdown
// has started, even though Close cancels the context before it marks every
// attachment closed.
func (a *attachment) releaseInputWhenGateOpens(ctx context.Context, gate *inputGate) {
	if !gate.wait(ctx) {
		return
	}
	a.releaseInput(ctx)
}

// releaseInput drains pendingInput to whatever Stream is currently attached,
// re-reading a.pty fresh before every single write rather than holding one
// Stream reference for the whole drain. That is what makes a Stream swap
// mid-drain (a reattach racing this release) safe: a chunk that fails against
// a Stream this attachment has since moved on from is requeued — not lost, not
// misdelivered — for whichever Stream is current on the next iteration, and a
// genuine write failure against the STILL-current Stream closes it so run's
// blocked copyOut unblocks and the attach loop actually exits instead of
// hanging on a pane this drain has already given up on.
//
// draining (see the field doc) ensures only one such loop runs per attachment
// at a time; a second caller (a fresh setPTY racing this drain) simply returns
// and trusts the active loop to deliver to whatever Stream ends up current.
func (a *attachment) releaseInput(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		a.mu.Lock()
		if a.closed || a.exited || a.draining {
			a.mu.Unlock()
			return
		}
		pty := a.pty
		if pty == nil {
			a.mu.Unlock()
			return
		}
		if len(a.pendingInput) == 0 {
			a.inputReady = true
			a.mu.Unlock()
			return
		}
		chunk := a.pendingInput[0]
		a.pendingInput = a.pendingInput[1:]
		a.draining = true
		a.mu.Unlock()

		_, err := pty.Write(chunk)

		a.mu.Lock()
		a.draining = false
		stillCurrent := a.pty == pty
		cancel := a.cancel
		if err != nil && stillCurrent {
			a.mu.Unlock()
			a.fail("flush pending input: " + err.Error())
			// Cancel run's own loop BEFORE closing the Stream: closing is what
			// wakes copyOut's blocked Read, and run only stops there if ctx is
			// already done by then (shouldStop) — markExited alone only fires
			// onExit, it does not stop run's loop, so without the cancel it
			// would treat this like an ordinary dropped-but-reattachable Stream
			// and try again.
			if cancel != nil {
				cancel()
			}
			_ = pty.Close()
			return
		}
		if err != nil {
			// pty was swapped out from under this write (a reattach raced the
			// drain): the chunk never reached the new Stream, so hand it back
			// to the front of the queue for whichever Stream is current now.
			a.pendingInput = append([][]byte{chunk}, a.pendingInput...)
		}
		a.mu.Unlock()
	}
}

func (a *attachment) clearPTY(p ports.Stream) {
	a.mu.Lock()
	if a.pty == p {
		a.pty = nil
		a.inputReady = false
	}
	a.mu.Unlock()
}

// close detaches this client: stop re-attaching and kill the attach PTY. It
// never touches the runtime session itself, which the mux server keeps alive
// for other clients.
func (a *attachment) close() {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	a.closed = true
	pty := a.pty
	a.pty = nil
	a.inputReady = false
	a.pendingInput = nil
	cancel := a.cancel
	a.mu.Unlock()
	if pty != nil {
		_ = pty.Close()
	}
	if cancel != nil {
		cancel()
	}
}

func (a *attachment) setRunCancel(cancel context.CancelFunc) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return false
	}
	a.cancel = cancel
	return true
}

func (a *attachment) clearRunCancel(cancel context.CancelFunc) {
	a.mu.Lock()
	a.cancel = nil
	a.mu.Unlock()
	cancel()
}

func (a *attachment) isClosed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closed
}

func (a *attachment) shouldStop(ctx context.Context) bool {
	return ctx.Err() != nil || a.isClosed()
}

func (a *attachment) isExited() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.exited
}

// markExited flips the attachment to exited and fires onExit once.
func (a *attachment) markExited() {
	a.mu.Lock()
	if a.exited {
		a.mu.Unlock()
		return
	}
	a.exited = true
	a.mu.Unlock()
	if a.onExit != nil {
		a.onExit()
	}
}

// fail reports an unrecoverable attach error as an exit.
func (a *attachment) fail(reason string) {
	a.log.Warn("terminal attachment failed", "id", a.id, "reason", reason)
	a.markExited()
}
