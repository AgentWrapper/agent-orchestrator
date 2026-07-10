package metrics

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

type fakeSessions struct {
	rows []domain.SessionRecord
	err  error
}

func (f fakeSessions) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return f.rows, f.err
}

type fakeHost struct {
	h   Host
	err error
}

func (f fakeHost) Host(context.Context) (Host, error) { return f.h, f.err }

type fakeScopes struct {
	m         map[string]uint64
	available *bool
	err       error
}

func (f fakeScopes) Scopes(context.Context) (map[string]uint64, bool, error) {
	if f.err != nil {
		return nil, false, f.err
	}
	if f.available != nil {
		return f.m, *f.available, nil
	}
	return f.m, true, nil
}

func unavailableScopes(m map[string]uint64) fakeScopes {
	available := false
	return fakeScopes{m: m, available: &available}
}

type fakeCost struct {
	c   Cost
	err error
}

func (f fakeCost) Aggregate(context.Context, time.Time) (Cost, error) { return f.c, f.err }

type captureSink struct{ transitions []AlertTransition }

func (c *captureSink) EmitAlert(_ context.Context, t AlertTransition) {
	c.transitions = append(c.transitions, t)
}

func sess(id, project string, state domain.ActivityState, handle string, terminated bool) domain.SessionRecord {
	return domain.SessionRecord{
		ID:           domain.SessionID(id),
		ProjectID:    domain.ProjectID(project),
		Activity:     domain.Activity{State: state},
		IsTerminated: terminated,
		Metadata:     domain.SessionMetadata{RuntimeHandleID: handle},
	}
}

func TestObserverTickProducesSnapshot(t *testing.T) {
	sink := &captureSink{}
	o := New(Deps{
		Sessions: fakeSessions{rows: []domain.SessionRecord{
			sess("a", "proj1", domain.ActivityActive, "a", false),
			sess("b", "proj1", domain.ActivityIdle, "b", false),
			sess("c", "proj2", domain.ActivityWaitingInput, "c", false),
			sess("d", "proj2", domain.ActivityActive, "d", true),             // terminated: excluded
			sess("zombie1", "proj2", domain.ActivityActive, "zombie1", true), // terminated handle still alive → zombie
		}},
		Host:   fakeHost{h: Host{LoadKnown: true, NumCPU: 4, LoadAvg1: 1, MemKnown: true, MemTotalBytes: 100, MemAvailableBytes: 80, DiskKnown: true, DiskTotalBytes: 100, DiskFreeBytes: 90}},
		Scopes: fakeScopes{m: map[string]uint64{"a": 1000, "b": 2000, "zombie1": 500}},
		Cost:   fakeCost{c: Cost{CostTotals: CostTotals{InputTokens: 10, OutputTokens: 5, TotalTokens: 15, CostUSD: 0.5, Events: 2}, ByProject: []ProjectCost{{ProjectID: "proj1", CostTotals: CostTotals{InputTokens: 7, TotalTokens: 7, Events: 1}}}}},
		Alerts: sink,
	}, Config{Clock: fixedClock(), Logger: quietLogger(), CostWindow: time.Hour})

	snap := o.Tick(context.Background())

	if snap.Host.NumCPU != 4 {
		t.Errorf("host not collected: %+v", snap.Host)
	}
	if len(snap.Projects) != 2 {
		t.Fatalf("want 2 projects, got %+v", snap.Projects)
	}
	// proj1: 2 sessions (active, idle); proj2: 1 (terminated excluded).
	if snap.Projects[0].ProjectID != "proj1" || snap.Projects[0].Sessions != 2 {
		t.Errorf("proj1 counts wrong: %+v", snap.Projects[0])
	}
	if snap.Projects[0].ByActivity["active"] != 1 || snap.Projects[0].ByActivity["idle"] != 1 {
		t.Errorf("proj1 activity wrong: %+v", snap.Projects[0].ByActivity)
	}
	if snap.Projects[1].ProjectID != "proj2" || snap.Projects[1].Sessions != 1 {
		t.Errorf("proj2 counts wrong: %+v", snap.Projects[1])
	}
	// scopes: a,b matched; zombie1 unmatched → 1 zombie.
	if snap.Zombies != 1 {
		t.Errorf("want 1 zombie, got %d (scopes=%+v)", snap.Zombies, snap.Scopes)
	}
	if len(snap.Scopes) != 3 {
		t.Errorf("want 3 scopes, got %+v", snap.Scopes)
	}
	if snap.Cost.TotalTokens != 15 || snap.Cost.WindowSeconds != 3600 {
		t.Errorf("cost wrong: %+v", snap.Cost)
	}
	if snap.Projects[0].Cost.TotalTokens != 7 || snap.Projects[1].Cost.Events != 0 {
		t.Errorf("project cost not attached correctly: %+v", snap.Projects)
	}

	// Latest/History exposed.
	if latest, ok := o.Latest(); !ok || !latest.CollectedAt.Equal(snap.CollectedAt) {
		t.Errorf("Latest did not return the tick snapshot")
	}
	if len(o.History()) != 1 {
		t.Errorf("history should have 1 entry, got %d", len(o.History()))
	}
}

