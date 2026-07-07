// Package agenthealth periodically probes each configured agent harness for
// functional readiness (binary installed + authenticated) and tracks
// transitions so operators can be alerted the moment a harness breaks — e.g. a
// codex/claude/fugu login expiring. It is deliberately provider-agnostic: the
// bounded binary/auth probes come from the agent catalog (injected Prober), the
// set of harnesses to watch comes from an injected HarnessLister, and alerting
// is a read-side concern (the /agents/health endpoint + the ops notifier),
// never a write into session-scoped notification storage.
package agenthealth

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Health is the resolved functional state of one harness.
type Health string

const (
	// HealthHealthy means the binary resolved and the local auth probe passed.
	HealthHealthy Health = "healthy"
	// HealthUnauthorized means the binary resolved but the harness is not
	// authenticated (login expired or logged out).
	HealthUnauthorized Health = "unauthorized"
	// HealthMissing means the harness binary did not resolve on PATH.
	HealthMissing Health = "missing"
	// HealthUnknown means readiness could not be determined (probe inconclusive
	// or the adapter exposes no auth checker). Advisory; not alerted on.
	HealthUnknown Health = "unknown"
)

// Actionable reports whether a health state warrants an operator alert. Unknown
// is advisory and deliberately excluded so probe flakiness never pages anyone.
func (h Health) Actionable() bool {
	return h == HealthUnauthorized || h == HealthMissing
}

// Probe is one harness's raw install/auth result from the agent catalog.
type Probe struct {
	ID         string
	Label      string
	Installed  bool
	AuthStatus ports.AgentAuthStatus
}

// Prober probes the named harnesses, reusing the agent catalog's bounded
// binary+auth probes. Implementations must apply their own per-probe timeouts.
type Prober interface {
	HarnessHealth(ctx context.Context, ids []string) ([]Probe, error)
}

// HarnessLister returns the harness ids to monitor. It is called every cycle so
// newly-configured harnesses are picked up without a daemon restart.
type HarnessLister func(ctx context.Context) []string

// HarnessHealth is the resolved health of one monitored harness.
type HarnessHealth struct {
	ID         string                `json:"id"`
	Label      string                `json:"label"`
	Health     Health                `json:"health"`
	AuthStatus ports.AgentAuthStatus `json:"authStatus,omitempty"`
	Reason     string                `json:"reason,omitempty"`
	Remedy     string                `json:"remedy,omitempty"`
	// ChangedAt is when Health last transitioned to its current value.
	ChangedAt time.Time `json:"changedAt"`
	// CheckedAt is the most recent probe time for this harness.
	CheckedAt time.Time `json:"checkedAt"`
}

// Snapshot is the current health of every monitored harness.
type Snapshot struct {
	Harnesses []HarnessHealth `json:"harnesses"`
	CheckedAt time.Time       `json:"checkedAt"`
}

// Transition describes a change in a harness's health, fired by Check.
type Transition struct {
	Prev    Health
	Current HarnessHealth
}

// Deps configures a Monitor.
type Deps struct {
	Prober    Prober
	Harnesses HarnessLister
	Clock     func() time.Time
	Logger    *slog.Logger
	// OnTransition, if set, is invoked synchronously for every harness whose
	// health changed during a Check (including the first observation). Used for
	// tests and optional metrics; production alerting reads Snapshot.
	OnTransition func(Transition)
}

// Monitor holds per-harness health with transition tracking. Safe for
// concurrent Snapshot reads while Check writes.
type Monitor struct {
	prober    Prober
	harnesses HarnessLister
	clock     func() time.Time
	log       *slog.Logger
	onTrans   func(Transition)

	mu        sync.RWMutex
	state     map[string]HarnessHealth
	checkedAt time.Time
}

// New constructs a Monitor.
func New(d Deps) *Monitor {
	m := &Monitor{
		prober:    d.Prober,
		harnesses: d.Harnesses,
		clock:     d.Clock,
		log:       d.Logger,
		onTrans:   d.OnTransition,
		state:     map[string]HarnessHealth{},
	}
	if m.clock == nil {
		m.clock = time.Now
	}
	if m.log == nil {
		m.log = slog.Default()
	}
	return m
}

