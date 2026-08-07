// Package runtimeenv repairs the daemon process's environment so that a daemon
// started outside the Electron launcher (headless `ao start`, systemd, cron, a
// container, or any automation wrapper) can still resolve CLI tools installed
// under Homebrew or /usr/local.
//
// The Electron launcher already does this for the daemons it spawns
// (frontend/src/shared/shell-env.ts: a login-shell probe plus a static PATH
// floor). But that logic lives only in the frontend, so a daemon launched any
// other way inherits a minimal PATH and cannot see, e.g., tmux at
// /opt/homebrew/bin — which makes the spawn gate (validateRuntimePrerequisites)
// fail with "tmux required on macOS/Linux but not in PATH" even though tmux is
// installed. This package ports the static floor to Go so the daemon repairs its
// own PATH at startup. See AgentWrapper/agent-orchestrator#2812.
//
// Scope: this ports only the STATIC floor from shell-env.ts, not its login-shell
// probe ($SHELL -ilc -> env). The floor covers the common Homebrew and
// /usr/local case #2812 reports, but not custom prefixes the Electron probe
// recovers (Nix ~/.nix-profile/bin, asdf/mise shims, or any non-standard dir), so
// a non-Electron daemon remains less PATH-robust than the Electron-launched one
// for those setups. Porting the login-shell probe is a possible future follow-up.
package runtimeenv

import (
	"os"
	"runtime"
	"strings"
)

// FallbackPathDirs mirrors FALLBACK_PATH_DIRS in frontend/src/shared/shell-env.ts:
// the directories a working macOS/Linux box keeps CLI tools in. Kept in sync with
// the frontend list so both launch paths resolve the same tools.
var FallbackPathDirs = []string{
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
}

// WithFallbackPath appends any FallbackPathDirs not already present in path,
// preserving the existing order/priority and de-duplicating. Existing entries
// keep precedence (the user's own PATH wins); floor dirs are only appended, never
// prepended. Empty segments are dropped.
func WithFallbackPath(path string) string {
	sep := string(os.PathListSeparator)
	seen := make(map[string]bool)
	out := make([]string, 0)
	add := func(dir string) {
		if dir == "" || seen[dir] {
			return
		}
		seen[dir] = true
		out = append(out, dir)
	}
	for _, dir := range strings.Split(path, sep) {
		add(dir)
	}
	for _, dir := range FallbackPathDirs {
		add(dir)
	}
	return strings.Join(out, sep)
}

// EnsureFallbackPath repairs the current process's PATH with the floor on
// macOS/Linux. It is a no-op on Windows: the tmux prerequisite gate is
// Windows-exempt and the floor dirs are POSIX paths. Call it once at daemon
// startup, before any exec.LookPath (the tmux prereq gate and the agent-binary
// preflight) runs, so every lookup sees the repaired PATH.
func EnsureFallbackPath() {
	if runtime.GOOS == "windows" {
		return
	}
	_ = os.Setenv("PATH", WithFallbackPath(os.Getenv("PATH")))
}