func TestObserverEmitsAlertTransitions(t *testing.T) {
	sink := &captureSink{}
	host := fakeHost{h: Host{NumCPU: 1, DiskKnown: true, DiskTotalBytes: 100, DiskFreeBytes: 5}} // 5% < 10%
	o := New(Deps{Host: host, Alerts: sink}, Config{
		Clock: fixedClock(), Logger: quietLogger(),
		Thresholds: Thresholds{DiskFreePercent: 10},
	})
	o.Tick(context.Background())
	if len(sink.transitions) != 1 || !sink.transitions[0].Firing {
		t.Fatalf("want one firing transition emitted, got %+v", sink.transitions)
	}
	// Sustained: no new emission.
	o.Tick(context.Background())
	if len(sink.transitions) != 1 {
		t.Fatalf("sustained condition must not re-emit, got %+v", sink.transitions)
	}
}

func TestObserverHistoryBounded(t *testing.T) {
	o := New(Deps{Host: fakeHost{h: Host{NumCPU: 1}}}, Config{
		Clock: fixedClock(), Logger: quietLogger(), History: 3,
	})
	for i := 0; i < 5; i++ {
		o.Tick(context.Background())
	}
	if got := len(o.History()); got != 3 {
		t.Fatalf("history should be capped at 3, got %d", got)
	}
}

func TestObserverDegradesOnNilAndFailingCollectors(t *testing.T) {
	// All collectors nil except a failing sessions source: Tick must not panic
	// and must still produce a snapshot.
	o := New(Deps{Sessions: fakeSessions{err: context.DeadlineExceeded}}, Config{
		Clock: fixedClock(), Logger: quietLogger(),
	})
	snap := o.Tick(context.Background())
	if len(snap.Projects) != 0 || snap.Zombies != 0 {
		t.Fatalf("failing sessions must degrade to empty, got %+v", snap)
	}
}

// TestObserverFailingSessionsDoesNotFabricateZombies is the key regression for
// the "DB hiccup fires a fleet-wide leak" bug: with live scopes present but the
// session list unavailable, the observer must NOT count every unmatched scope as
// a zombie — the session set is simply unknown this tick.
func TestObserverFailingSessionsDoesNotFabricateZombies(t *testing.T) {
	o := New(Deps{
		Sessions: fakeSessions{err: context.DeadlineExceeded},
		Scopes:   fakeScopes{m: map[string]uint64{"s1": 100, "s2": 200, "s3": 300}},
	}, Config{Clock: fixedClock(), Logger: quietLogger()})
	snap := o.Tick(context.Background())
	if snap.Zombies != 0 {
		t.Fatalf("unknown session set must not fabricate zombies, got %d (scopes=%+v)", snap.Zombies, snap.Scopes)
	}
	// Scopes are still reported (for the memory readings) but flagged unmatched.
	if len(snap.Scopes) != 3 {
		t.Fatalf("scopes should still be reported, got %+v", snap.Scopes)
	}
	for _, sc := range snap.Scopes {
		if sc.Matched {
			t.Errorf("scope %s must not be reported matched when sessions are unknown", sc.Name)
		}
	}
}

// TestObserverScopesErrorDoesNotClearZombieAlert: the mirror of the
// session-outage case. Once the zombie alert is firing, a tick where the scope
// collector FAILS must not report zero scopes/zero zombies and thereby clear the
// alert — the zombie count is unknown that tick.
func TestObserverScopesErrorDoesNotClearZombieAlert(t *testing.T) {
	sessions := fakeSessions{rows: []domain.SessionRecord{sess("leaked", "proj", domain.ActivityActive, "leaked", true)}} // terminated row + live scope
	o := New(Deps{
		Sessions: sessions,
		Scopes:   fakeScopes{m: map[string]uint64{"leaked": 10}},
	}, Config{Clock: fixedClock(), Logger: quietLogger(), Thresholds: Thresholds{ZombieSustainTicks: 2}})
	o.Tick(context.Background()) // tick 1
	snap := o.Tick(context.Background())
	if len(snap.Alerts) != 1 || snap.Alerts[0].Kind != AlertZombies {
		t.Fatalf("want zombie firing after two ticks, got %+v", snap.Alerts)
	}
	// tick 3: scope collection fails → must hold, not clear.
	o.deps.Scopes = fakeScopes{err: context.DeadlineExceeded}
	snap = o.Tick(context.Background())
	if len(snap.Alerts) != 1 || snap.Alerts[0].Kind != AlertZombies {
		t.Fatalf("zombie alert must survive a scope-collect failure, got %+v", snap.Alerts)
	}
	if snap.Zombies != 0 {
		// zombies not authoritative this tick; count reported as 0 but alert held
		t.Logf("zombies reported %d on unknown tick (expected 0, alert held)", snap.Zombies)
	}
}

