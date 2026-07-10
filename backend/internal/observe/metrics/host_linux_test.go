//go:build linux

package metrics

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTemp(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return p
}

func TestReadLoadAvg(t *testing.T) {
	p := writeTemp(t, "loadavg", "0.50 1.25 2.00 1/234 5678\n")
	l1, l5, l15, err := readLoadAvg(p)
	if err != nil {
		t.Fatalf("readLoadAvg: %v", err)
	}
	if l1 != 0.50 || l5 != 1.25 || l15 != 2.00 {
		t.Errorf("got %v %v %v", l1, l5, l15)
	}
}

func TestReadLoadAvgMalformed(t *testing.T) {
	p := writeTemp(t, "loadavg", "garbage\n")
	if _, _, _, err := readLoadAvg(p); err == nil {
		t.Fatal("want error on malformed loadavg")
	}
}

func TestReadMemInfo(t *testing.T) {
	p := writeTemp(t, "meminfo", "MemTotal:       16384 kB\nMemFree:  1000 kB\nMemAvailable:    8192 kB\n")
	total, avail, err := readMemInfo(p)
	if err != nil {
		t.Fatalf("readMemInfo: %v", err)
	}
	if total != 16384*1024 {
		t.Errorf("total = %d, want %d", total, 16384*1024)
	}
	if avail != 8192*1024 {
		t.Errorf("avail = %d, want %d", avail, 8192*1024)
	}
}

func TestReadMemInfoMissingTotal(t *testing.T) {
	p := writeTemp(t, "meminfo", "MemFree:  1000 kB\n")
	if _, _, err := readMemInfo(p); err == nil {
		t.Fatal("want error when MemTotal missing")
	}
}

func TestReadDiskFree(t *testing.T) {
	total, free, err := readDiskFree(t.TempDir())
	if err != nil {
		t.Fatalf("readDiskFree: %v", err)
	}
	if total == 0 {
		t.Error("expected nonzero total on a real filesystem")
	}
	if free > total {
		t.Errorf("free %d > total %d", free, total)
	}
}

func TestReadDiskFreeEmptyPath(t *testing.T) {
	if _, _, err := readDiskFree(""); err == nil {
		t.Fatal("want error on empty path")
	}
}

func TestLinuxHostCollectorPopulatesCPU(t *testing.T) {
	h, _ := NewHostCollector(t.TempDir()).Host(nil)
	if h.NumCPU <= 0 {
		t.Errorf("NumCPU should be populated, got %d", h.NumCPU)
	}
}

func TestParsePaneLines(t *testing.T) {
	panes := parsePaneLines("sess-a\t100\nsess-b\t200\nmalformed\nsess-c\tnotanumber\n\n")
	if len(panes) != 2 {
		t.Fatalf("want 2 valid panes, got %+v", panes)
	}
	if panes[0].session != "sess-a" || panes[0].pid != 100 {
		t.Errorf("pane 0 wrong: %+v", panes[0])
	}
	if panes[1].session != "sess-b" || panes[1].pid != 200 {
		t.Errorf("pane 1 wrong: %+v", panes[1])
	}
}
