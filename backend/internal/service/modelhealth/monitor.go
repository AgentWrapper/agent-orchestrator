// Package modelhealth periodically probes configured model pins and reports
// state transitions. It treats probe-infrastructure failures as no-verdicts so
// transient CLI/provider issues do not create false unreachable or recovery
// alerts.
package modelhealth

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

// Pin identifies one configured model pin to revalidate.
type Pin struct {
	ProjectID domain.ProjectID
	Scope     string
	Harness   domain.AgentHarness
	Model     string
}

// Key returns the stable transition key for this pin.
func (p Pin) Key() string {
	return string(p.ProjectID) + "|" + strings.TrimSpace(p.Scope) + "|" + string(p.Harness) + "|" + strings.TrimSpace(p.Model)
}

// Verdict is one probe result for a configured pin.
type Verdict struct {
	Pin     Pin
	Status  agentsvc.ModelStatus
	Reason  string
	Checked time.Time
}

// Prober validates a batch of model pins.
type Prober interface {
	CheckModels(ctx context.Context, pins []Pin) ([]Verdict, error)
}

// PinLister returns the configured model pins to revalidate each cycle.
type PinLister func(ctx context.Context) ([]Pin, error)

// Transition describes one actionable state change.
type Transition struct {
	Prev    Verdict
	Current Verdict
}

// Deps configures a Monitor.
type Deps struct {
	Pins         PinLister
	Prober       Prober
	Clock        func() time.Time
	Logger       *slog.Logger
	OnTransition func(Transition)
}

// Monitor stores latest model-pin verdicts and emits transitions.
type Monitor struct {
	pins   PinLister
	prober Prober
	clock  func() time.Time
	log    *slog.Logger
	onTran func(Transition)

	mu        sync.RWMutex
	state     map[string]Verdict
	checkedAt time.Time
}

// New constructs a Monitor.
func New(d Deps) *Monitor {
	m := &Monitor{pins: d.Pins, prober: d.Prober, clock: d.Clock, log: d.Logger, onTran: d.OnTransition, state: map[string]Verdict{}}
	if m.clock == nil {
		m.clock = time.Now
	}
	if m.log == nil {
		m.log = slog.Default()
	}
	return m
}

// Check runs one revalidation cycle. Unknown verdicts are retained in the
// snapshot only for first observations; they do not overwrite an existing
// reachable/unreachable state, preserving correct recovery detection.
func (m *Monitor) Check(ctx context.Context) error {
	if m.prober == nil {
		return nil
	}
	var pins []Pin
	if m.pins != nil {
		var err error
		pins, err = m.pins(ctx)
		if err != nil {
			return err
		}
	}
	if len(pins) == 0 {
		m.mu.Lock()
		for key := range m.state {
			delete(m.state, key)
		}
		m.checkedAt = m.clock()
		m.mu.Unlock()
		return nil
	}
	verdicts, err := m.prober.CheckModels(ctx, pins)
	if err != nil {
		return err
	}
	now := m.clock()
	var transitions []Transition
	currentKeys := make(map[string]struct{}, len(pins))
	for _, pin := range pins {
		currentKeys[pin.Key()] = struct{}{}
	}

	m.mu.Lock()
	for key := range m.state {
		if _, ok := currentKeys[key]; !ok {
			delete(m.state, key)
		}
	}
	for _, v := range verdicts {
		if v.Checked.IsZero() {
			v.Checked = now
		}
		key := v.Pin.Key()
		old, hadOld := m.state[key]
		if v.Status == agentsvc.ModelStatusUnknown && hadOld {
			continue
		}
		if !hadOld {
			m.state[key] = v
			if v.Status == agentsvc.ModelStatusUnreachable {
				transitions = append(transitions, Transition{Current: v})
			}
			continue
		}
		if old.Status != v.Status {
			if v.Status == agentsvc.ModelStatusUnreachable || (old.Status == agentsvc.ModelStatusUnreachable && v.Status == agentsvc.ModelStatusReachable) {
				transitions = append(transitions, Transition{Prev: old, Current: v})
			}
		}
		m.state[key] = v
	}
	m.checkedAt = now
	m.mu.Unlock()

	for _, tr := range transitions {
		m.logTransition(tr)
		if m.onTran != nil {
			m.onTran(tr)
		}
	}
	return nil
}

// Snapshot returns the latest retained verdicts sorted by key.
func (m *Monitor) Snapshot() []Verdict {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Verdict, 0, len(m.state))
	for _, v := range m.state {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Pin.Key() < out[j].Pin.Key() })
	return out
}

func (m *Monitor) logTransition(tr Transition) {
	cur := tr.Current
	if cur.Status == agentsvc.ModelStatusUnreachable {
		m.log.Warn("configured model unreachable", "project", cur.Pin.ProjectID, "scope", cur.Pin.Scope, "harness", cur.Pin.Harness, "model", cur.Pin.Model, "reason", cur.Reason)
		return
	}
	if tr.Prev.Status == agentsvc.ModelStatusUnreachable && cur.Status == agentsvc.ModelStatusReachable {
		m.log.Info("configured model recovered", "project", cur.Pin.ProjectID, "scope", cur.Pin.Scope, "harness", cur.Pin.Harness, "model", cur.Pin.Model)
	}
}
