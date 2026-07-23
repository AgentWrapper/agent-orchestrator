// Package shellterm owns standalone shell terminals: PTYs the user opens by
// hand from the desktop app, deliberately NOT bound to any agent session.
//
// Why this is its own package rather than a mode of the session service: a
// shell terminal has no agent, no worktree, no lifecycle state machine, and no
// place on the board. It shares exactly one mechanism with sessions — the
// runtime adapter that knows how to spawn and attach a PTY — and nothing else.
// Keeping it separate is what stops "open a terminal" from having to satisfy
// the session lifecycle's invariants.
//
// It needs no changes to internal/terminal: that package already treats the
// terminal id it is handed as an opaque runtime handle and never resolves it
// against a session, so a shell terminal's handle streams over the existing mux
// unmodified.
package shellterm

import (
	"path/filepath"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ShellTerminal is one standalone shell pane. HandleID is the runtime handle
// the terminal mux attaches to — the same opaque id an agent session's pane
// uses, drawn from a separate namespace (see newShellTerminalHandleID).
type ShellTerminal struct {
	HandleID   string           `json:"handleId"`
	ProjectID  domain.ProjectID `json:"projectId,omitempty"`
	WorkingDir string           `json:"workingDir"`
	Title      string           `json:"title"`
	CreatedAt  time.Time        `json:"createdAt"`
}

// OpenShellTerminalInput is the request to open a new shell pane. An empty
// ProjectID opens the shell in the daemon's data dir instead of a project root,
// which is what the topbar action does when no project is selected.
type OpenShellTerminalInput struct {
	ProjectID domain.ProjectID `json:"projectId,omitempty"`
}

// shellTerminalTitle labels a tab by the directory the shell started in, which
// is the only thing that distinguishes one shell pane from another in the UI.
// A path that has no usable base (a bare root, or an empty string) falls back
// to a generic label rather than rendering an empty tab.
func shellTerminalTitle(workingDir string) string {
	base := filepath.Base(workingDir)
	switch base {
	case "", ".", string(filepath.Separator):
		return "Shell"
	}
	return base
}
