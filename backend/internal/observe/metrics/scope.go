package metrics

import (
	"context"
	"log/slog"
)

// pane is one tmux pane: which session it belongs to and its leaf process PID.
// The observer maps a pane's PID to its cgroup scope to charge memory to the
// owning ao session (the tmux session name is the runtime handle id stored on
// the ao session row).
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
	// selfCgroup returns the daemon's own cgroup path. A pane resolving to this
	// path has no per-session scope of its own, so charging it would attribute
	// the whole daemon's memory to that session; Scopes skips such panes.
	selfCgroup() (string, bool)
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
	// logger surfaces the all-dropped diagnostic; nil falls back to slog.Default.
	logger *slog.Logger
}

// Scopes returns per-session memory keyed by tmux session name. The boolean is
// false when panes were visible but none resolved to a managed per-session
// cgroup, which means zombie detection is unavailable rather than known-zero.
//
// A cgroup's memory charge is counted at most once per session. tmux commonly
// creates one systemd scope per spawned pane; several panes can still resolve to
// the same cgroup in tests or alternate launch topologies, so charging every
// pane's cgroup separately could multiply the session's memory by its pane
// count. We track the set of already-charged cgroup paths per session and add a
// cgroup's memory.current only the first time we see it for that session. A
// session that legitimately spans distinct cgroups still sums, because each
// distinct path is charged exactly once.
//
// Panes whose PID has no resolvable cgroup or no readable memory charge are
// skipped rather than counted as zero, so an unreadable scope does not
// masquerade as an idle one. A pane sharing the daemon's own cgroup (no
// per-session scope) is skipped, since counting it would charge the entire
// daemon's memory to that session.
func (c cgroupScopeCollector) Scopes(ctx context.Context) (map[string]uint64, bool, error) {
	if c.lister == nil || c.resolver == nil || c.memory == nil {
		return map[string]uint64{}, false, nil
	}
	panes, err := c.lister.panes(ctx)
	if err != nil {
		return nil, false, err
	}
	selfCg, haveSelf := c.resolver.selfCgroup()
	out := map[string]uint64{}
	// charged[session] is the set of cgroup paths already counted for a session,
	// so a shared scope observed through several panes is not double-counted.
	charged := map[string]map[string]struct{}{}
	for _, p := range panes {
		if p.session == "" || p.pid <= 0 {
			continue
		}
		cg, ok := c.resolver.cgroupOf(p.pid)
		if !ok {
			continue
		}
		if haveSelf && cg == selfCg {
			// No per-session scope: this pane sits in the daemon's own cgroup.
			continue
		}
		seen := charged[p.session]
		if seen == nil {
			seen = map[string]struct{}{}
			charged[p.session] = seen
		}
		if _, dup := seen[cg]; dup {
			continue
		}
		mem, ok := c.memory.memBytes(cg)
		if !ok {
			continue
		}
		seen[cg] = struct{}{}
		out[p.session] += mem
	}
	// Surface a silent all-drop: panes were visible but none mapped to a managed
	// per-session scope (e.g. a host where ao does not wrap tmux in systemd
	// scopes). Without this the observer would report zero scopes / zero zombies
	// indistinguishably from a genuinely healthy, empty fleet.
	if len(panes) > 0 && len(out) == 0 {
		lg := c.logger
		if lg == nil {
			lg = slog.Default()
		}
		lg.Warn("metrics observer: tmux panes present but no managed per-session scope resolved; per-session memory and zombie detection unavailable this tick", "panes", len(panes))
		return out, false, nil
	}
	return out, true, nil
}
