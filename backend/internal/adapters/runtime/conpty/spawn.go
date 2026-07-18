// spawn.go - injectable hostSpawner seam. The real detached-process spawn is
// Windows-only (spawn_windows.go). This file defines the type and the
// defaultSpawnHost variable; the non-windows stub is in spawn_other.go.
package conpty

import (
	"context"
	"path/filepath"
	"strings"
)

// hostSpawner starts a detached pty-host for the session and returns its
// loopback address ("127.0.0.1:PORT") and OS pid once it prints READY.
// Injectable for tests: replace this field on Options before calling New.
type hostSpawner func(ctx context.Context, sessionID, cwd string, argv []string, env map[string]string) (addr string, pid int, err error)

// stripEnvAssignments splits a launch argv that may begin with a Unix-style
// `env NAME=VALUE ...` prefix into the environment assignments ("NAME=VALUE"
// strings) and the real command argv that follows.
//
// Some agent adapters (e.g. opencode) prepend `env KEY=value` to their launch
// command to inject process env vars the CLI has no flag for. That is portable
// on macOS/Linux, where the tmux runtime runs the argv through a shell and the
// `env` coreutil applies the assignments. Windows has no `env` binary and the
// ConPTY pty-host execs argv[0] directly, so the spawner must apply the
// assignments to the child's environment itself — otherwise the launch fails
// with `env: executable file not found`. This mirrors launchBinary in the
// session manager, which already skips the same prefix to validate the real
// binary.
//
// If argv does not start with `env`, or the prefix consumes the whole argv with
// no command left, assignments is nil and rest is argv unchanged (so the
// caller's normal handling still applies).
func stripEnvAssignments(argv []string) (assignments, rest []string) {
	if len(argv) == 0 || filepath.Base(argv[0]) != "env" {
		return nil, argv
	}
	i := 1
	for i < len(argv) && strings.Contains(argv[i], "=") {
		i++
	}
	if i >= len(argv) {
		// Only assignments, no command to run: leave argv untouched so the
		// existing missing-binary path fires instead of silently dropping it.
		return nil, argv
	}
	return argv[1:i], argv[i:]
}