// Check runs one probe cycle: resolve the harness set, probe it, map to health,
// and record transitions. A prober error aborts the cycle without mutating
// state (the previous snapshot is retained). An empty harness set is a no-op
// that also retains prior state, so a transient config read never wipes health.
func (m *Monitor) Check(ctx context.Context) error {
	var ids []string
	if m.harnesses != nil {
		ids = m.harnesses(ctx)
	}
	if len(ids) == 0 {
		return nil
	}
	probes, err := m.prober.HarnessHealth(ctx, ids)
	if err != nil {
		return err
	}
	now := m.clock()

	m.mu.Lock()
	prev := m.state
	next := make(map[string]HarnessHealth, len(probes))
	var transitions []Transition
	for _, p := range probes {
		cur := resolve(p, now)
		if old, ok := prev[p.ID]; ok {
			if old.Health == cur.Health {
				cur.ChangedAt = old.ChangedAt
			} else {
				transitions = append(transitions, Transition{Prev: old.Health, Current: cur})
			}
		} else {
			// First observation of this harness is a transition from "".
			transitions = append(transitions, Transition{Prev: "", Current: cur})
		}
		next[p.ID] = cur
	}
	m.state = next
	m.checkedAt = now
	m.mu.Unlock()

	for _, tr := range transitions {
		m.logTransition(tr)
		if m.onTrans != nil {
			m.onTrans(tr)
		}
	}
	return nil
}

// Snapshot returns the current health of every monitored harness, sorted by id.
func (m *Monitor) Snapshot() Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]HarnessHealth, 0, len(m.state))
	for _, h := range m.state {
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return Snapshot{Harnesses: out, CheckedAt: m.checkedAt}
}

func (m *Monitor) logTransition(tr Transition) {
	c := tr.Current
	switch {
	case c.Health.Actionable():
		m.log.Warn("agent harness unhealthy",
			"harness", c.ID, "health", c.Health, "reason", c.Reason, "remedy", c.Remedy, "prev", tr.Prev)
	case c.Health == HealthHealthy && tr.Prev.Actionable():
		m.log.Info("agent harness recovered", "harness", c.ID, "prev", tr.Prev)
	default:
		m.log.Debug("agent harness health", "harness", c.ID, "health", c.Health, "prev", tr.Prev)
	}
}

// resolve maps a raw probe to a health verdict with a human remedy.
func resolve(p Probe, now time.Time) HarnessHealth {
	h := HarnessHealth{
		ID:         p.ID,
		Label:      labelOr(p.ID, p.Label),
		AuthStatus: p.AuthStatus,
		ChangedAt:  now,
		CheckedAt:  now,
	}
	switch {
	case !p.Installed:
		h.Health = HealthMissing
		h.Reason = "binary not found on PATH"
		h.Remedy = "install the " + h.Label + " CLI and ensure it is on the daemon's PATH"
	case p.AuthStatus == ports.AgentAuthStatusAuthorized:
		h.Health = HealthHealthy
	case p.AuthStatus == ports.AgentAuthStatusUnauthorized:
		h.Health = HealthUnauthorized
		h.Reason = "not authenticated (login expired or logged out)"
		h.Remedy = loginRemedy(p.ID, h.Label)
	default:
		h.Health = HealthUnknown
		h.Reason = "auth status could not be determined"
	}
	return h
}

func labelOr(id, label string) string {
	if label != "" {
		return label
	}
	return id
}

// loginRemedy returns the human re-auth step for a harness. The fix for an
// unauthenticated harness is almost always a human re-login, so the message
// names the exact command where known.
func loginRemedy(id, label string) string {
	switch id {
	case "claude-code":
		return "run `claude` and sign in, or set ANTHROPIC_API_KEY"
	case "codex":
		return "run `codex login`"
	case "codex-fugu":
		return "run `codex-fugu login` (or `codex login` for the shared account)"
	case "copilot":
		return "run `gh auth login` / re-authenticate GitHub Copilot"
	default:
		return "re-run the " + label + " login/auth command"
	}
}
