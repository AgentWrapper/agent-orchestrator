package metrics

import (
	"fmt"
	"sort"
)

// AlertKind identifies a resource-pressure condition the observer tracks.
type AlertKind string

const (
	// AlertDiskLow fires when free disk on the data-dir volume drops below the
	// configured percent.
	AlertDiskLow AlertKind = "disk_low"
	// AlertMemLow fires when available memory drops below the configured percent.
	AlertMemLow AlertKind = "mem_low"
	// AlertLoadHigh fires when per-core loadavg exceeds the configured ratio.
	AlertLoadHigh AlertKind = "load_high"
	// AlertZombies fires when the machine-wide zombie count stays above zero for
	// the configured number of consecutive ticks.
	AlertZombies AlertKind = "zombies"
)

// Severity is the alert severity level.
type Severity string

const (
	// SeverityWarn is the only level the observer emits today; it is explicit so
	// the wire shape can carry richer levels later without a breaking change.
	SeverityWarn Severity = "warn"
)

// Alert is one firing resource-pressure condition at snapshot time.
type Alert struct {
	// Kind is the condition that tripped.
	Kind AlertKind `json:"kind"`
	// Severity is the alert level.
	Severity Severity `json:"severity"`
	// Message is a human-readable one-line summary.
	Message string `json:"message"`
	// Value is the measured value that tripped the threshold.
	Value float64 `json:"value"`
	// Threshold is the configured limit the value crossed.
	Threshold float64 `json:"threshold"`
}

// AlertTransition is an alert crossing a state boundary: firing when it was
// clear, or clearing when it was firing. The observer emits one notification
// per transition, never one per tick, so a sustained condition is not a
// notification storm.
type AlertTransition struct {
	// Alert is the alert at the moment of transition. For a clear transition the
	// Value reflects the reading that ended the condition.
	Alert Alert
	// Firing is true for an enter (clear→firing) transition and false for an
	// exit (firing→clear) transition.
	Firing bool
}

// Thresholds holds the alerting limits. A zero field disables that specific
// alert, matching the "0 disables" convention used across daemon config.
type Thresholds struct {
	// DiskFreePercent fires disk_low when free disk drops below this percent.
	DiskFreePercent float64
	// MemAvailablePercent fires mem_low when available memory drops below this
	// percent.
	MemAvailablePercent float64
	// LoadPerCore fires load_high when 1-min loadavg per core exceeds this ratio.
	LoadPerCore float64
	// ZombieSustainTicks is how many consecutive ticks the zombie count must stay
	// above zero before zombies fires. <=0 disables the zombie alert.
	ZombieSustainTicks int
}

// evaluator is the stateful threshold machine. It converts a stream of
// snapshots into a stable set of firing alerts plus the transitions between
// ticks, applying the zombie sustain count so a single-tick blip does not fire.
type evaluator struct {
	th      Thresholds
	firing  map[AlertKind]Alert
	zombieN int
}

func newEvaluator(th Thresholds) *evaluator {
	return &evaluator{th: th, firing: map[AlertKind]Alert{}}
}

