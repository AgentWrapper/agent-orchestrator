//go:build linux

package metrics

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// cgroupRoot is the cgroup v2 unified hierarchy mount. The PID→cgroup path from
// /proc/<pid>/cgroup is relative to this root.
const cgroupRoot = "/sys/fs/cgroup"

// scopeListTimeout bounds a single tmux list-panes exec so a wedged tmux server
// cannot stall the observer's poll goroutine (the loop is sequential).
const scopeListTimeout = 5 * time.Second

// NewScopeCollector returns the Linux per-session scope collector. It lists
// panes via the tmux binary, resolves each pane PID's cgroup from /proc, and
// reads memory.current from the cgroup v2 hierarchy.
func NewScopeCollector(tmuxBinary string) ScopeCollector {
	if tmuxBinary == "" {
		tmuxBinary = "tmux"
	}
	return cgroupScopeCollector{
		lister:   tmuxPaneLister{binary: tmuxBinary},
		resolver: procCgroupResolver{},
		memory:   cgroupV2MemReader{root: cgroupRoot},
	}
}

// tmuxPaneLister enumerates panes via `tmux list-panes -a`.
type tmuxPaneLister struct{ binary string }

func (t tmuxPaneLister) panes(ctx context.Context) ([]pane, error) {
	// Bound the exec: a hung tmux server must not block the tick forever.
	ctx, cancel := context.WithTimeout(ctx, scopeListTimeout)
	defer cancel()
	// #{session_name} #{pane_pid}: one line per pane across all sessions.
	cmd := exec.CommandContext(ctx, t.binary, "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}")
	out, err := cmd.Output()
	if err != nil {
		// Check the context FIRST: on a deadline hit, CommandContext kills the
		// process, so Wait surfaces an *exec.ExitError ("signal: killed"), not
		// context.DeadlineExceeded — the ExitError branch below would otherwise
		// misclassify a wedged tmux server as "no panes" and silently report a
		// healthy, zombie-free fleet. A cancelled context is a genuine failure.
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		// Distinguish "no server / no sessions" (a nonzero tmux exit, which is
		// normal and means "no panes") from a real failure to run tmux at all
		// (binary missing on PATH, permission denied). The former degrades to
		// zero scopes; the latter is a genuine tick error so the observer does
		// not silently report a healthy, zombie-free fleet when it cannot see
		// tmux.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return nil, nil //nolint:nilerr // nonzero tmux exit == no panes, not a tick failure
		}
		return nil, err
	}
	return parsePaneLines(string(out)), nil
}

// parsePaneLines parses tab-separated "session\tpid" lines into panes, skipping
// malformed rows.
func parsePaneLines(s string) []pane {
	lines := strings.Split(s, "\n")
	panes := make([]pane, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			continue
		}
		panes = append(panes, pane{session: strings.TrimSpace(parts[0]), pid: pid})
	}
	return panes
}

// procCgroupResolver reads the cgroup v2 path from /proc/<pid>/cgroup.
type procCgroupResolver struct{}

func (procCgroupResolver) cgroupOf(pid int) (string, bool) {
	cg, ok := readProcCgroup("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if !ok {
		return "", false
	}
	// Only ao-managed panes live in a per-session tmux-spawn scope. Restricting
	// to that shape excludes a human's own `tmux new` on the same server (which
	// sits in the shared service/session cgroup, not its own scope) so it is
	// neither charged memory nor counted as a zombie.
	if !isManagedScope(cg) {
		return "", false
	}
	return cg, true
}

// managedScopePrefix is the systemd scope-name prefix ao gives each spawned
// tmux session; the pane's cgroup basename is "<prefix><uuid>.scope".
const managedScopePrefix = "tmux-spawn-"

// isManagedScope reports whether a cgroup v2 path is an ao per-session tmux
// scope (…/tmux-spawn-<uuid>.scope).
func isManagedScope(cgroup string) bool {
	base := cgroup
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	return strings.HasPrefix(base, managedScopePrefix) && strings.HasSuffix(base, ".scope")
}

// selfCgroup reads the daemon's own cgroup so Scopes can skip panes that share
// it (i.e. have no per-session scope of their own).
func (procCgroupResolver) selfCgroup() (string, bool) {
	return readProcCgroup("/proc/self/cgroup")
}

// readProcCgroup extracts the cgroup v2 unified path from a /proc/<pid>/cgroup
// file. The v2 line is "0::/user.slice/.../tmux-spawn-<uuid>.scope".
func readProcCgroup(path string) (string, bool) {
	// Build the path with string concat rather than filepath.Join: gocritic's
	// filepathJoin flags a Join arg that itself contains a separator ("/proc"),
	// and /proc paths are always forward-slash on Linux anyway.
	data, err := os.ReadFile(path) //nolint:gosec // fixed /proc path
	if err != nil {
		return "", false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "0::") {
			return strings.TrimPrefix(line, "0::"), true
		}
	}
	return "", false
}

// cgroupV2MemReader reads memory.current for a cgroup path under root.
type cgroupV2MemReader struct{ root string }

func (r cgroupV2MemReader) memBytes(cgroup string) (uint64, bool) {
	// cgroup is an absolute path relative to the unified root ("/user.slice/...").
	path := filepath.Join(r.root, filepath.Clean("/"+cgroup), "memory.current")
	data, err := os.ReadFile(path) //nolint:gosec // path derived from /proc-reported cgroup under a fixed root
	if err != nil {
		return 0, false
	}
	v, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
