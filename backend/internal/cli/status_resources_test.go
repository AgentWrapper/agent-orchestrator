package cli

import (
	"strings"
	"testing"
)

func summaryWith(mut func(*metricsSummary)) metricsSummary {
	var m metricsSummary
	m.Latest = &struct {
		Host struct {
			NumCPU            int     `json:"numCpu"`
			LoadKnown         bool    `json:"loadKnown"`
			LoadAvg1          float64 `json:"loadAvg1"`
			MemKnown          bool    `json:"memKnown"`
			MemTotalBytes     uint64  `json:"memTotalBytes"`
			MemAvailableBytes uint64  `json:"memAvailableBytes"`
			DiskKnown         bool    `json:"diskKnown"`
			DiskTotalBytes    uint64  `json:"diskTotalBytes"`
			DiskFreeBytes     uint64  `json:"diskFreeBytes"`
		} `json:"host"`
		Zombies      int  `json:"zombies"`
		ZombiesKnown bool `json:"zombiesKnown"`
		Alerts       []struct {
			Kind string `json:"kind"`
		} `json:"alerts"`
	}{}
	mut(&m)
	return m
}

func TestFormatResourceSummaryFull(t *testing.T) {
	m := summaryWith(func(m *metricsSummary) {
		m.Latest.Host.NumCPU = 8
		m.Latest.Host.LoadKnown = true
		m.Latest.Host.LoadAvg1 = 3.5
		m.Latest.Host.MemKnown = true
		m.Latest.Host.MemTotalBytes = 100
		m.Latest.Host.MemAvailableBytes = 40
		m.Latest.Host.DiskKnown = true
		m.Latest.Host.DiskTotalBytes = 200
		m.Latest.Host.DiskFreeBytes = 30
		m.Latest.Zombies = 2
		m.Latest.ZombiesKnown = true
	})
	got := formatResourceSummary(m)
	for _, want := range []string{"load 3.50/8cpu", "mem 40% free", "disk 15% free", "zombies 2"} {
		if !strings.Contains(got, want) {
			t.Errorf("summary %q missing %q", got, want)
		}
	}
	if strings.Contains(got, "ALERT") {
		t.Errorf("no alerts expected, got %q", got)
	}
}

func TestFormatResourceSummarySkipsUnknownHostFacts(t *testing.T) {
	// Stub/failed collector: only NumCPU + zombies known.
	m := summaryWith(func(m *metricsSummary) {
		m.Latest.Host.NumCPU = 4
		m.Latest.Host.LoadKnown = true
		m.Latest.Host.LoadAvg1 = 1
		m.Latest.Zombies = 0
		m.Latest.ZombiesKnown = true
	})
	got := formatResourceSummary(m)
	if strings.Contains(got, "mem") || strings.Contains(got, "disk") {
		t.Errorf("unknown mem/disk must be omitted, got %q", got)
	}
	if !strings.Contains(got, "zombies 0") {
		t.Errorf("zombies should always show, got %q", got)
	}
}

func TestFormatResourceSummaryUnknownZombies(t *testing.T) {
	m := summaryWith(func(m *metricsSummary) {})
	got := formatResourceSummary(m)
	if !strings.Contains(got, "zombies unknown") {
		t.Errorf("unknown zombies should render explicitly, got %q", got)
	}
}

func TestFormatResourceSummaryWithAlerts(t *testing.T) {
	m := summaryWith(func(m *metricsSummary) {
		m.Latest.Host.NumCPU = 1
		m.Latest.Alerts = []struct {
			Kind string `json:"kind"`
		}{{Kind: "disk_low"}, {Kind: "zombies"}}
	})
	got := formatResourceSummary(m)
	if !strings.Contains(got, "[ALERT: disk_low,zombies]") {
		t.Errorf("alert kinds not rendered, got %q", got)
	}
}