// evaluate folds one snapshot into the machine, returning the currently-firing
// alerts (sorted by kind for stable output) and the transitions since the prior
// tick. It reads only host/zombie facts already present on the snapshot.
func (e *evaluator) evaluate(s Snapshot) ([]Alert, []AlertTransition) {
	next := map[AlertKind]Alert{}

	// disk_low: when disk facts are unknown this tick, carry the prior state so
	// a transient statfs failure cannot emit a false recovery transition.
	if e.th.DiskFreePercent > 0 {
		if !s.Host.DiskKnown {
			carryPrior(next, e.firing, AlertDiskLow)
		} else if s.Host.DiskTotalBytes > 0 {
			if pct := s.Host.DiskFreePercent(); pct < e.th.DiskFreePercent {
				next[AlertDiskLow] = Alert{
					Kind: AlertDiskLow, Severity: SeverityWarn, Value: pct, Threshold: e.th.DiskFreePercent,
					Message: fmt.Sprintf("disk free %.1f%% below %.1f%% on data volume", pct, e.th.DiskFreePercent),
				}
			}
		}
	}

	// mem_low: when memory facts are unknown this tick, carry the prior state.
	if e.th.MemAvailablePercent > 0 {
		if !s.Host.MemKnown {
			carryPrior(next, e.firing, AlertMemLow)
		} else if s.Host.MemTotalBytes > 0 {
			if pct := s.Host.MemAvailablePercent(); pct < e.th.MemAvailablePercent {
				next[AlertMemLow] = Alert{
					Kind: AlertMemLow, Severity: SeverityWarn, Value: pct, Threshold: e.th.MemAvailablePercent,
					Message: fmt.Sprintf("memory available %.1f%% below %.1f%%", pct, e.th.MemAvailablePercent),
				}
			}
		}
	}

	// load_high: when load facts are unknown this tick, carry the prior state.
	if e.th.LoadPerCore > 0 {
		if !s.Host.LoadKnown {
			carryPrior(next, e.firing, AlertLoadHigh)
		} else if s.Host.NumCPU > 0 {
			if lpc := s.Host.LoadPerCore(); lpc > e.th.LoadPerCore {
				next[AlertLoadHigh] = Alert{
					Kind: AlertLoadHigh, Severity: SeverityWarn, Value: lpc, Threshold: e.th.LoadPerCore,
					Message: fmt.Sprintf("load per core %.2f above %.2f", lpc, e.th.LoadPerCore),
				}
			}
		}
	}

	// zombies: sustained above zero for ZombieSustainTicks consecutive ticks.
	// When the zombie count is not authoritative this tick (session set unknown,
	// e.g. a DB read failed), we neither advance nor reset the sustain counter
	// and carry the prior firing state forward, so a transient outage does not
	// fabricate — or spuriously clear — a fleet-wide leak alert.
	if e.th.ZombieSustainTicks > 0 {
		if !s.ZombiesKnown {
			carryPrior(next, e.firing, AlertZombies)
		} else {
			if s.Zombies > 0 {
				e.zombieN++
			} else {
				e.zombieN = 0
			}
			if e.zombieN >= e.th.ZombieSustainTicks {
				next[AlertZombies] = Alert{
					Kind: AlertZombies, Severity: SeverityWarn,
					// Value is the zombie count; Threshold carries the sustain-tick
					// requirement so consumers rendering "value above threshold" do
					// not print "N above 0".
					Value: float64(s.Zombies), Threshold: float64(e.th.ZombieSustainTicks),
					Message: fmt.Sprintf("%d zombie session(s) for %d consecutive ticks", s.Zombies, e.zombieN),
				}
			}
		}
	}

	transitions := e.diff(next)
	e.firing = next
	return sortedAlerts(next), transitions
}

// diff computes enter/exit transitions between the previous firing set and next.
func (e *evaluator) diff(next map[AlertKind]Alert) []AlertTransition {
	var out []AlertTransition
	for kind, a := range next {
		if _, was := e.firing[kind]; !was {
			out = append(out, AlertTransition{Alert: a, Firing: true})
		}
	}
	for kind, a := range e.firing {
		if _, still := next[kind]; !still {
			cleared := a
			out = append(out, AlertTransition{Alert: cleared, Firing: false})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Alert.Kind != out[j].Alert.Kind {
			return out[i].Alert.Kind < out[j].Alert.Kind
		}
		return out[i].Firing && !out[j].Firing
	})
	return out
}

func sortedAlerts(m map[AlertKind]Alert) []Alert {
	out := make([]Alert, 0, len(m))
	for _, a := range m {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Kind < out[j].Kind })
	return out
}

func carryPrior(next, firing map[AlertKind]Alert, kind AlertKind) {
	if prev, ok := firing[kind]; ok {
		next[kind] = prev
	}
}
