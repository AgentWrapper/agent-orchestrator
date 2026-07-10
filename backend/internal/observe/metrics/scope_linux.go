//go:build linux

package metrics

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// cgroupRoot is the cgroup v2 unified hierarchy mount. The PID→cgroup path from
// /proc/<pid>/cgroup is relative to this root.
const cgroupRoot = "/sys/fs/cgroup"

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
	// #{session_name} #{pane_pid}: one line per pane across all sessions.
	cmd := exec.CommandContext(ctx, t.binary, "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}")
	out, err := cmd.Output()
	if err != nil {
		// No server / no sessions is not an error worth failing the tick over:
		// treat it as "no panes" so the observer records zero scopes.
		return nil, nil //nolint:nilerr // a missing tmux server means "no panes", not a tick failure
	}
	return parsePaneLines(string(out)), nil
}

// parsePaneLines parses tab-separated "session\tpid" lines into panes, skipping
// malformed rows.
func parsePaneLines(s string) []pane {
	var panes []pane
	for _, line := range strings.Split(s, "\n") {
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
	// Build the path with string concat rather than filepath.Join: gocritic's
	// filepathJoin flags a Join arg that itself contains a separator ("/proc"),
	// and /proc paths are always forward-slash on Linux anyway.
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if err != nil {
		return "", false
	}
	// cgroup v2 lines look like "0::/user.slice/.../tmux-spawn-<uuid>.scope".
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
