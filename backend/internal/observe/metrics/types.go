// Package metrics implements the daemon resource observer: a coarse-tick poller
// that collects host load/memory/disk, per-session cgroup-scope memory,
// per-project session/zombie counts, and token/cost aggregates, then exposes a
// JSON snapshot (with a short history) and emits threshold-crossing alerts that
// downstream sinks (Slack notifier, ao status) consume.
//
// The package is deliberately provider-agnostic and cross-platform: collection
// is behind small interfaces so tests inject fake cgroup/telemetry fixtures, and
// the concrete host/scope collectors have Linux implementations plus no-op stubs
// elsewhere so the Windows build keeps compiling. It never mutates daemon state;
// it only reports facts.
package metrics

import "time"

// Snapshot is one full resource observation. It is the wire shape returned by
// GET /api/v1/metrics (latest) and stored in the observer's bounded history.
type Snapshot struct {
	// CollectedAt is when the snapshot was produced (UTC).
	CollectedAt time.Time `json:"collectedAt"`
	// Host holds machine-wide load, memory, and disk facts.
	Host Host `json:"host"`
	// Projects holds per-project session and zombie counts.
	Projects []Project `json:"projects"`
	// Scopes holds per-session-scope memory readings (one per live tmux scope
	// cgroup). Empty on platforms/hosts without cgroup-per-session scopes.
	Scopes []Scope `json:"scopes"`
	// Zombies is the machine-wide count of live runtime sessions with no
	// matching non-terminated session row (leaked tmux / orphaned processes).
	Zombies int `json:"zombies"`
	// Cost holds token/cost aggregates over the configured rolling window.
	Cost Cost `json:"cost"`
	// Alerts holds the alert conditions currently firing at snapshot time.
	Alerts []Alert `json:"alerts"`

	// zombiesKnown reports whether the live session set was trustworthy when this
	// snapshot was built. It is internal evaluator state (not serialized): when
	// false, Zombies is not authoritative and the zombie alert holds its sustain
	// counter rather than treating the tick as zero zombies.
	zombiesKnown bool
}

// Host is machine-wide resource pressure. Zero values mean "not collected"
// (e.g. a collector that failed or a platform stub), which callers treat as
// unknown rather than as a threshold crossing.
type Host struct {
	// NumCPU is the logical CPU count used to normalise loadavg per core.
	NumCPU int `json:"numCpu"`
	// LoadAvg1/5/15 are the 1/5/15-minute run-queue load averages.
	LoadAvg1  float64 `json:"loadAvg1"`
	LoadAvg5  float64 `json:"loadAvg5"`
	LoadAvg15 float64 `json:"loadAvg15"`
	// MemTotalBytes/MemAvailableBytes describe physical memory headroom.
	MemTotalBytes     uint64 `json:"memTotalBytes"`
	MemAvailableBytes uint64 `json:"memAvailableBytes"`
	// DiskTotalBytes/DiskFreeBytes describe free space on the data-dir volume.
	DiskTotalBytes uint64 `json:"diskTotalBytes"`
	DiskFreeBytes  uint64 `json:"diskFreeBytes"`
}

// LoadPerCore returns the 1-minute loadavg normalised by CPU count. It returns
// 0 when the CPU count is unknown so a missing collector never trips a
// per-core threshold.
func (h Host) LoadPerCore() float64 {
	if h.NumCPU <= 0 {
		return 0
	}
	return h.LoadAvg1 / float64(h.NumCPU)
}

// MemAvailablePercent returns available memory as a percent of total, or 0 when
// total is unknown.
func (h Host) MemAvailablePercent() float64 {
	if h.MemTotalBytes == 0 {
		return 0
	}
	return 100 * float64(h.MemAvailableBytes) / float64(h.MemTotalBytes)
}

// DiskFreePercent returns free disk as a percent of total, or 0 when total is
// unknown.
func (h Host) DiskFreePercent() float64 {
	if h.DiskTotalBytes == 0 {
		return 0
	}
	return 100 * float64(h.DiskFreeBytes) / float64(h.DiskTotalBytes)
}

// Project holds per-project session counts by derived activity. Zombie
// attribution is machine-wide (Snapshot.Zombies), not per-project.
type Project struct {
	// ProjectID is the project the counts belong to.
	ProjectID string `json:"projectId"`
	// Sessions is the total number of non-terminated sessions in the project.
	Sessions int `json:"sessions"`
	// ByActivity counts non-terminated sessions by their persisted activity
	// state (active, idle, waiting_input, blocked, exited).
	ByActivity map[string]int `json:"byActivity"`
}

// Scope is a single per-session cgroup-scope memory reading.
type Scope struct {
	// SessionID is the ao session id the scope maps to, when a live session row
	// matches the scope's runtime handle; empty for an unmatched (zombie) scope.
	SessionID string `json:"sessionId,omitempty"`
	// Name is the scope/cgroup identifier (e.g. the tmux session name embedded
	// in tmux-spawn-<uuid>.scope, or the runtime handle id).
	Name string `json:"name"`
	// MemBytes is the current memory charge of the scope's cgroup.
	MemBytes uint64 `json:"memBytes"`
	// Matched reports whether the scope maps to a live session row.
	Matched bool `json:"matched"`
}

// Cost holds token/cost aggregates derived from telemetry events over the
// observer's rolling window.
type Cost struct {
	// WindowSeconds is the length of the rolling aggregation window.
	WindowSeconds int64 `json:"windowSeconds"`
	// InputTokens/OutputTokens/TotalTokens sum the matching numeric payload
	// fields across telemetry events in the window.
	InputTokens  int64 `json:"inputTokens"`
	OutputTokens int64 `json:"outputTokens"`
	TotalTokens  int64 `json:"totalTokens"`
	// CostUSD sums the cost_usd payload field across events in the window.
	CostUSD float64 `json:"costUsd"`
	// Events is the number of cost-bearing telemetry events aggregated in the
	// window (events carrying at least one recognised token/cost field).
	Events int64 `json:"events"`
	// Truncated is true when the window held more telemetry rows than the scan
	// limit, so the aggregate covers only the most recent costScanLimit events.
	Truncated bool `json:"truncated"`
}