// TestObserverAlertZombieSurvivesSessionOutage: once the zombie alert is firing,
// a tick where the session list fails must hold the alert (no spurious clear).
func TestObserverAlertZombieSurvivesSessionOutage(t *testing.T) {
	live := fakeSessions{rows: []domain.SessionRecord{sess("leaked", "proj", domain.ActivityActive, "leaked", true)}} // terminated row + live scope → real zombie
	deadScope := fakeScopes{m: map[string]uint64{"leaked": 42}}
	o := New(Deps{Sessions: live, Scopes: deadScope}, Config{
		Clock: fixedClock(), Logger: quietLogger(),
		Thresholds: Thresholds{ZombieSustainTicks: 2},
	})
	o.Tick(context.Background()) // tick 1: zombie seen
	o.Tick(context.Background()) // tick 2: sustained → firing
	// tick 3: session query fails → must hold, not clear.
	o.deps.Sessions = fakeSessions{err: context.DeadlineExceeded}
	snap := o.Tick(context.Background())
	if len(snap.Alerts) != 1 || snap.Alerts[0].Kind != AlertZombies {
		t.Fatalf("zombie alert must survive a session-list outage, got alerts=%+v", snap.Alerts)
	}
}

func TestObserverIgnoresForeignTmuxScopesForZombieCount(t *testing.T) {
	o := New(Deps{
		Sessions: fakeSessions{rows: []domain.SessionRecord{
			sess("live-session", "proj", domain.ActivityActive, "ao-live-handle", false),
			sess("dead-session", "proj", domain.ActivityActive, "ao-dead-handle", true),
		}},
		Scopes: fakeScopes{m: map[string]uint64{
			"ao-live-handle": 100,
			"ao-dead-handle": 200,
			"foreign-tmux":   300,
		}},
	}, Config{Clock: fixedClock(), Logger: quietLogger()})
	snap := o.Tick(context.Background())
	if snap.Zombies != 1 {
		t.Fatalf("only an ao-owned terminated handle should count as zombie, got %d scopes=%+v", snap.Zombies, snap.Scopes)
	}
	if len(snap.Scopes) != 2 {
		t.Fatalf("foreign scopes should be filtered from ao metrics, got %+v", snap.Scopes)
	}
	for _, sc := range snap.Scopes {
		switch sc.Name {
		case "ao-live-handle":
			if !sc.Matched || sc.SessionID != "live-session" {
				t.Fatalf("live scope must map to domain session id, got %+v", sc)
			}
		case "ao-dead-handle", "foreign-tmux":
			if sc.SessionID != "" {
				t.Fatalf("unmatched scope %s must omit session id, got %+v", sc.Name, sc)
			}
		}
	}
}

func TestObserverReportsZombiesKnownFalseOnUnknownTick(t *testing.T) {
	o := New(Deps{
		Sessions: fakeSessions{err: context.DeadlineExceeded},
		Scopes:   fakeScopes{m: map[string]uint64{"s1": 100}},
	}, Config{Clock: fixedClock(), Logger: quietLogger()})
	snap := o.Tick(context.Background())
	if snap.ZombiesKnown {
		t.Fatalf("zombiesKnown must be false when session facts are unavailable")
	}
}

func TestObserverUnavailableScopesMakeZombiesUnknown(t *testing.T) {
	o := New(Deps{
		Sessions: fakeSessions{rows: []domain.SessionRecord{sess("live", "proj", domain.ActivityActive, "live-handle", false)}},
		Scopes:   unavailableScopes(map[string]uint64{}),
	}, Config{Clock: fixedClock(), Logger: quietLogger()})
	snap := o.Tick(context.Background())
	if snap.ZombiesKnown {
		t.Fatalf("zombiesKnown must be false when the scope collector reports unavailable")
	}
	if snap.Zombies != 0 || len(snap.Scopes) != 0 {
		t.Fatalf("unavailable scope facts should not fabricate zombies/scopes, got %+v", snap)
	}
}

func TestObserverCostWindowSecondsSetWhenAggregatorUnavailable(t *testing.T) {
	o := New(Deps{Cost: fakeCost{err: context.DeadlineExceeded}}, Config{Clock: fixedClock(), Logger: quietLogger(), CostWindow: 2 * time.Hour})
	snap := o.Tick(context.Background())
	if snap.Cost.WindowSeconds != 7200 {
		t.Fatalf("cost window seconds should be stable even when aggregate fails, got %+v", snap.Cost)
	}
}

func TestObserverLatestEmptyBeforeFirstTick(t *testing.T) {
	o := New(Deps{}, Config{Logger: quietLogger()})
	if _, ok := o.Latest(); ok {
		t.Fatalf("Latest must report not-ok before any tick")
	}
}

func fixedClock() func() time.Time {
	base := time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC)
	return func() time.Time {
		base = base.Add(time.Second)
		return base
	}
}
