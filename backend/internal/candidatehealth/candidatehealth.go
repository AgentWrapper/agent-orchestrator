// Package candidatehealth is AO's shared agent-candidate health policy: the
// invariant that when AO selects an exact agent candidate (a worker bucket, a
// reviewer harness, a deploy-pool member, or any future pooled agent) and that
// exact candidate fails to start or operate, AO must not silently substitute a
// different candidate as though the original choice had succeeded.
//
// It generalises the worker-mix circuit breaker introduced for GH #95 (which
// lived only in the session manager) into one policy every AO-controlled agent
// selection surface can reuse (GH #142). A Tracker records the exact candidate
// failure and its observed reason, marks the candidate down, debits it from the
// surface's rotation so its share is not silently reallocated, and emits a
// user/operator-visible telemetry alert. A later successful exact-candidate
// attempt clears the down state.
//
// The Tracker is deliberately transport- and domain-agnostic: it keys on an
// opaque Candidate identity that each surface fills with the exact
// harness/provider/model/account/bot axes it needs to avoid false substitution.
// Every surface constructs its own Tracker instance (so one surface's skip
// debits never bleed into another's selection), but they share this one policy
// implementation, event vocabulary, and alerting path.
package candidatehealth

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Telemetry event names emitted by every surface that uses a Tracker. The
// surface is carried in the payload rather than the name so a single downstream
// consumer (e.g. the Slack notifier) can react to candidate health across every
// AO selection surface with one subscription.
const (
	// EventCandidateDown is emitted the first time a candidate is marked down.
	EventCandidateDown = "ao.candidate_health.candidate_down"
	// EventCandidateRecovered is emitted when a previously-down candidate
	// recovers after a successful exact-candidate attempt.
	EventCandidateRecovered = "ao.candidate_health.candidate_recovered"
)

// Candidate is the exact identity of a selected agent candidate. Only the axes a
// surface actually distributes over need to be set; the zero value of an unused
// axis is fine. The identity is what protects against false substitution: two
// candidates that differ on any populated axis are distinct, so a failure of one
// never marks the other unhealthy (and never lets a healthy one absorb the
// failed one's share silently).
//
// Surface is required and names the selection surface (e.g. "worker_mix",
// "reviewer"); it keeps candidates from different surfaces from colliding even
// when they share a Tracker, and it is surfaced in every alert.
type Candidate struct {
	// Surface names the AO selection surface the candidate belongs to.
	Surface string
	// Harness is the agent/reviewer CLI the candidate launches.
	Harness string
	// Model pins the model when the surface distributes over models; empty means
	// the harness default.
	Model string
	// Provider names the model/back-end provider when a surface distributes over
	// providers (empty when not relevant).
	Provider string
	// Account identifies the auth/login/account the candidate runs under when a
	// surface distributes over accounts (empty when not relevant).
	Account string
	// Bot identifies the exact bot/app identity (e.g. a PR-integrated reviewer
	// bot) when a surface distributes over bot identities (empty when not
	// relevant).
	Bot string
}

// Normalized trims whitespace on every axis so a padded value keys the same slot
// it selects on. Surfaces should key the Tracker with the same normalization
// they select with; the Tracker normalizes defensively regardless.
func (c Candidate) Normalized() Candidate {
	return Candidate{
		Surface:  strings.TrimSpace(c.Surface),
		Harness:  strings.TrimSpace(c.Harness),
		Model:    strings.TrimSpace(c.Model),
		Provider: strings.TrimSpace(c.Provider),
		Account:  strings.TrimSpace(c.Account),
		Bot:      strings.TrimSpace(c.Bot),
	}
}

