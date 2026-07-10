package metrics

import "testing"

func TestEvaluatorFiresAndClearsOnTransition(t *testing.T) {
	e := newEvaluator(Thresholds{DiskFreePercent: 10})

	// Below threshold → fire once.
	alerts, tr := e.evaluate(Snapshot{Host: Host{DiskKnown: true, DiskTotalBytes: 100, DiskFreeBytes: 5}})
	if len(alerts) != 1 || alerts[0].Kind != AlertDiskLow {
		t.Fatalf("want disk_low firing, got %+v", alerts)
	}
	if len(tr) != 1 || !tr[0].Firing || tr[0].Alert.Kind != AlertDiskLow {
		t.Fatalf("want one firing transition, got %+v", tr)
	}

	// Still below → firing, but NO new transition (dedupe on state, not tick).
	_, tr = e.evaluate(Snapshot{Host: Host{DiskKnown: true, DiskTotalBytes: 100, DiskFreeBytes: 6}})
	if len(tr) != 0 {
		t.Fatalf("want no transition while sustained, got %+v", tr)
	}

	// Recovered → clear transition.
	alerts, tr = e.evaluate(Snapshot{Host: Host{DiskKnown: true, DiskTotalBytes: 100, DiskFreeBytes: 50}})
	if len(alerts) != 0 {
		t.Fatalf("want no firing alerts after recovery, got %+v", alerts)
	}
	if len(tr) != 1 || tr[0].Firing {
		t.Fatalf("want one clear transition, got %+v", tr)
	}
}

func TestEvaluatorZeroThresholdDisables(t *testing.T) {
	e := newEvaluator(Thresholds{}) // all zero → everything disabled
	alerts, tr := e.evaluate(Snapshot{
		Host:    Host{DiskKnown: true, DiskTotalBytes: 100, DiskFreeBytes: 1, MemKnown: true, MemTotalBytes: 100, MemAvailableBytes: 1, LoadKnown: true, NumCPU: 1, LoadAvg1: 99},
		Zombies: 5,
	})
	if len(alerts) != 0 || len(tr) != 0 {
		t.Fatalf("zero thresholds must disable all alerts, got alerts=%+v tr=%+v", alerts, tr)
	}
}

func TestEvaluatorIgnoresUnknownHostFacts(t *testing.T) {
	// Thresholds set, but the host facts are zero (stub / failed collector).
	e := newEvaluator(Thresholds{DiskFreePercent: 10, MemAvailablePercent: 10, LoadPerCore: 1})
	alerts, tr := e.evaluate(Snapshot{}) // all host zero
	if len(alerts) != 0 || len(tr) != 0 {
		t.Fatalf("unknown host facts must not trip thresholds, got alerts=%+v tr=%+v", alerts, tr)
	}
}

func TestEvaluatorUnknownHostFactsHoldFiringAlerts(t *testing.T) {
	e := newEvaluator(Thresholds{DiskFreePercent: 10, MemAvailablePercent: 10, LoadPerCore: 1})
	alerts, tr := e.evaluate(Snapshot{Host: Host{
		DiskKnown: true, DiskTotalBytes: 100, DiskFreeBytes: 5,
		MemKnown: true, MemTotalBytes: 100, MemAvailableBytes: 5,
		LoadKnown: true, NumCPU: 1, LoadAvg1: 2,
	}})
	if len(alerts) != 3 || len(tr) != 3 {
		t.Fatalf("want three firing alerts, got alerts=%+v tr=%+v", alerts, tr)
	}

	alerts, tr = e.evaluate(Snapshot{Host: Host{NumCPU: 1}})
	if len(alerts) != 3 {
		t.Fatalf("unknown host facts must hold prior firing alerts, got %+v", alerts)
	}
	if len(tr) != 0 {
		t.Fatalf("unknown host facts must not emit false clear transitions, got %+v", tr)
	}
}

func TestEvaluatorZombieSustain(t *testing.T) {
	e := newEvaluator(Thresholds{ZombieSustainTicks: 2})

	// Tick 1: zombies>0 but not yet sustained.
	alerts, tr := e.evaluate(Snapshot{Zombies: 1, ZombiesKnown: true})
	if len(alerts) != 0 || len(tr) != 0 {
		t.Fatalf("first zombie tick must not fire, got alerts=%+v tr=%+v", alerts, tr)
	}

	// Tick 2: sustained → fire.
	alerts, tr = e.evaluate(Snapshot{Zombies: 3, ZombiesKnown: true})
	if len(alerts) != 1 || alerts[0].Kind != AlertZombies {
		t.Fatalf("second zombie tick must fire, got %+v", alerts)
	}
	if alerts[0].Value != 3 || alerts[0].Threshold != 2 {
		t.Fatalf("zombie alert must carry Value=count(3) Threshold=sustainTicks(2), got value=%v threshold=%v", alerts[0].Value, alerts[0].Threshold)
	}
	if len(tr) != 1 || !tr[0].Firing {
		t.Fatalf("want firing transition, got %+v", tr)
	}

	// Tick 3: back to zero → clear and reset counter.
	alerts, tr = e.evaluate(Snapshot{Zombies: 0, ZombiesKnown: true})
	if len(alerts) != 0 {
		t.Fatalf("want cleared, got %+v", alerts)
	}
	if len(tr) != 1 || tr[0].Firing {
		t.Fatalf("want clear transition, got %+v", tr)
	}
	if e.zombieN != 0 {
		t.Fatalf("zombie counter must reset to 0, got %d", e.zombieN)
	}
}

