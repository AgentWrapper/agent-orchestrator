// Package lifecycle implements the synchronous reducer that writes durable
// session lifecycle facts. It deliberately keeps the session model small:
// activity_state plus an is_terminated bit are the only persisted status-like
// facts on the session row.
package lifecycle

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type sessionStore interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
	UpdateSession(ctx context.Context, rec domain.SessionRecord) error
	// ListPRsBySession returns every PR row tracked for the session. The
	// reducer reads it to apply the multi-PR completion rule (terminate only
	// when no open PR remains and at least one merged) and to suppress
	// merge-conflict nudges on PRs stacked behind an open parent.
	ListPRsBySession(ctx context.Context, id domain.SessionID) ([]domain.PullRequest, error)
	// GetPRLastNudgeSignature / UpdatePRLastNudgeSignature persist the
	// reaction-dedup map so nudges survive a daemon restart.
	GetPRLastNudgeSignature(ctx context.Context, prURL string) (string, error)
	UpdatePRLastNudgeSignature(ctx context.Context, prURL, payload string) error
}

// notificationSink is the optional lifecycle-to-notification-producer boundary.
type notificationSink interface {
	Notify(ctx context.Context, intent ports.NotificationIntent) error
}

// Option customizes a Manager.
type Option func(*Manager)

// WithNotificationSink wires lifecycle notification intents to a write-side producer.
func WithNotificationSink(sink notificationSink) Option {
	return func(m *Manager) { m.notifications = sink }
}

// WithTelemetry wires lifecycle activity transitions to the shared telemetry sink.
func WithTelemetry(sink ports.EventSink) Option {
	return func(m *Manager) { m.telemetry = sink }
}

// Manager reduces runtime, activity, spawn, and termination observations into durable session facts.
// It also owns agent nudges caused by PR observations, including merge-conflict, CI-failure, and review-feedback prompts.
type Manager struct {
	store         sessionStore
	messenger     ports.AgentMessenger
	notifications notificationSink

	mu        sync.Mutex
	window    time.Duration
	clock     func() time.Time
	react     reactionState
	telemetry ports.EventSink
	// switching holds sessions currently mid agent-switch: the old runtime has
	// been (or is about to be) torn down and the new one is not yet live, so a
	// reaper "dead" fact would otherwise wrongly terminate them.
	// ApplyRuntimeObservation skips any session in this set. Guarded by mu.
	switching map[domain.SessionID]struct{}
}

// New builds a Lifecycle Manager over the session store it writes and the messenger it uses for agent nudges.
func New(store sessionStore, messenger ports.AgentMessenger, opts ...Option) *Manager {
	// UTC so activity-driven LastActivityAt/UpdatedAt match spawn-stamped
	// timestamps (the session manager clock is UTC too); a local clock here left
	// `ao session get` showing created in UTC but updated in local time. A
	// WithClock option may still override this in tests.
	clock := func() time.Time { return time.Now().UTC() }
	m := &Manager{store: store, messenger: messenger, window: defaultRecentActivityWindow, clock: clock, react: newReactionState(), switching: make(map[domain.SessionID]struct{})}
	for _, opt := range opts {
		opt(m)
	}
	return m
}

func (m *Manager) mutate(ctx context.Context, id domain.SessionID, fn func(domain.SessionRecord, time.Time) (domain.SessionRecord, bool)) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil || !ok {
		return err
	}
	now := m.clock()
	next, changed := fn(rec, now)
	if !changed {
		return nil
	}
	next.UpdatedAt = now
	if err := m.store.UpdateSession(ctx, next); err != nil {
		return err
	}
	return nil
}

// ApplyRuntimeObservation only writes when runtime liveness is unambiguous. A
// failed probe or liveness disagreement is ignored; no transient lifecycle state is stored.
func (m *Manager) ApplyRuntimeObservation(ctx context.Context, id domain.SessionID, f ports.RuntimeFacts) error {
	return m.mutate(ctx, id, func(cur domain.SessionRecord, now time.Time) (domain.SessionRecord, bool) {
		// A session mid agent-switch has no live runtime by design; ignore the
		// reaper's "dead" fact so the swap is not mistaken for a crash.
		if _, sw := m.switching[id]; sw {
			return cur, false
		}
		if cur.IsTerminated || !runtimeClearlyDead(f, cur.Activity, now, m.window) {
			return cur, false
		}
		next := cur
		next.IsTerminated = true
		next.Activity = domain.Activity{State: domain.ActivityExited, LastActivityAt: timeOr(f.ObservedAt, now)}
		return next, true
	})
}