// String renders a stable, human-readable identity for logs and alerts, e.g.
// "worker_mix:codex:gpt-5.5-codex" or "reviewer:codex". Only populated axes
// appear, so the rendering stays terse for simple surfaces.
func (c Candidate) String() string {
	n := c.Normalized()
	parts := make([]string, 0, 6)
	if n.Surface != "" {
		parts = append(parts, n.Surface)
	}
	if n.Harness != "" {
		parts = append(parts, n.Harness)
	}
	if n.Model != "" {
		parts = append(parts, n.Model)
	}
	if n.Provider != "" {
		parts = append(parts, "provider="+n.Provider)
	}
	if n.Account != "" {
		parts = append(parts, "account="+n.Account)
	}
	if n.Bot != "" {
		parts = append(parts, "bot="+n.Bot)
	}
	if len(parts) == 0 {
		return "candidate"
	}
	return strings.Join(parts, ":")
}

type downState struct {
	reason    string
	changedAt time.Time
}

// Status is the read-only projection of one candidate's reactive health.
type Status struct {
	Candidate Candidate
	Down      bool
	Reason    string
	ChangedAt time.Time
	Skipped   int
}

// attemptCanceled reports whether the caller's attempt context was actually
// canceled. Candidate-side probes can also wrap context.Canceled or
// context.DeadlineExceeded, so the returned error's identity alone is not enough
// to decide whether a candidate should be marked unhealthy.
func attemptCanceled(ctx context.Context) bool {
	return ctx != nil && ctx.Err() != nil
}

// Tracker is a surface's in-memory candidate-health circuit breaker. It is safe
// for concurrent use. Construct one per selection surface with New.
type Tracker struct {
	source    string
	logger    *slog.Logger
	telemetry ports.EventSink
	clock     func() time.Time

	mu      sync.Mutex
	down    map[Candidate]downState
	skipped map[Candidate]int
}

// Config wires a Tracker. Source names the emitting component (e.g.
// "session_manager", "review"); it defaults to "candidatehealth". Logger and
// Clock default to slog.Default and time.Now().UTC(). Telemetry may be nil,
// which keeps log alerts while disabling structured events.
type Config struct {
	Source    string
	Logger    *slog.Logger
	Telemetry ports.EventSink
	Clock     func() time.Time
}

// New builds a Tracker from its config, defaulting the unset collaborators.
func New(cfg Config) *Tracker {
	t := &Tracker{
		source:    strings.TrimSpace(cfg.Source),
		logger:    cfg.Logger,
		telemetry: cfg.Telemetry,
		clock:     cfg.Clock,
		down:      map[Candidate]downState{},
		skipped:   map[Candidate]int{},
	}
	if t.source == "" {
		t.source = "candidatehealth"
	}
	if t.logger == nil {
		t.logger = slog.Default()
	}
	if t.clock == nil {
		t.clock = func() time.Time { return time.Now().UTC() }
	}
	return t
}

// IsDown reports whether the exact candidate is currently marked unhealthy.
func (t *Tracker) IsDown(c Candidate) bool {
	c = c.Normalized()
	t.mu.Lock()
	defer t.mu.Unlock()
	_, ok := t.down[c]
	return ok
}

// Snapshot returns the current down candidates and skip debits.
func (t *Tracker) Snapshot() []Status {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]Status, 0, len(t.down))
	for c, down := range t.down {
		out = append(out, Status{
			Candidate: c,
			Down:      true,
			Reason:    down.reason,
			ChangedAt: down.changedAt,
			Skipped:   t.skipped[c],
		})
	}
	return out
}

// ForEachSkipped invokes fn for every candidate with a non-zero skip debit —
// the capacity a surface must account for so a down candidate's share is not
// silently reallocated to a healthy one. The callback runs under the Tracker
// lock; keep it cheap and do not call back into the Tracker from it.
func (t *Tracker) ForEachSkipped(fn func(c Candidate, skipped int)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for c, n := range t.skipped {
		if n > 0 {
			fn(c, n)
		}
	}
}

