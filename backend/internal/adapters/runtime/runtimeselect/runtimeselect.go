// Package runtimeselect picks the correct runtime backend by platform:
// tmux on Darwin/Linux, conpty (ConPTY) on Windows.
package runtimeselect

import (
	"context"
	"log/slog"
	"runtime"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/conpty"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Runtime is the union interface that both tmux and conpty satisfy.
// It extends ports.Runtime (Create/Destroy/IsAlive) with the additional methods
// the daemon wires directly, including ports.Attacher (Attach) so the terminal
// layer can open a Stream against the selected runtime.
type Runtime interface {
	ports.Runtime // Create, Destroy, IsAlive
	ports.Attacher
	SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error
	GetOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error)
	// IsRunningCommand is the spawn-time process-health probe. Adapters use the
	// best definitive signal their backend exposes: tmux inspects the pane's
	// process tree (the launcher still parents the agent; the keep-alive shell
	// left after an exit does not), and conpty reads child PTY liveness. The
	// command argument is advisory — tmux ignores it (the process tree is
	// authoritative); it is retained for adapters that can use argv[0].
	IsRunningCommand(ctx context.Context, handle ports.RuntimeHandle, command string) (bool, error)
}

// Compile-time assertions: both adapters must implement the union interface.
var _ Runtime = (*tmux.Runtime)(nil)
var _ Runtime = (*conpty.Runtime)(nil)

// New returns the per-platform runtime: tmux on Darwin/Linux, conpty on Windows.
// log is accepted for signature stability with callers but is currently unused.
func New(_ *slog.Logger) Runtime {
	if runtime.GOOS != "windows" {
		return tmux.New(tmux.Options{})
	}
	return conpty.New(conpty.Options{})
}