// ApplyActivitySignal records an authoritative agent activity signal.
func (m *Manager) ApplyActivitySignal(ctx context.Context, id domain.SessionID, s ports.ActivitySignal) error {
	if !s.Valid {
		return nil
	}
	var intent *ports.NotificationIntent
	m.mu.Lock()
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ports.ErrSessionNotFound, id)
	}
	now := m.clock()
	if rec.IsTerminated {
		m.mu.Unlock()
		return nil
	}
	prevState := rec.Activity.State
	prevAt := rec.Activity.LastActivityAt
	next := rec
	act := domain.Activity{State: s.State, LastActivityAt: timeOr(s.Timestamp, now)}
	// A same-state repeat is still a write when it is the FIRST signal for
	// this spawn: the receipt itself is a durable fact (it clears the
	// no_signal display status). Hook deliveries are best-effort, so the
	// first to ARRIVE may match the seeded state — e.g. a turn's "active"
	// POST is lost and its Stop hook lands idle on the idle-seeded row.
	if sameActivity(rec.Activity, act) && !rec.FirstSignalAt.IsZero() {
		m.mu.Unlock()
		return nil
	}
	next.Activity = act
	if next.FirstSignalAt.IsZero() {
		next.FirstSignalAt = timeOr(s.Timestamp, now)
	}
	if s.State == domain.ActivityExited {
		next.IsTerminated = true
	}
	next.UpdatedAt = now
	if err := m.store.UpdateSession(ctx, next); err != nil {
		m.mu.Unlock()
		return err
	}
	if rec.Activity.State != domain.ActivityWaitingInput && next.Activity.State == domain.ActivityWaitingInput && !next.IsTerminated {
		intent = &ports.NotificationIntent{
			Type:               domain.NotificationNeedsInput,
			SessionID:          next.ID,
			ProjectID:          next.ProjectID,
			CreatedAt:          next.Activity.LastActivityAt,
			SessionDisplayName: next.DisplayName,
		}
	}
	waitingEvents := m.waitingInputEvents(next, prevState, prevAt, now)
	m.mu.Unlock()
	for _, ev := range waitingEvents {
		m.emitTelemetry(ctx, ev)
	}
	m.emitNotification(ctx, intent)
	return nil
}

func (m *Manager) waitingInputEvents(next domain.SessionRecord, prevState domain.ActivityState, prevAt, now time.Time) []ports.TelemetryEvent {
	if m.telemetry == nil {
		return nil
	}
	projectID := next.ProjectID
	sessionID := next.ID
	var events []ports.TelemetryEvent
	if prevState != domain.ActivityWaitingInput && next.Activity.State == domain.ActivityWaitingInput && !next.IsTerminated {
		events = append(events, ports.TelemetryEvent{
			Name:       "ao.session.waiting_input_entered",
			Source:     "lifecycle",
			OccurredAt: now.UTC(),
			Level:      ports.TelemetryLevelInfo,
			ProjectID:  &projectID,
			SessionID:  &sessionID,
			Payload: map[string]any{
				"state": string(next.Activity.State),
			},
		})
	}
	if prevState == domain.ActivityWaitingInput && next.Activity.State != domain.ActivityWaitingInput {
		payload := map[string]any{
			"state":     string(next.Activity.State),
			"dwell_ms":  now.Sub(prevAt).Milliseconds(),
			"exited_to": string(next.Activity.State),
		}
		events = append(events, ports.TelemetryEvent{
			Name:       "ao.session.waiting_input_exited",
			Source:     "lifecycle",
			OccurredAt: now.UTC(),
			Level:      ports.TelemetryLevelInfo,
			ProjectID:  &projectID,
			SessionID:  &sessionID,
			Payload:    payload,
		})
	}
	return events
}

func (m *Manager) emitTelemetry(ctx context.Context, ev ports.TelemetryEvent) {
	if m.telemetry == nil {
		return
	}
	m.telemetry.Emit(ctx, ev)
}

func (m *Manager) emitNotification(ctx context.Context, intent *ports.NotificationIntent) {
	if intent == nil || m.notifications == nil {
		return
	}
	if err := m.notifications.Notify(ctx, *intent); err != nil {
		slog.Default().Warn("lifecycle: notification failed", "session", intent.SessionID, "type", intent.Type, "err", err)
	}
}

