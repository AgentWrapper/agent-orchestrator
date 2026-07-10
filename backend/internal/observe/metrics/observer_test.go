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
	m   map[string]uint64
	err error
}

func (f fakeScopes) Scopes(context.Context) (map[string]uint64, error) { return f.m, f.err }

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
			sess("d", "proj2", domain.ActivityActive, "d", true), // terminated: excluded
		}},
		Host:   fakeHost{h: Host{NumCPU: 4, LoadAvg1: 1, MemTotalBytes: 100, MemAvailableBytes: 80, DiskTotalBytes: 100, DiskFreeBytes: 90}},
		Scopes: fakeScopes{m: map[string]uint64{"a": 1000, "b": 2000, "zombie1": 500}},
		Cost:   fakeCost{c: Cost{InputTokens: 10, OutputTokens: 5, TotalTokens: 15, CostUSD: 0.5, Events: 2}},
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
	host := fakeHost{h: Host{NumCPU: 1, DiskTotalBytes: 100, DiskFreeBytes: 5}} // 5% < 10%
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