func TestEvaluatorZombieBlipDoesNotFire(t *testing.T) {
	e := newEvaluator(Thresholds{ZombieSustainTicks: 2})
	// One tick of zombies then gone: never reaches the sustain count.
	if _, tr := e.evaluate(Snapshot{Zombies: 1, ZombiesKnown: true}); len(tr) != 0 {
		t.Fatalf("blip tick 1 must not fire, got %+v", tr)
	}
	if _, tr := e.evaluate(Snapshot{Zombies: 0, ZombiesKnown: true}); len(tr) != 0 {
		t.Fatalf("blip cleared before sustain must produce no transition, got %+v", tr)
	}
}

func TestEvaluatorMultipleSimultaneousAlerts(t *testing.T) {
	e := newEvaluator(Thresholds{DiskFreePercent: 10, MemAvailablePercent: 10, LoadPerCore: 1})
	alerts, tr := e.evaluate(Snapshot{Host: Host{
		DiskKnown: true, DiskTotalBytes: 100, DiskFreeBytes: 1,
		MemKnown: true, MemTotalBytes: 100, MemAvailableBytes: 1,
		LoadKnown: true, NumCPU: 2, LoadAvg1: 8, // 4 per core > 1
	}})
	if len(alerts) != 3 {
		t.Fatalf("want 3 firing alerts, got %+v", alerts)
	}
	// Sorted by kind for stable output.
	if alerts[0].Kind != AlertDiskLow || alerts[1].Kind != AlertLoadHigh || alerts[2].Kind != AlertMemLow {
		t.Fatalf("alerts not sorted by kind: %+v", alerts)
	}
	if len(tr) != 3 {
		t.Fatalf("want 3 firing transitions, got %+v", tr)
	}
}

func TestHostDerivedPercents(t *testing.T) {
	h := Host{NumCPU: 4, LoadAvg1: 8, MemTotalBytes: 1000, MemAvailableBytes: 250, DiskTotalBytes: 200, DiskFreeBytes: 50}
	if got := h.LoadPerCore(); got != 2 {
		t.Errorf("LoadPerCore = %v, want 2", got)
	}
	if got := h.MemAvailablePercent(); got != 25 {
		t.Errorf("MemAvailablePercent = %v, want 25", got)
	}
	if got := h.DiskFreePercent(); got != 25 {
		t.Errorf("DiskFreePercent = %v, want 25", got)
	}
	// Unknown (zero) totals return 0, never divide-by-zero.
	var z Host
	if z.LoadPerCore() != 0 || z.MemAvailablePercent() != 0 || z.DiskFreePercent() != 0 {
		t.Errorf("zero Host must return 0 for all derived percents")
	}
}

// TestEvaluatorZombieUnknownHoldsState verifies that a tick with an untrustworthy
// session set (zombiesKnown=false, e.g. the ListAllSessions query failed) neither
// fabricates a zombie alert nor clears an already-firing one — it carries the
// prior state forward and does not advance/reset the sustain counter.
func TestEvaluatorZombieUnknownHoldsState(t *testing.T) {
	e := newEvaluator(Thresholds{ZombieSustainTicks: 2})

	// Two authoritative ticks with zombies → fire.
	e.evaluate(Snapshot{Zombies: 2, ZombiesKnown: true})
	alerts, tr := e.evaluate(Snapshot{Zombies: 2, ZombiesKnown: true})
	if len(alerts) != 1 || len(tr) != 1 || !tr[0].Firing {
		t.Fatalf("want zombie firing after two known ticks, got alerts=%+v tr=%+v", alerts, tr)
	}

	// A tick with unknown sessions must hold the firing state (no clear).
	alerts, tr = e.evaluate(Snapshot{Zombies: 0, ZombiesKnown: false})
	if len(alerts) != 1 || alerts[0].Kind != AlertZombies {
		t.Fatalf("unknown-session tick must hold the firing zombie alert, got %+v", alerts)
	}
	if len(tr) != 0 {
		t.Fatalf("unknown-session tick must emit no transition, got %+v", tr)
	}

	// A fresh unknown tick from a cleared machine must NOT fabricate a zombie.
	e2 := newEvaluator(Thresholds{ZombieSustainTicks: 2})
	e2.evaluate(Snapshot{Zombies: 0, ZombiesKnown: false})
	alerts2, tr2 := e2.evaluate(Snapshot{Zombies: 0, ZombiesKnown: false})
	if len(alerts2) != 0 || len(tr2) != 0 {
		t.Fatalf("unknown sessions must not fabricate a zombie alert, got alerts=%+v tr=%+v", alerts2, tr2)
	}
}
