package metrics

import (
	"context"
	"errors"
	"testing"
)

type fakePaneLister struct {
	list []pane
	err  error
}

func (f fakePaneLister) panes(context.Context) ([]pane, error) { return f.list, f.err }

// fakeCgroupResolver maps pid→cgroup path; self is the daemon's own cgroup so
// Scopes can skip panes with no per-session scope of their own.
type fakeCgroupResolver struct {
	byPID map[int]string
	self  string
}

func (f fakeCgroupResolver) cgroupOf(pid int) (string, bool) { v, ok := f.byPID[pid]; return v, ok }
func (f fakeCgroupResolver) selfCgroup() (string, bool) {
	if f.self == "" {
		return "", false
	}
	return f.self, true
}

type fakeMemReader map[string]uint64

func (f fakeMemReader) memBytes(cg string) (uint64, bool) { v, ok := f[cg]; return v, ok }

func TestCgroupScopeCollector(t *testing.T) {
	c := cgroupScopeCollector{
		lister: fakePaneLister{list: []pane{
			{session: "sess-a", pid: 1},
			{session: "sess-a", pid: 2}, // second pane, DISTINCT cgroup → sums
			{session: "sess-b", pid: 3},
			{session: "sess-c", pid: 4}, // pid has no cgroup → skipped
			{session: "sess-d", pid: 5}, // cgroup has no mem → skipped
			{session: "", pid: 6},       // empty session → skipped
		}},
		resolver: fakeCgroupResolver{byPID: map[int]string{1: "/cg1", 2: "/cg2", 3: "/cg3", 5: "/cg5"}},
		memory:   fakeMemReader{"/cg1": 100, "/cg2": 200, "/cg3": 400},
	}
	got, err := c.Scopes(context.Background())
	if err != nil {
		t.Fatalf("Scopes: %v", err)
	}
	if got["sess-a"] != 300 {
		t.Errorf("sess-a spans two distinct cgroups and should sum to 300, got %d", got["sess-a"])
	}
	if got["sess-b"] != 400 {
		t.Errorf("sess-b = %d, want 400", got["sess-b"])
	}
	if _, ok := got["sess-c"]; ok {
		t.Errorf("sess-c has no cgroup and must be skipped, not counted as zero")
	}
	if _, ok := got["sess-d"]; ok {
		t.Errorf("sess-d has no readable mem and must be skipped")
	}
}

// TestCgroupScopeCollectorSharedScopeNotDoubleCounted is the production topology:
// several panes of one session share a single tmux-spawn scope cgroup. The
// session's memory must be that scope's memory.current ONCE, not multiplied by
// the pane count.
func TestCgroupScopeCollectorSharedScopeNotDoubleCounted(t *testing.T) {
	c := cgroupScopeCollector{
		lister: fakePaneLister{list: []pane{
			{session: "sess-a", pid: 1},
			{session: "sess-a", pid: 2}, // same session
			{session: "sess-a", pid: 3}, // same session, all share one scope
		}},
		resolver: fakeCgroupResolver{byPID: map[int]string{
			1: "/scope-a", 2: "/scope-a", 3: "/scope-a",
		}},
		memory: fakeMemReader{"/scope-a": 500},
	}
	got, err := c.Scopes(context.Background())
	if err != nil {
		t.Fatalf("Scopes: %v", err)
	}
	if got["sess-a"] != 500 {
		t.Errorf("shared scope must be charged once (500), got %d (double-count?)", got["sess-a"])
	}
}

// TestCgroupScopeCollectorSkipsDaemonCgroup: a pane resolving to the daemon's
// own cgroup has no per-session scope and must not be charged the whole daemon's
// memory.
func TestCgroupScopeCollectorSkipsDaemonCgroup(t *testing.T) {
	c := cgroupScopeCollector{
		lister: fakePaneLister{list: []pane{
			{session: "sess-a", pid: 1}, // shares daemon cgroup → skipped
			{session: "sess-b", pid: 2}, // real per-session scope → counted
		}},
		resolver: fakeCgroupResolver{
			byPID: map[int]string{1: "/ao.service", 2: "/scope-b"},
			self:  "/ao.service",
		},
		memory: fakeMemReader{"/ao.service": 3_000_000, "/scope-b": 200},
	}
	got, err := c.Scopes(context.Background())
	if err != nil {
		t.Fatalf("Scopes: %v", err)
	}
	if _, ok := got["sess-a"]; ok {
		t.Errorf("sess-a shares the daemon cgroup and must be skipped, got %d", got["sess-a"])
	}
	if got["sess-b"] != 200 {
		t.Errorf("sess-b = %d, want 200", got["sess-b"])
	}
}

func TestCgroupScopeCollectorListerError(t *testing.T) {
	c := cgroupScopeCollector{
		lister:   fakePaneLister{err: errors.New("boom")},
		resolver: fakeCgroupResolver{},
		memory:   fakeMemReader{},
	}
	if _, err := c.Scopes(context.Background()); err == nil {
		t.Fatal("want error from lister propagated")
	}
}

func TestCgroupScopeCollectorNilDepsNoError(t *testing.T) {
	var c cgroupScopeCollector // all nil
	got, err := c.Scopes(context.Background())
	if err != nil || len(got) != 0 {
		t.Fatalf("nil-dep collector must return empty, no error; got %+v %v", got, err)
	}
}
