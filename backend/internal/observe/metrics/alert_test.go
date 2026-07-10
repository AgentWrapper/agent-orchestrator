package metrics

import "testing"

func TestEvaluatorFiresAndClearsOnTransition(t *testing.T) {
	e := newEvaluator(Thresholds{DiskFreePercent: 10})

	// Below threshold → fire once.
	alerts, tr := e.evaluate(Snapshot{Host: Host{DiskTotalBytes: 100, DiskFreeBytes: 5}})
	if len(alerts) != 1 || alerts[0].Kind != AlertDiskLow {
		t.Fatalf("want disk_low firing, got %+v", alerts)
	}
	if len(tr) != 1 || !tr[0].Firing || tr[0].Alert.Kind != AlertDiskLow {
		t.Fatalf("want one firing transition, got %+v", tr)
	}

	// Still below → firing, but NO new transition (dedupe on state, not tick).
	_, tr = e.evaluate(Snapshot{Host: Host{DiskTotalBytes: 100, DiskFreeBytes: 6}})
	if len(tr) != 0 {
		t.Fatalf("want no transition while sustained, got %+v", tr)
	}

	// Recovered → clear transition.
	alerts, tr = e.evaluate(Snapshot{Host: Host{DiskTotalBytes: 100, DiskFreeBytes: 50}})
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
		Host:    Host{DiskTotalBytes: 100, DiskFreeBytes: 1, MemTotalBytes: 100, MemAvailableBytes: 1, NumCPU: 1, LoadAvg1: 99},
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

func TestEvaluatorZombieSustain(t *testing.T) {
	e := newEvaluator(Thresholds{ZombieSustainTicks: 2})

	// Tick 1: zombies>0 but not yet sustained.
	alerts, tr := e.evaluate(Snapshot{Zombies: 1})
	if len(alerts) != 0 || len(tr) != 0 {
		t.Fatalf("first zombie tick must not fire, got alerts=%+v tr=%+v", alerts, tr)
	}

	// Tick 2: sustained → fire.
	alerts, tr = e.evaluate(Snapshot{Zombies: 3})
	if len(alerts) != 1 || alerts[0].Kind != AlertZombies {
		t.Fatalf("second zombie tick must fire, got %+v", alerts)
	}
	if len(tr) != 1 || !tr[0].Firing {
		t.Fatalf("want firing transition, got %+v", tr)
	}

	// Tick 3: back to zero → clear and reset counter.
	alerts, tr = e.evaluate(Snapshot{Zombies: 0})
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
	if _, tr := e.evaluate(Snapshot{Zombies: 1}); len(tr) != 0 {
		t.Fatalf("blip tick 1 must not fire, got %+v", tr)
	}
	if _, tr := e.evaluate(Snapshot{Zombies: 0}); len(tr) != 0 {
		t.Fatalf("blip cleared before sustain must produce no transition, got %+v", tr)
	}
}

func TestEvaluatorMultipleSimultaneousAlerts(t *testing.T) {
	e := newEvaluator(Thresholds{DiskFreePercent: 10, MemAvailablePercent: 10, LoadPerCore: 1})
	alerts, tr := e.evaluate(Snapshot{Host: Host{
		DiskTotalBytes: 100, DiskFreeBytes: 1,
		MemTotalBytes: 100, MemAvailableBytes: 1,
		NumCPU: 2, LoadAvg1: 8, // 4 per core > 1
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
