package metrics

import "context"

// pane is one tmux pane: which session it belongs to and its leaf process PID.
// The observer maps a pane's PID to its cgroup scope to charge memory to the
// owning ao session (the tmux session name equals the ao session id).
type pane struct {
	session string
	pid     int
}

// paneLister enumerates the current tmux panes. Injected so tests can supply a
// fixed set without a live tmux server.
type paneLister interface {
	panes(ctx context.Context) ([]pane, error)
}

// cgroupResolver maps a PID to its cgroup path. Injected so tests can bypass
// /proc.
type cgroupResolver interface {
	cgroupOf(pid int) (string, bool)
}

// cgroupMemReader reads the current memory charge (bytes) of a cgroup path.
// Injected so tests can bypass the /sys/fs/cgroup hierarchy.
type cgroupMemReader interface {
	memBytes(cgroup string) (uint64, bool)
}

// cgroupScopeCollector combines a pane lister, a PID→cgroup resolver, and a
// cgroup memory reader into a ScopeCollector. It is fully platform-independent
// and unit-tested with fakes; the OS-specific wiring lives in the *_linux build.
type cgroupScopeCollector struct {
	lister   paneLister
	resolver cgroupResolver
	memory   cgroupMemReader
}

// Scopes returns per-session memory keyed by tmux session name. Panes whose PID
// has no resolvable cgroup or no readable memory charge are skipped rather than
// counted as zero, so an unreadable scope does not masquerade as an idle one.
// When a session has multiple panes their charges sum.
func (c cgroupScopeCollector) Scopes(ctx context.Context) (map[string]uint64, error) {
	if c.lister == nil || c.resolver == nil || c.memory == nil {
		return map[string]uint64{}, nil
	}
	panes, err := c.lister.panes(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]uint64{}
	for _, p := range panes {
		if p.session == "" || p.pid <= 0 {
			continue
		}
		cg, ok := c.resolver.cgroupOf(p.pid)
		if !ok {
			continue
		}
		mem, ok := c.memory.memBytes(cg)
		if !ok {
			continue
		}
		out[p.session] += mem
	}
	return out, nil
}
