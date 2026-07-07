package agenthealth

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type stubProber struct {
	probes map[string]Probe
	err    error
	calls  [][]string
}

func (s *stubProber) HarnessHealth(_ context.Context, ids []string) ([]Probe, error) {
	s.calls = append(s.calls, append([]string(nil), ids...))
	if s.err != nil {
		return nil, s.err
	}
	out := make([]Probe, 0, len(ids))
	for _, id := range ids {
		if p, ok := s.probes[id]; ok {
			out = append(out, p)
		} else {
			out = append(out, Probe{ID: id})
		}
	}
	return out, nil
}

func authorized(id, label string) Probe {
	return Probe{ID: id, Label: label, Installed: true, AuthStatus: ports.AgentAuthStatusAuthorized}
}

func newTestMonitor(t *testing.T, prober Prober, ids []string, clock func() time.Time) (*Monitor, *[]Transition) {
	t.Helper()
	var transitions []Transition
	m := New(Deps{
		Prober:    prober,
		Harnesses: func(context.Context) []string { return ids },
		Clock:     clock,
		OnTransition: func(tr Transition) {
			transitions = append(transitions, tr)
		},
	})
	return m, &transitions
}

func TestCheckMapsHealth(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	prober := &stubProber{probes: map[string]Probe{
		"claude-code": authorized("claude-code", "Claude Code"),
		"codex":       {ID: "codex", Label: "Codex", Installed: true, AuthStatus: ports.AgentAuthStatusUnauthorized},
		"codex-fugu":  {ID: "codex-fugu", Label: "Codex Fugu", Installed: false},
		"grok":        {ID: "grok", Label: "Grok", Installed: true, AuthStatus: ports.AgentAuthStatusUnknown},
	}}
	m, _ := newTestMonitor(t, prober, []string{"claude-code", "codex", "codex-fugu", "grok"}, func() time.Time { return now })

	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}
	snap := m.Snapshot()
	if !snap.CheckedAt.Equal(now) {
		t.Fatalf("CheckedAt=%v want %v", snap.CheckedAt, now)
	}
	byID := map[string]HarnessHealth{}
	for _, h := range snap.Harnesses {
		byID[h.ID] = h
	}
	if got := byID["claude-code"].Health; got != HealthHealthy {
		t.Errorf("claude-code health=%s want healthy", got)
	}
	if got := byID["codex"].Health; got != HealthUnauthorized {
		t.Errorf("codex health=%s want unauthorized", got)
	}
	if byID["codex"].Remedy == "" {
		t.Errorf("codex unauthorized should carry a remedy")
	}
	if got := byID["codex-fugu"].Health; got != HealthMissing {
		t.Errorf("codex-fugu health=%s want missing", got)
	}
	if got := byID["grok"].Health; got != HealthUnknown {
		t.Errorf("grok health=%s want unknown", got)
	}
	for _, h := range snap.Harnesses {
		if !h.ChangedAt.Equal(now) {
			t.Errorf("%s ChangedAt=%v want %v (first observation)", h.ID, h.ChangedAt, now)
		}
	}
}

func TestSnapshotSortedByID(t *testing.T) {
	now := time.Now()
	prober := &stubProber{probes: map[string]Probe{
		"codex":       authorized("codex", "Codex"),
		"claude-code": authorized("claude-code", "Claude Code"),
	}}
	m, _ := newTestMonitor(t, prober, []string{"codex", "claude-code"}, func() time.Time { return now })
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}
	snap := m.Snapshot()
	if len(snap.Harnesses) != 2 || snap.Harnesses[0].ID != "claude-code" || snap.Harnesses[1].ID != "codex" {
		t.Fatalf("snapshot not sorted by id: %+v", snap.Harnesses)
	}
}

