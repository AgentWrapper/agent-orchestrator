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
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ShellTerminal is one standalone shell pane. HandleID is the runtime handle
// the terminal mux attaches to — the same opaque id an agent session's pane
// uses, drawn from a separate namespace (see newShellTerminalHandleID).
type ShellTerminal struct {
	HandleID   string           `json:"handleId"`
	ProjectID  domain.ProjectID `json:"projectId,omitempty"`
	SessionID  domain.SessionID `json:"sessionId,omitempty"`
	WorkingDir string           `json:"workingDir"`
	Title      string           `json:"title"`
	CreatedAt  time.Time        `json:"createdAt"`
}

// OpenShellTerminalInput is the request to open a new shell pane. An empty
// ProjectID opens the shell in the daemon's data dir instead of a project root,
// which is what the topbar action does when no project is selected. SessionID
// scopes the shell to an agent session so it appears only in that session's tab
// strip; an empty SessionID makes it a standalone shell on the /terminals screen.
type OpenShellTerminalInput struct {
	ProjectID domain.ProjectID `json:"projectId,omitempty"`
	SessionID domain.SessionID `json:"sessionId,omitempty"`
}

// shellTerminalTitle labels a standalone tab by the directory the shell started
// in. Those shells come from the board or /terminals and can span projects, so
// the directory is what tells them apart. A path with no usable base (a bare
// root, or an empty string) falls back to a generic label rather than
// rendering an empty tab.
func shellTerminalTitle(workingDir string) string {
	base := filepath.Base(workingDir)
	switch base {
	case "", ".", string(filepath.Separator):
		return "Shell"
	}
	return base
}

// sessionShellTerminalTitle numbers a session's tabs instead of naming them.
// Every shell in a session starts in that session's worktree, so the directory
// was identical on every tab and told the user nothing; the session itself is
// already the first tab in the strip. ordinal is 1-based.
func sessionShellTerminalTitle(ordinal int) string {
	return fmt.Sprintf("%s%d", sessionShellTerminalPrefix, ordinal)
}

const sessionShellTerminalPrefix = "Terminal "

// sessionTerminalOrdinal reads back a title this package generated. A title the
// user renamed does not parse and reports false, so it stops reserving a number.
func sessionTerminalOrdinal(title string) (int, bool) {
	rest, found := strings.CutPrefix(title, sessionShellTerminalPrefix)
	if !found {
		return 0, false
	}
	n, err := strconv.Atoi(rest)
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
}
