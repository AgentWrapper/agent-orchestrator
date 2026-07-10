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

type fakeCgroupResolver map[int]string

func (f fakeCgroupResolver) cgroupOf(pid int) (string, bool) { v, ok := f[pid]; return v, ok }

type fakeMemReader map[string]uint64

func (f fakeMemReader) memBytes(cg string) (uint64, bool) { v, ok := f[cg]; return v, ok }

func TestCgroupScopeCollector(t *testing.T) {
	c := cgroupScopeCollector{
		lister: fakePaneLister{list: []pane{
			{session: "sess-a", pid: 1},
			{session: "sess-a", pid: 2}, // second pane in same session → sums
			{session: "sess-b", pid: 3},
			{session: "sess-c", pid: 4}, // pid has no cgroup → skipped
			{session: "sess-d", pid: 5}, // cgroup has no mem → skipped
			{session: "", pid: 6},       // empty session → skipped
		}},
		resolver: fakeCgroupResolver{1: "/cg1", 2: "/cg2", 3: "/cg3", 5: "/cg5"},
		memory:   fakeMemReader{"/cg1": 100, "/cg2": 200, "/cg3": 400},
	}
	got, err := c.Scopes(context.Background())
	if err != nil {
		t.Fatalf("Scopes: %v", err)
	}
	if got["sess-a"] != 300 {
		t.Errorf("sess-a should sum both panes to 300, got %d", got["sess-a"])
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
