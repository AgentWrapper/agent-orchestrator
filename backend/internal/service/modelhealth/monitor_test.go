package modelhealth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

type stubProber struct {
	verdicts map[string]Verdict
	calls    [][]Pin
}

func (s *stubProber) CheckModels(_ context.Context, pins []Pin) ([]Verdict, error) {
	s.calls = append(s.calls, append([]Pin(nil), pins...))
	out := make([]Verdict, 0, len(pins))
	for _, pin := range pins {
		v, ok := s.verdicts[pin.Key()]
		if !ok {
			v = Verdict{Pin: pin, Status: agentsvc.ModelStatusUnknown, Reason: "no verdict"}
		}
		v.Pin = pin
		out = append(out, v)
	}
	return out, nil
}

func TestMonitorDedupesUnreachableAndRecoveryTransitions(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	pin := Pin{ProjectID: "ao", Scope: "workerMix[0]", Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"}
	prober := &stubProber{verdicts: map[string]Verdict{pin.Key(): {Status: agentsvc.ModelStatusUnreachable, Reason: "400 model not available"}}}
	var transitions []Transition
	m := New(Deps{
		Pins:         func(context.Context) ([]Pin, error) { return []Pin{pin}, nil },
		Prober:       prober,
		Clock:        func() time.Time { return now },
		OnTransition: func(tr Transition) { transitions = append(transitions, tr) },
	})

	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check1: %v", err)
	}
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check2: %v", err)
	}
	prober.verdicts[pin.Key()] = Verdict{Status: agentsvc.ModelStatusReachable}
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check3: %v", err)
	}
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check4: %v", err)
	}

	if len(transitions) != 2 {
		t.Fatalf("transitions=%d want 2: %+v", len(transitions), transitions)
	}
	if transitions[0].Current.Status != agentsvc.ModelStatusUnreachable || transitions[0].Current.Reason == "" {
		t.Fatalf("first transition = %+v, want unreachable with reason", transitions[0])
	}
	if transitions[1].Prev.Status != agentsvc.ModelStatusUnreachable || transitions[1].Current.Status != agentsvc.ModelStatusReachable {
		t.Fatalf("second transition = %+v, want unreachable->reachable", transitions[1])
	}
}

func TestMonitorUnknownDoesNotClearPreviousUnreachable(t *testing.T) {
	pin := Pin{ProjectID: "ao", Scope: "workerMix[0]", Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"}
	prober := &stubProber{verdicts: map[string]Verdict{pin.Key(): {Status: agentsvc.ModelStatusUnreachable, Reason: "400 model not available"}}}
	var transitions []Transition
	m := New(Deps{
		Pins:         func(context.Context) ([]Pin, error) { return []Pin{pin}, nil },
		Prober:       prober,
		OnTransition: func(tr Transition) { transitions = append(transitions, tr) },
	})
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check1: %v", err)
	}
	prober.verdicts[pin.Key()] = Verdict{Status: agentsvc.ModelStatusUnknown, Reason: "probe unavailable"}
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check2: %v", err)
	}
	prober.verdicts[pin.Key()] = Verdict{Status: agentsvc.ModelStatusReachable}
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check3: %v", err)
	}
	if len(transitions) != 2 {
		t.Fatalf("transitions=%d want unreachable and recovery only: %+v", len(transitions), transitions)
	}
	if transitions[1].Prev.Status != agentsvc.ModelStatusUnreachable || transitions[1].Current.Status != agentsvc.ModelStatusReachable {
		t.Fatalf("recovery transition = %+v, want previous unreachable retained across unknown", transitions[1])
	}
}

func TestMonitorPrunesPinsMissingFromCurrentConfig(t *testing.T) {
	pin := Pin{ProjectID: "ao", Scope: "workerMix[0]", Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"}
	pins := []Pin{pin}
	prober := &stubProber{verdicts: map[string]Verdict{pin.Key(): {Status: agentsvc.ModelStatusReachable}}}
	m := New(Deps{
		Pins:   func(context.Context) ([]Pin, error) { return append([]Pin(nil), pins...), nil },
		Prober: prober,
	})
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check1: %v", err)
	}
	if got := m.Snapshot(); len(got) != 1 {
		t.Fatalf("snapshot after first check = %#v, want one retained verdict", got)
	}
	pins = nil
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check2: %v", err)
	}
	if got := m.Snapshot(); len(got) != 0 {
		t.Fatalf("snapshot after pin removal = %#v, want stale verdict pruned", got)
	}
}

func TestMonitorListerErrorDoesNotPrunePreviousState(t *testing.T) {
	pin := Pin{ProjectID: "ao", Scope: "workerMix[0]", Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"}
	listErr := errors.New("project store unavailable")
	failList := false
	prober := &stubProber{verdicts: map[string]Verdict{pin.Key(): {Status: agentsvc.ModelStatusUnreachable, Reason: "400 model not available"}}}
	m := New(Deps{
		Pins: func(context.Context) ([]Pin, error) {
			if failList {
				return nil, listErr
			}
			return []Pin{pin}, nil
		},
		Prober: prober,
	})
	if err := m.Check(context.Background()); err != nil {
		t.Fatalf("Check1: %v", err)
	}
	failList = true
	if err := m.Check(context.Background()); !errors.Is(err, listErr) {
		t.Fatalf("Check2 err = %v, want list error", err)
	}
	if got := m.Snapshot(); len(got) != 1 || got[0].Pin.Key() != pin.Key() {
		t.Fatalf("snapshot after lister error = %#v, want previous verdict retained", got)
	}
}
