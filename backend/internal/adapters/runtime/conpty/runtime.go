// runtime.go - conpty Runtime adapter. Implements ports.Runtime and
// ports.Attacher (see attach.go). Drives sessions via the B3 pty-host over
// loopback TCP, using the B1 protocol and the B2 registry for restart recovery.
package conpty

import (
	"context"
	"fmt"
	"regexp"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/conpty/ptyregistry"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Ensure Runtime satisfies the port at compile time (Attach in attach.go).
var _ ports.Runtime = (*Runtime)(nil)

// validSessionID matches agent-orchestrator's assertValidSessionId.
var validSessionID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// hostSession is the in-memory state for a live pty-host connection.
type hostSession struct {
	addr string
	pid  int
}

// Options configures the Runtime. All fields are optional; zero values use
// sensible defaults. The Spawner field is injectable for tests.
type Options struct {
	// Spawner overrides the default OS-level process spawner. If nil,
	// defaultSpawnHost is used (Windows-only; returns an error on other OSes).
	Spawner hostSpawner
}

// Runtime is the conpty runtime adapter.
type Runtime struct {
	spawner hostSpawner

	mu       sync.Mutex
	sessions map[string]*hostSession // sessionID -> live session
}

// New creates a Runtime with the given options.
func New(opts Options) *Runtime {
	sp := opts.Spawner
	if sp == nil {
		sp = defaultSpawnHost
	}
	return &Runtime{
		spawner:  sp,
		sessions: make(map[string]*hostSession),
	}
}

// Create spawns a detached pty-host for the session, waits for READY, stores
// the addr+pid in-memory and in the B2 registry, and returns the handle.
// Returns an error if sessionID is invalid, already exists, or spawn fails.
func (r *Runtime) Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	id := string(cfg.SessionID)
	if !validSessionID.MatchString(id) {
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: invalid session id %q: must match ^[a-zA-Z0-9_-]+$", id)
	}
	if cfg.WorkspacePath == "" {
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: workspace path required")
	}
	if len(cfg.Argv) == 0 {
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: argv required")
	}

	r.mu.Lock()
	if _, dup := r.sessions[id]; dup {
		r.mu.Unlock()
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: session %q already exists; destroy before re-creating", id)
	}
	// Reserve the slot before the async spawn so a concurrent Create for the
	// same id fails immediately (no gap between check and set).
	r.sessions[id] = nil
	r.mu.Unlock()

	addr, pid, err := r.spawner(ctx, id, cfg.WorkspacePath, cfg.Argv, cfg.Env)
	if err != nil {
		r.mu.Lock()
		delete(r.sessions, id)
		r.mu.Unlock()
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: spawn pty-host for %q: %w", id, err)
	}

	sess := &hostSession{addr: addr, pid: pid}

	r.mu.Lock()
	r.sessions[id] = sess
	r.mu.Unlock()

	// Register in B2 registry for daemon-restart recovery (best-effort).
	_ = ptyregistry.Register(ptyregistry.Entry{
		SessionID:    id,
		PtyHostPID:   pid,
		PipePath:     addr, // ponytail: reuse PipePath field for loopback addr
		RegisteredAt: time.Now().UTC().Format(time.RFC3339),
	})

	return ports.RuntimeHandle{ID: id}, nil
}

// Destroy gracefully kills the pty-host, waits up to ~500ms for the pid to
// exit, then force-kills it. Removes the session from the map and the registry.
// Idempotent: unknown/already-gone session returns nil.
func (r *Runtime) Destroy(ctx context.Context, handle ports.RuntimeHandle) error {
	sess := r.resolve(handle.ID)
	if sess == nil {
		return nil // unknown or already gone
	}

	// Ask host to shut down gracefully (triggers shutdown() in Serve).
	_ = clientKill(sess.addr)

	// Poll up to ~500ms (20 x 25ms) for the pty-host pid to exit.
	// ponytail: signal-0 probe; upgrade to process-tree kill if orphan ConPTY
	// helpers appear.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !pidAlive(sess.pid) {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}

	// Best-effort force-kill (the host's graceful shutdown already disposed
	// the ConPTY child; killing the host process is sufficient).
	if p, err := findProcess(sess.pid); err == nil {
		_ = p.Kill()
	}

	r.mu.Lock()
	delete(r.sessions, handle.ID)
	r.mu.Unlock()

	_ = ptyregistry.Unregister(handle.ID)
	return nil
}

// IsAlive distinguishes three outcomes so the reaper never spuriously reaps a
// live session on a transient probe failure:
//
//   - (true, nil):  the pty-host answered a status probe -> alive.
//   - (false, nil): DEFINITIVELY gone. Either the session resolves to nothing
//     (no in-memory entry and no registry entry), or the dial was refused
//     (nothing listening on the loopback addr).
//   - (false, err): a TRANSIENT probe failure (loopback timeout, connected-
//     then-failed I/O). The reaper records ProbeFailed and retries rather than
//     treating it as a death conclusion.
//
// tmux returns a non-nil error for transient failures for the same
// reason; conpty matches that contract here.
func (r *Runtime) IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error) {
	sess := r.resolve(handle.ID)
	if sess == nil {
		return false, nil // no in-memory entry, no registry entry -> definitively gone
	}
	return clientIsAlive(sess.addr)
}

// SendMessage chunks message and writes it to the pty-host followed by Enter.
func (r *Runtime) SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error {
	sess := r.resolve(handle.ID)
	if sess == nil {
		return fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	return clientSendMessage(sess.addr, message)
}

// GetOutput returns the last lines lines from the pty-host ring buffer.
func (r *Runtime) GetOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error) {
	if lines <= 0 {
		return "", fmt.Errorf("conpty: lines must be > 0")
	}
	sess := r.resolve(handle.ID)
	if sess == nil {
		return "", fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	return clientGetOutput(sess.addr, lines)
}

// resolve looks up a session by id: first the in-memory map, then the B2
// registry (for daemon-restart recovery). Returns nil if not found either way.
func (r *Runtime) resolve(id string) *hostSession {
	r.mu.Lock()
	sess := r.sessions[id]
	r.mu.Unlock()
	if sess != nil {
		return sess
	}

	// Registry fallback: scan for the entry by session id.
	entries, err := ptyregistry.List()
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if e.SessionID != id {
			continue
		}
		// Re-populate the map so subsequent calls skip the file scan.
		recovered := &hostSession{addr: e.PipePath, pid: e.PtyHostPID}
		r.mu.Lock()
		// Only store if another goroutine hasn't beaten us.
		if r.sessions[id] == nil {
			r.sessions[id] = recovered
		} else {
			recovered = r.sessions[id]
		}
		r.mu.Unlock()
		return recovered
	}
	return nil
}

// findProcess wraps os.FindProcess to make it swappable in tests.
// ponytail: direct call; no interface needed at this scale.
func findProcess(pid int) (processKiller, error) {
	p, err := osProcessFinder(pid)
	return p, err
}

// processKiller is the subset of *os.Process used by Destroy.
type processKiller interface {
	Kill() error
}

// osProcessFinder is the production implementation; tests may replace it.
// The real defaultOSProcessFinder is in pidalive_unix.go / pidalive_windows.go
// (same files that provide pidAlive).
var osProcessFinder = defaultOSProcessFinder