// MarkSpawned marks a newly spawned or restored session live and stores runtime/workspace handles.
func (m *Manager) MarkSpawned(ctx context.Context, id domain.SessionID, metadata domain.SessionMetadata) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("lifecycle: MarkSpawned for unknown session %q", id)
	}
	now := m.clock()
	rec.IsTerminated = false
	rec.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	// Each spawn/restore must re-prove its hook pipeline: clear the receipt so
	// a relaunch with broken hooks degrades to no_signal instead of inheriting
	// a stale "signals worked once" fact.
	rec.FirstSignalAt = time.Time{}
	rec.Metadata = mergeMetadata(rec.Metadata, metadata)
	rec.UpdatedAt = now
	return m.store.UpdateSession(ctx, rec)
}

// MarkTerminated marks a session terminated without tearing down external resources.
func (m *Manager) MarkTerminated(ctx context.Context, id domain.SessionID) error {
	return m.mutate(ctx, id, func(cur domain.SessionRecord, now time.Time) (domain.SessionRecord, bool) {
		if cur.IsTerminated {
			return cur, false
		}
		cur.IsTerminated = true
		cur.Activity = domain.Activity{State: domain.ActivityExited, LastActivityAt: now}
		return cur, true
	})
}

// TryBeginSwitch atomically claims the switch guard for id: it returns true and
// marks the session mid-switch, or false if a switch is already in flight. The
// check-and-set is a single critical section so two concurrent switches cannot
// both proceed and race two teardown/relaunch cycles over one worktree. While
// the guard is held, ApplyRuntimeObservation ignores the reaper's "dead" fact
// (the window where the old runtime is gone and the new one is not yet live).
// Pair a true result with EndSwitch (defer it).
func (m *Manager) TryBeginSwitch(id domain.SessionID) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.switching[id]; ok {
		return false
	}
	m.switching[id] = struct{}{}
	return true
}

// EndSwitch clears the mid-switch guard set by BeginSwitch. Idempotent.
func (m *Manager) EndSwitch(id domain.SessionID) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.switching, id)
}

// IsSwitching reports whether a switch is currently in flight for id, so a
// caller can reject a concurrent switch on the same session.
func (m *Manager) IsSwitching(id domain.SessionID) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.switching[id]
	return ok
}

// MarkSwitched atomically re-points a live session at a new agent harness and
// runtime handle, clearing the harness-specific native resume id. Unlike
// MarkSpawned (whose mergeMetadata only sets non-empty fields) it both changes
// the persisted harness and CLEARS AgentSessionID, so a later restore does not
// try to native-resume the previous agent's session. Activity resets to idle
// and the first-signal receipt clears so the new agent re-proves its hook
// pipeline (a hookless harness will read as no_signal after the grace period).
func (m *Manager) MarkSwitched(ctx context.Context, id domain.SessionID, harness domain.AgentHarness, metadata domain.SessionMetadata) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("lifecycle: MarkSwitched for unknown session %q", id)
	}
	now := m.clock()
	rec.Harness = harness
	rec.IsTerminated = false
	rec.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	rec.FirstSignalAt = time.Time{}
	rec.Metadata.RuntimeHandleID = metadata.RuntimeHandleID
	// Persist the launch worktree: a terminated relaunch may restore to a
	// different path (changed session prefix / managed root), and a stale
	// WorkspacePath/Branch would break later terminal/workspace/cleanup ops.
	if metadata.WorkspacePath != "" {
		rec.Metadata.WorkspacePath = metadata.WorkspacePath
	}
	if metadata.Branch != "" {
		rec.Metadata.Branch = metadata.Branch
	}
	if metadata.LaunchedHarnesses != nil {
		rec.Metadata.LaunchedHarnesses = metadata.LaunchedHarnesses
	}
	// The new agent starts without the old agent's native resume id; its own
	// hook re-reports one after launch.
	rec.Metadata.AgentSessionID = ""
	rec.UpdatedAt = now
	return m.store.UpdateSession(ctx, rec)
}

// sameActivity reports whether two activity signals describe the same state.
// LastActivityAt is intentionally ignored: same-state repeats (e.g. a stream
// of idle notifications) must not rewrite UpdatedAt or fan out a CDC event.
// LastActivityAt now marks when this state was first entered since the last
// transition, which is the timestamp a UI actually wants.
func sameActivity(a, b domain.Activity) bool {
	return a.State == b.State
}

func mergeMetadata(base, in domain.SessionMetadata) domain.SessionMetadata {
	set := func(dst *string, v string) {
		if v != "" {
			*dst = v
		}
	}
	set(&base.Branch, in.Branch)
	set(&base.WorkspacePath, in.WorkspacePath)
	set(&base.RuntimeHandleID, in.RuntimeHandleID)
	set(&base.AgentSessionID, in.AgentSessionID)
	set(&base.Prompt, in.Prompt)
	return base
}