func TestChangedAtStableWhenHealthUnchanged(t *testing.T) {
	t1 := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	t2 := t1.Add(5 * time.Minute)
	clock := t1
	prober := &stubProber{probes: map[string]Probe{"codex": authorized("codex", "Codex")}}
	m, _ := newTestMonitor(t, prober, []string{"codex"}, func() time.Time { return clock })

	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check1: %v", err)
	}
	clock = t2
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check2: %v", err)
	}
	got := m.Snapshot().Harnesses[0]
	if !got.ChangedAt.Equal(t1) {
		t.Errorf("ChangedAt=%v want %v (unchanged health keeps first transition time)", got.ChangedAt, t1)
	}
	if !got.CheckedAt.Equal(t2) {
		t.Errorf("CheckedAt=%v want %v", got.CheckedAt, t2)
	}
}

func TestTransitionsFireOnChange(t *testing.T) {
	t1 := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	clock := t1
	prober := &stubProber{probes: map[string]Probe{"codex": authorized("codex", "Codex")}}
	m, transitions := newTestMonitor(t, prober, []string{"codex"}, func() time.Time { return clock })

	// First observation healthy: a transition from "" -> healthy.
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check1: %v", err)
	}
	// Break codex.
	clock = t1.Add(time.Minute)
	prober.probes["codex"] = Probe{ID: "codex", Label: "Codex", Installed: true, AuthStatus: ports.AgentAuthStatusUnauthorized}
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check2: %v", err)
	}
	// Repeat unhealthy: no new transition (dedupe).
	clock = t1.Add(2 * time.Minute)
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check3: %v", err)
	}
	// Recover.
	clock = t1.Add(3 * time.Minute)
	prober.probes["codex"] = authorized("codex", "Codex")
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check4: %v", err)
	}

	// Expect: ""->healthy, healthy->unauthorized, unauthorized->healthy. No dupe.
	if len(*transitions) != 3 {
		t.Fatalf("transitions=%d want 3: %+v", len(*transitions), *transitions)
	}
	if (*transitions)[1].Prev != HealthHealthy || (*transitions)[1].Current.Health != HealthUnauthorized {
		t.Errorf("second transition = %s->%s want healthy->unauthorized", (*transitions)[1].Prev, (*transitions)[1].Current.Health)
	}
	if (*transitions)[2].Prev != HealthUnauthorized || (*transitions)[2].Current.Health != HealthHealthy {
		t.Errorf("third transition = %s->%s want unauthorized->healthy", (*transitions)[2].Prev, (*transitions)[2].Current.Health)
	}
}

func TestDroppedHarnessLeavesSnapshot(t *testing.T) {
	now := time.Now()
	ids := []string{"codex", "claude-code"}
	prober := &stubProber{probes: map[string]Probe{
		"codex":       authorized("codex", "Codex"),
		"claude-code": authorized("claude-code", "Claude Code"),
	}}
	m := New(Deps{
		Prober:    prober,
		Harnesses: func(context.Context) []string { return ids },
		Clock:     func() time.Time { return now },
	})
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check1: %v", err)
	}
	ids = []string{"codex"} // claude-code no longer configured
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check2: %v", err)
	}
	snap := m.Snapshot()
	if len(snap.Harnesses) != 1 || snap.Harnesses[0].ID != "codex" {
		t.Fatalf("dropped harness should leave snapshot: %+v", snap.Harnesses)
	}
}

func TestCheckPropagatesProberError(t *testing.T) {
	prober := &stubProber{err: context.DeadlineExceeded}
	m, _ := newTestMonitor(t, prober, []string{"codex"}, time.Now)
	if err := m.Check(context.Background()); err == nil {
		t.Fatal("expected prober error to propagate")
	}
	// Snapshot stays empty; no partial state written.
	if len(m.Snapshot().Harnesses) != 0 {
		t.Fatal("errored check must not mutate state")
	}
}

func TestEmptyListerKeepsPriorState(t *testing.T) {
	now := time.Now()
	ids := []string{"codex"}
	prober := &stubProber{probes: map[string]Probe{"codex": authorized("codex", "Codex")}}
	m := New(Deps{
		Prober:    prober,
		Harnesses: func(context.Context) []string { return ids },
		Clock:     func() time.Time { return now },
	})
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check1: %v", err)
	}
	ids = nil
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check2: %v", err)
	}
	if len(m.Snapshot().Harnesses) != 1 {
		t.Fatal("empty lister should not wipe prior health state")
	}
}