// RecordSkipIfDown debits one skipped slot against a candidate the surface just
// selected but found already down, and reports true so the caller can refuse the
// selection instead of substituting another candidate. A healthy candidate is
// left untouched and reports false.
func (t *Tracker) RecordSkipIfDown(c Candidate) bool {
	c = c.Normalized()
	t.mu.Lock()
	down, ok := t.down[c]
	if !ok {
		t.mu.Unlock()
		return false
	}
	t.skipped[c]++
	skipped := t.skipped[c]
	t.mu.Unlock()
	t.logger.Warn("candidate health: candidate skipped",
		"surface", c.Surface, "candidate", c.String(), "skipped", skipped, "reason", down.reason)
	return true
}

// MarkDown records a failed exact candidate when the caller has no attempt
// context to distinguish caller cancellation from candidate failure.
func (t *Tracker) MarkDown(c Candidate, err error) {
	t.markDown(c, err)
}

// MarkDownForAttempt records a failed exact-candidate attempt unless the caller's
// attempt context was canceled. This distinction matters because candidate-side
// startup probes may legitimately fail with errors wrapping context.Canceled or
// context.DeadlineExceeded; those are candidate failures when the caller's
// context is still active, and they must still debit the candidate and alert.
func (t *Tracker) MarkDownForAttempt(ctx context.Context, c Candidate, err error) {
	if attemptCanceled(ctx) {
		return
	}
	t.markDown(c, err)
}

// markDown records that an exact candidate failed to start or operate, capturing
// the observed reason and debiting a skipped slot. The user/operator-visible
// alert (telemetry event + warn log) fires only on the transition into the down
// state; a repeat failure of an already-down candidate logs a quieter "still
// down" line so the alert stream is not flooded. A nil candidate error is a
// no-op so callers can pass it unconditionally in a failure path.
func (t *Tracker) markDown(c Candidate, err error) {
	if err == nil {
		return
	}
	c = c.Normalized()
	reason := err.Error()
	t.mu.Lock()
	_, alreadyDown := t.down[c]
	t.down[c] = downState{reason: reason, changedAt: t.clock()}
	t.skipped[c]++
	skipped := t.skipped[c]
	t.mu.Unlock()
	if alreadyDown {
		t.logger.Warn("candidate health: candidate still down",
			"surface", c.Surface, "candidate", c.String(), "skipped", skipped, "reason", reason)
		return
	}
	t.logger.Warn("candidate health: candidate down",
		"surface", c.Surface, "candidate", c.String(), "skipped", skipped, "reason", reason)
	t.emit(EventCandidateDown, ports.TelemetryLevelWarn, c, reason, skipped)
}

// MarkRecovered clears a candidate's down state after a successful exact-candidate
// attempt. The recovery alert fires only when the candidate was actually down,
// so a routine success on a healthy candidate is silent.
func (t *Tracker) MarkRecovered(c Candidate) {
	c = c.Normalized()
	t.mu.Lock()
	_, wasDown := t.down[c]
	delete(t.down, c)
	delete(t.skipped, c)
	t.mu.Unlock()
	if !wasDown {
		return
	}
	t.logger.Info("candidate health: candidate recovered",
		"surface", c.Surface, "candidate", c.String())
	t.emit(EventCandidateRecovered, ports.TelemetryLevelInfo, c, "", 0)
}

func (t *Tracker) emit(name string, level ports.TelemetryLevel, c Candidate, reason string, skipped int) {
	if t.telemetry == nil {
		return
	}
	payload := map[string]any{
		"component": t.source,
		"surface":   c.Surface,
		"candidate": c.String(),
	}
	if c.Harness != "" {
		payload["harness"] = c.Harness
	}
	if c.Model != "" {
		payload["model"] = c.Model
	}
	if c.Provider != "" {
		payload["provider"] = c.Provider
	}
	if c.Account != "" {
		payload["account"] = c.Account
	}
	if c.Bot != "" {
		payload["bot"] = c.Bot
	}
	if reason != "" {
		payload["reason"] = reason
	}
	if skipped > 0 {
		payload["skipped"] = skipped
	}
	t.telemetry.Emit(context.Background(), ports.TelemetryEvent{
		Name:       name,
		Source:     t.source,
		OccurredAt: t.clock(),
		Level:      level,
		Payload:    payload,
	})
}
