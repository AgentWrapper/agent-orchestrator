// Package lifecycle implements the synchronous reducer that writes durable
// session lifecycle facts. It deliberately keeps the session model small:
// activity_state plus an is_terminated bit are the only persisted status-like
// facts on the session row.
package lifecycle

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionguard"
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

// WithSCMCommenter wires the optional outbound SCM comment surface used by the
// duplicate-PR guard (issue #181) to auto-comment on a newer duplicate PR. When
// unset, the guard still fires the notification but skips the comment.
func WithSCMCommenter(commenter ports.SCMCommenter) Option {
	return func(m *Manager) { m.commenter = commenter }
}

// WithTelemetry wires lifecycle activity transitions to the shared telemetry sink.
func WithTelemetry(sink ports.EventSink) Option {
	return func(m *Manager) { m.telemetry = sink }
}

// Manager reduces runtime, activity, spawn, and termination observations into durable session facts.
// It also owns agent nudges caused by PR observations, including merge-conflict, CI-failure, and review-feedback prompts.
type Manager struct {
	store sessionStore
	// guard is the shared pane-write primitive every reaction nudge goes
	// through (see sessionguard). Nil when no messenger was wired: reaction
	// nudges become no-ops but the reducer still runs.
	guard         *sessionguard.Guard
	notifications notificationSink
	commenter     ports.SCMCommenter

	mu        sync.Mutex
	window    time.Duration
	clock     func() time.Time
	react     reactionState
	telemetry ports.EventSink
	// switching holds sessions currently mid agent-switch: the old runtime has
	// been (or is about to be) torn down and the new one is not yet live, so a
	// stale "dead/exited" fact would otherwise wrongly terminate them.
	switching map[domain.SessionID]struct{}
	// switchExitSuppressUntil suppresses late exit facts from the retired
	// runtime after MarkSwitched points the session at the replacement.
	switchExitSuppressUntil map[domain.SessionID]time.Time
	// flights tracks, per session, the in-flight tool executions and the
	// pending permission dialog's identity (see toolFlight). Guarded by mu.
	flights map[domain.SessionID]*toolFlight
	// terminationIntents holds the declared cause of an in-progress teardown
	// (kill, retirement), recorded BEFORE the runtime is destroyed and keyed by
	// a per-teardown token. Every terminal attributor consults it: the reaper
	// attributes a death observed during the teardown window to the intent
	// instead of its generic probe reason, a clean harness exit VOIDS the
	// intent (a session that finished on its own was not "killed"), and the
	// teardown's final mark may set its own cause only while its token still
	// matches. In-memory by design: the window is in-process seconds, and a
	// daemon restart mid-teardown degrades to the generic reaper attribution
	// rather than fabricating causality. Guarded by mu.
	terminationIntents map[domain.SessionID]terminationIntent
}

// terminationIntent is one declared teardown cause (see Manager.terminationIntents).
type terminationIntent struct {
	cause string
	token string
}

// New builds a Lifecycle Manager over the session store it writes and the messenger it uses for agent nudges.
func New(store sessionStore, messenger ports.AgentMessenger, opts ...Option) *Manager {
	// UTC so activity-driven LastActivityAt/UpdatedAt match spawn-stamped
	// timestamps (the session manager clock is UTC too); a local clock here left
	// `ao session get` showing created in UTC but updated in local time. A
	// WithClock option may still override this in tests.
	clock := func() time.Time { return time.Now().UTC() }
	m := &Manager{
		store:                   store,
		window:                  defaultRecentActivityWindow,
		clock:                   clock,
		react:                   newReactionState(),
		switching:               make(map[domain.SessionID]struct{}),
		switchExitSuppressUntil: make(map[domain.SessionID]time.Time),
		flights:                 make(map[domain.SessionID]*toolFlight),
		terminationIntents:      make(map[domain.SessionID]terminationIntent),
	}
	if messenger != nil {
		m.guard = sessionguard.New(store, messenger, nil)
	}
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
		// A session mid agent-switch has no live runtime by design, and a
		// just-retired runtime can still report dead briefly; ignore those
		// stale facts so the replacement is not mistaken for a crash.
		if m.suppressesSwitchExitLocked(id, now) {
			return cur, false
		}
		if cur.IsTerminated || !runtimeClearlyDead(f, cur.Activity, now, m.window) {
			return cur, false
		}
		next := cur
		next.IsTerminated = true
		// A death observed while a teardown intent is declared is attributed to
		// that intent (the kill/retirement destroyed the runtime); the generic
		// probe reason speaks only when nothing else has. The intent stays
		// recorded so the teardown's final mark still owns its token.
		if intent, ok := m.terminationIntents[id]; ok { // under m.mu (mutate holds it)
			next.TerminalFailureReason = intent.cause
		} else {
			next.TerminalFailureReason = runtimeTerminalFailureReason(f)
		}
		next.Activity = domain.Activity{State: domain.ActivityExited, LastActivityAt: timeOr(f.ObservedAt, now)}
		// Reaper-driven death (crash/SIGKILL) never fires a session-end hook,
		// so this is the last chance to release the session's tool-flight
		// state; a leaked entry would otherwise persist for the daemon's life
		// (later observations return early on cur.IsTerminated). Runs under
		// m.mu — mutate holds it across this callback.
		delete(m.flights, id)
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
	if foreignHarnessSignal(rec, s) {
		m.mu.Unlock()
		return nil
	}
	if staleRuntimeTokenSignal(rec, s) {
		m.mu.Unlock()
		return nil
	}
	if staleSwitchExitSignal(rec, s) && m.suppressesSwitchExitLocked(id, now) {
		m.mu.Unlock()
		return nil
	}
	if rec.IsTerminated {
		delete(m.flights, id)
		m.mu.Unlock()
		return nil
	}
	// Event-tagged signals fold through the session's tool-flight state first:
	// they may be suppressed (state write skipped) by the blocked-precedence
	// rule, while their tracking side effects still land. Untagged signals
	// (old CLIs, adapters without tool identity) pass through untouched —
	// last-writer-wins, exactly as before.
	s = m.applyToolPrecedenceLocked(id, rec.Activity.State, s)
	if !s.Valid {
		m.mu.Unlock()
		return nil
	}
	usageEvent, hasUsageEvent := usageTelemetryEvent(rec, s, now)
	prevState := rec.Activity.State
	prevAt := rec.Activity.LastActivityAt
	next := rec
	act := domain.Activity{State: s.State, LastActivityAt: timeOr(s.Timestamp, now)}
	pendingDecision := stampDecisionRevision(rec.Metadata.PendingDecision, nextPendingDecision(s))
	// A same-state repeat is still a write when it is the FIRST signal for
	// this spawn: the receipt itself is a durable fact (it clears the
	// no_signal display status). Hook deliveries are best-effort, so the
	// first to ARRIVE may match the seeded state — e.g. a turn's "active"
	// POST is lost and its Stop hook lands idle on the idle-seeded row.
	if sameActivity(rec.Activity, act) && pendingDecisionEqual(rec.Metadata.PendingDecision, pendingDecision) && !rec.FirstSignalAt.IsZero() {
		m.mu.Unlock()
		if hasUsageEvent {
			m.emitTelemetry(ctx, usageEvent)
		}
		return nil
	}
	next.Activity = act
	next.Metadata.PendingDecision = pendingDecision
	if next.FirstSignalAt.IsZero() {
		next.FirstSignalAt = timeOr(s.Timestamp, now)
	}
	if s.State == domain.ActivityExited {
		next.IsTerminated = true
		next.TerminalFailureReason = ""
		// A harness that reports its own exit ended cleanly — even mid-teardown.
		// Void any declared teardown intent so neither the reaper nor the
		// teardown's final mark can rewrite a clean ending as killed/retired.
		delete(m.terminationIntents, id) // under m.mu (held here)
	}
	next.UpdatedAt = now
	if err := m.store.UpdateSession(ctx, next); err != nil {
		m.mu.Unlock()
		return err
	}
	if shouldEmitNeedsInputNotification(rec, next) && !next.IsTerminated {
		intent = &ports.NotificationIntent{
			Type:               domain.NotificationNeedsInput,
			SessionID:          next.ID,
			ProjectID:          next.ProjectID,
			CreatedAt:          next.Activity.LastActivityAt,
			SessionDisplayName: next.DisplayName,
		}
	}
	waitingEvents := m.waitingInputEvents(next, prevState, prevAt, now)
	if hasUsageEvent {
		waitingEvents = append(waitingEvents, usageEvent)
	}
	m.mu.Unlock()
	for _, ev := range waitingEvents {
		m.emitTelemetry(ctx, ev)
	}
	m.emitNotification(ctx, intent)
	return nil
}

func pendingDecisionEqual(a, b *domain.PendingDecision) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Kind == b.Kind && a.Question == b.Question && slices.Equal(a.Options, b.Options)
}

func nextPendingDecision(s ports.ActivitySignal) *domain.PendingDecision {
	if s.State != domain.ActivityBlocked {
		return nil
	}
	if s.PendingDecision != nil {
		decision := *s.PendingDecision
		if decision.Options != nil {
			decision.Options = append([]string(nil), decision.Options...)
		}
		return &decision
	}
	return &domain.PendingDecision{Kind: domain.DecisionKindPermission}
}

// stampDecisionRevision gives the incoming pending decision its durable
// identity: a dialog whose content matches the currently stored one keeps the
// stored revision (hook repeats must not churn identity), while new or changed
// content mints a fresh revision. AnswerDecision compare-and-swaps against this
// revision, so question B replacing A can never be answered with an option
// prepared against A.
func stampDecisionRevision(current, next *domain.PendingDecision) *domain.PendingDecision {
	if next == nil {
		return nil
	}
	if pendingDecisionEqual(current, next) && current.Revision != "" {
		next.Revision = current.Revision
		return next
	}
	next.Revision = newDecisionRevision()
	return next
}

// newDecisionRevision mints a random 64-bit hex token. Uniqueness matters only
// within one session's short-lived stream of dialogs; on the improbable
// rand.Read failure a timestamp still distinguishes consecutive dialogs.
func newDecisionRevision() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buf[:])
}

func shouldEmitNeedsInputNotification(prev, next domain.SessionRecord) bool {
	switch next.Activity.State {
	case domain.ActivityWaitingInput:
		// Daemon-role wake cycles normally end at an empty prompt again; that
		// healthy idle cadence must not page the operator every turn.
		return !isDaemonRole(next.Kind) && !prev.Activity.State.NeedsInput()
	case domain.ActivityBlocked:
		if !prev.Activity.State.NeedsInput() {
			return true
		}
		// A daemon role's prior waiting_input may have been intentionally
		// suppressed, so a later decision block is its first real page.
		return isDaemonRole(next.Kind) && prev.Activity.State == domain.ActivityWaitingInput
	default:
		return false
	}
}

func isDaemonRole(kind domain.SessionKind) bool {
	return kind == domain.KindOrchestrator || kind == domain.KindPrime
}

// toolFlight tracks one session's in-flight tool executions and the pending
// permission dialog's identity, so a sticky `blocked` is cleared by the post
// of the exact approved tool — and by nothing else tool-shaped. Answering a
// permission dialog fires no hook of its own, so the approved tool's
// post-tool-use is the earliest observable "the decision was resolved"
// signal; but tool hooks also fire for parallel subagents on the same
// session, whose traffic must never clear a dialog that is still on screen.
// In-memory only: a daemon restart loses it and the session degrades to
// clearing at the next turn boundary — fail-safe staleness, never a spurious
// clear.
type toolFlight struct {
	// inflight maps toolUseID -> toolName for pre-tool-use signals whose post
	// has not arrived yet.
	inflight map[string]string
	// blockedTool is the tool_name of the pending permission dialog ("" when
	// the blocking signal carried no tool identity — then nothing tool-shaped
	// may clear the block).
	blockedTool string
	// blockedCandidate is the tool-use id of the UNIQUE in-flight tool bearing
	// blockedTool when the dialog appeared — the tool whose post proves the
	// dialog was answered. Empty when no in-flight tool matched, or when the
	// match was ambiguous (see ambiguousBlock); either way nothing tool-shaped
	// may clear the block and it lifts only at a turn boundary.
	blockedCandidate string
	// ambiguousBlock is set when two or more in-flight tools shared
	// blockedTool at dialog time: the permission payload carries no tool_use_id
	// to disambiguate, so a sibling's post must NOT be mistaken for the
	// approval. Fail closed — clear only at a turn boundary.
	ambiguousBlock bool
}

// maxInflightTools caps a session's in-flight map so lost posts cannot grow
// it without bound; hitting the cap resets the map, degrading that session to
// turn-boundary clearing (fail-safe).
const maxInflightTools = 128

// isToolUseEvent reports whether the AO hook event is one of the tool-use
// trio whose signals must not demote a sticky state on their own.
func isToolUseEvent(event string) bool {
	return event == "pre-tool-use" || event == "post-tool-use" || event == "post-tool-use-failure"
}

// isTurnBoundaryEvent reports the events that reliably mean the pending
// dialog is gone: a prompt cannot be submitted while a dialog holds the
// composer, and a turn cannot end (or the session exit) with one on screen.
func isTurnBoundaryEvent(event string) bool {
	return event == "user-prompt-submit" || event == "stop" || event == "session-end"
}

// applyToolPrecedenceLocked folds an event-tagged activity signal through the
// session's tool-flight state and decides whether its state write may
// proceed. Returned signal with Valid=false means "suppressed": the tracking
// side effects have landed but the state must not change. Signals without an
// Event pass through untouched — the compatibility contract for old CLIs and
// for adapters that don't tag their signals (their last-writer-wins semantics
// are pinned by tests). Caller must hold m.mu.
func (m *Manager) applyToolPrecedenceLocked(id domain.SessionID, cur domain.ActivityState, s ports.ActivitySignal) ports.ActivitySignal {
	if s.Event == "" {
		return s
	}
	suppressed := s
	suppressed.Valid = false

	fl := m.flights[id]
	ensure := func() *toolFlight {
		if fl == nil {
			fl = &toolFlight{inflight: map[string]string{}}
			m.flights[id] = fl
		}
		return fl
	}

	// Tracking side effects happen regardless of what the state decision is.
	switch s.Event {
	case "pre-tool-use":
		if s.ToolUseID != "" {
			f := ensure()
			if len(f.inflight) >= maxInflightTools {
				f.inflight = map[string]string{}
			}
			f.inflight[s.ToolUseID] = s.ToolName
		}
	case "post-tool-use", "post-tool-use-failure":
		if fl != nil {
			delete(fl.inflight, s.ToolUseID)
		}
	}

	switch {
	case s.State == domain.ActivityBlocked:
		// Entering (or re-asserting) blocked: snapshot the dialog's identity.
		// permission-request carries the blocking tool_name; the Notification
		// duplicate does not and must not wipe an existing snapshot.
		//
		// The permission hook payload does not carry the blocking tool's
		// tool_use_id (only its name), so we can only identify the blocking
		// tool unambiguously when EXACTLY ONE in-flight tool bears that name.
		// With two same-name tools in flight (a batch of Bash calls, one of
		// them the one at the dialog), a sibling's post could otherwise clear
		// a still-open dialog — the exact permission-bypass this change exists
		// to prevent. So we correlate only in the unique case; otherwise no
		// candidate is recorded and the block clears only at a turn boundary
		// (fail-closed).
		f := ensure()
		if s.ToolName != "" {
			// Recompute from scratch: this is a fresh dialog, so any candidate
			// or ambiguity carried from a prior one must not leak in.
			f.blockedTool = s.ToolName
			f.blockedCandidate = ""
			f.ambiguousBlock = false
			for useID, name := range f.inflight {
				if name != f.blockedTool {
					continue
				}
				if f.blockedCandidate != "" {
					// A second same-name tool: ambiguous, fail closed.
					f.blockedCandidate = ""
					f.ambiguousBlock = true
					break
				}
				f.blockedCandidate = useID
			}
		}
		return s

	case cur == domain.ActivityBlocked:
		// Paused on a decision: only a turn boundary or the correlated post
		// may change the state.
		switch {
		case isTurnBoundaryEvent(s.Event):
			delete(m.flights, id)
			return s
		case (s.Event == "post-tool-use" || s.Event == "post-tool-use-failure") &&
			fl != nil && !fl.ambiguousBlock && fl.blockedCandidate != "" && s.ToolUseID == fl.blockedCandidate:
			// The single unambiguous blocking tool finished: the dialog was
			// answered. Clear the block identity so a later dialog in the same
			// turn starts from a clean slate.
			fl.blockedTool = ""
			fl.blockedCandidate = ""
			fl.ambiguousBlock = false
			return s
		default:
			// Subagent/sibling tool traffic (including a same-name sibling when
			// the block was ambiguous), notification sub-types (idle_prompt,
			// agent_completed), and anything else that is not proof the dialog
			// closed.
			return suppressed
		}

	case cur.IsSticky() && isToolUseEvent(s.Event):
		// waiting_input: background tool traffic must not clear the "waiting
		// on the user" marker; only an explicit user/turn signal does.
		return suppressed

	default:
		if isTurnBoundaryEvent(s.Event) {
			delete(m.flights, id)
		}
		return s
	}
}

func usageTelemetryEvent(rec domain.SessionRecord, s ports.ActivitySignal, now time.Time) (ports.TelemetryEvent, bool) {
	payload := usageTelemetryPayload(s.Usage)
	if len(payload) == 0 {
		return ports.TelemetryEvent{}, false
	}
	harness := rec.Harness
	if harness == "" {
		harness = s.Harness
	}
	if harness != "" {
		payload["harness"] = string(harness)
	} else {
		payload["harness"] = "unknown"
	}
	projectID := rec.ProjectID
	sessionID := rec.ID
	return ports.TelemetryEvent{
		Name:       "ao.session.usage",
		Source:     "lifecycle",
		OccurredAt: now.UTC(),
		Level:      ports.TelemetryLevelInfo,
		ProjectID:  &projectID,
		SessionID:  &sessionID,
		Payload:    payload,
	}, true
}

func usageTelemetryPayload(usage *ports.UsageSignal) map[string]any {
	if usage == nil {
		return nil
	}
	payload := map[string]any{}
	addUsageNumber(payload, "input_tokens", usage.InputTokens)
	addUsageNumber(payload, "output_tokens", usage.OutputTokens)
	addUsageNumber(payload, "total_tokens", usage.TotalTokens)
	addUsageNumber(payload, "cost_usd", usage.CostUSD)
	return payload
}

func addUsageNumber(payload map[string]any, key string, v *float64) {
	if v == nil {
		return
	}
	f := *v
	if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > maxUsageNumericField {
		return
	}
	payload[key] = f
}

const maxUsageNumericField = 1e14

func (m *Manager) waitingInputEvents(next domain.SessionRecord, prevState domain.ActivityState, prevAt, now time.Time) []ports.TelemetryEvent {
	if m.telemetry == nil {
		return nil
	}
	projectID := next.ProjectID
	sessionID := next.ID
	var events []ports.TelemetryEvent
	// Entry/exit is measured on the needs-input family boundary (waiting_input
	// or blocked): the event names stay waiting_input_* for dashboard
	// continuity, the payload state distinguishes the two, and an in-family
	// transition emits neither event so dwell covers the whole pause.
	if !prevState.NeedsInput() && next.Activity.State.NeedsInput() && !next.IsTerminated {
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
	if prevState.NeedsInput() && !next.Activity.State.NeedsInput() {
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
	if err := m.emitNotificationErr(ctx, intent); err != nil {
		slog.Default().Warn("lifecycle: notification failed", "session", intent.SessionID, "type", intent.Type, "err", err)
	}
}

// emitNotificationErr publishes the notification and returns the sink error so
// callers that gate persisted dedupe state on a successful write can react to a
// failed write instead of recording a never-delivered notification as sent.
func (m *Manager) emitNotificationErr(ctx context.Context, intent *ports.NotificationIntent) error {
	if intent == nil || m.notifications == nil {
		return nil
	}
	return m.notifications.Notify(ctx, *intent)
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
	rec.TerminalFailureReason = ""
	// A fresh runtime invalidates any teardown intent from a previous one.
	delete(m.terminationIntents, id) // under m.mu (held here)
	rec.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	// Each spawn/restore must re-prove its hook pipeline: clear the receipt so
	// a relaunch with broken hooks degrades to no_signal instead of inheriting
	// a stale "signals worked once" fact.
	rec.FirstSignalAt = time.Time{}
	rec.Metadata = mergeMetadata(rec.Metadata, metadata)
	rec.UpdatedAt = now
	return m.store.UpdateSession(ctx, rec)
}

// MarkTerminated marks a session terminated without tearing down external
// resources and records no failure reason (an empty reason reads as "ended
// normally", never "unknown failure"). An already-terminated row is untouched.
func (m *Manager) MarkTerminated(ctx context.Context, id domain.SessionID) error {
	return m.mutate(ctx, id, func(cur domain.SessionRecord, now time.Time) (domain.SessionRecord, bool) {
		if cur.IsTerminated {
			return cur, false
		}
		cur.IsTerminated = true
		cur.TerminalFailureReason = ""
		cur.Activity = domain.Activity{State: domain.ActivityExited, LastActivityAt: now}
		delete(m.flights, id) // runs under m.mu (mutate holds it)
		return cur, true
	})
}

// RecordTerminationIntent declares, BEFORE any teardown I/O starts, that the
// caller is about to terminate the session for the given cause. It returns the
// token the teardown's final MarkTerminatedIntent must present. Every other
// terminal attributor consults the intent during the teardown window: the
// reaper attributes a death to it instead of the generic probe reason, and a
// clean harness exit voids it (finishing on your own is not being killed).
//
// A session that is ALREADY terminated gets no intent (empty token): a cleanup
// teardown of a long-dead session must not rewrite how it actually ended.
func (m *Manager) RecordTerminationIntent(ctx context.Context, id domain.SessionID, cause string) (string, error) {
	cause = strings.TrimSpace(cause)
	if cause == "" {
		return "", nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		return "", err
	}
	if !ok || rec.IsTerminated {
		return "", nil
	}
	token := newDecisionRevision() // same cheap random-token shape
	m.terminationIntents[id] = terminationIntent{cause: cause, token: token}
	return token, nil
}

// CancelTerminationIntent voids a declared teardown intent by its token. A
// teardown that exits WITHOUT completing (runtime destroy failed, dirty
// workspace preserved, any error return) must cancel, or the lingering intent
// would misattribute a later unrelated death to a teardown that never finished.
// Token-scoped so a teardown can only void its own declaration; cancelling
// after a successful final mark is a harmless no-op (the mark consumed the
// token).
func (m *Manager) CancelTerminationIntent(id domain.SessionID, token string) {
	if token == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if intent, ok := m.terminationIntents[id]; ok && intent.token == token {
		delete(m.terminationIntents, id)
	}
}

// MarkTerminatedIntent is the final mark of a teardown that declared its intent
// up front. While the presented token still matches the recorded intent, the
// mark owns causality: it terminates the row (if the reaper has not already)
// and sets its own cause — including over the reaper's attribution for the same
// intent. A mismatching or empty token means the intent was voided (the session
// exited cleanly during the teardown) or was never recorded (cleanup of an
// already-terminated session): the mark then only ensures the row is terminated
// and never touches an existing cause — a clean-exit record is never upgraded.
func (m *Manager) MarkTerminatedIntent(ctx context.Context, id domain.SessionID, token, cause string) error {
	cause = strings.TrimSpace(cause)
	return m.mutate(ctx, id, func(cur domain.SessionRecord, now time.Time) (domain.SessionRecord, bool) {
		intent, intentHeld := m.terminationIntents[id] // under m.mu (mutate holds it)
		owns := token != "" && intentHeld && intent.token == token
		if owns {
			delete(m.terminationIntents, id)
		}
		if cur.IsTerminated {
			// While the token matches, the only reasons a terminated row can
			// carry are the reaper's attributions for this same teardown (the
			// generic probe reason, or this intent's cause): a clean exit would
			// have voided the intent and a foreign teardown is excluded by the
			// per-session command slot. Owning the intent therefore owns the
			// cause; not owning it may touch nothing.
			if owns && cur.TerminalFailureReason != cause {
				cur.TerminalFailureReason = cause
				return cur, true
			}
			return cur, false
		}
		cur.IsTerminated = true
		if owns {
			cur.TerminalFailureReason = cause
		} else {
			cur.TerminalFailureReason = ""
		}
		cur.Activity = domain.Activity{State: domain.ActivityExited, LastActivityAt: now}
		delete(m.flights, id)
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

func (m *Manager) suppressesSwitchExitLocked(id domain.SessionID, now time.Time) bool {
	if _, sw := m.switching[id]; sw {
		return true
	}
	until, ok := m.switchExitSuppressUntil[id]
	if !ok {
		return false
	}
	if now.Before(until) || now.Equal(until) {
		return true
	}
	delete(m.switchExitSuppressUntil, id)
	return false
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
// runtime handle. Unlike MarkSpawned (whose mergeMetadata only sets non-empty
// fields) it changes the persisted harness and replaces AgentSessionID with the
// target harness's native resume id, which may be empty until the new agent's
// hook reports one. Activity resets to idle and the first-signal receipt clears
// so the new agent re-proves its hook pipeline (a hookless harness will read as
// no_signal after the grace period).
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
	m.switchExitSuppressUntil[id] = now.Add(switchExitSignalSuppressTime)
	rec.Harness = harness
	rec.IsTerminated = false
	rec.TerminalFailureReason = ""
	// A fresh runtime invalidates any teardown intent from the retired one.
	delete(m.terminationIntents, id) // under m.mu (held here)
	rec.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	rec.FirstSignalAt = time.Time{}
	rec.Metadata.RuntimeHandleID = metadata.RuntimeHandleID
	rec.Metadata.RuntimeToken = metadata.RuntimeToken
	// Persist the launch worktree: a terminated relaunch may restore to a
	// different path (changed session prefix / managed root), and a stale
	// WorkspacePath/Branch would break later terminal/workspace/cleanup ops.
	if metadata.WorkspacePath != "" {
		rec.Metadata.WorkspacePath = metadata.WorkspacePath
	}
	if metadata.Branch != "" {
		rec.Metadata.Branch = metadata.Branch
	}
	// Carry the workspace mode across a harness switch for the same reason the
	// path and branch are carried: losing it would silently demote an in-place
	// session to worktree on the next restore.
	if metadata.WorkspaceMode.IsKnown() {
		rec.Metadata.WorkspaceMode = metadata.WorkspaceMode
	}
	if metadata.Prompt != "" {
		rec.Metadata.Prompt = metadata.Prompt
	}
	rec.Metadata.Model = metadata.Model
	if metadata.LaunchedHarnesses != nil {
		rec.Metadata.LaunchedHarnesses = metadata.LaunchedHarnesses
	}
	if metadata.AgentSessionIDs != nil {
		rec.Metadata.AgentSessionIDs = metadata.AgentSessionIDs
	}
	rec.Metadata.AgentSessionID = metadata.AgentSessionID
	rec.UpdatedAt = now
	return m.store.UpdateSession(ctx, rec)
}

func foreignHarnessSignal(rec domain.SessionRecord, s ports.ActivitySignal) bool {
	return rec.Harness != "" && domain.HookReportingHarness(rec.Harness) != s.Harness
}

func staleSwitchExitSignal(rec domain.SessionRecord, s ports.ActivitySignal) bool {
	return s.State == domain.ActivityExited &&
		strings.TrimSpace(s.RuntimeToken) == "" &&
		rec.Harness != "" &&
		s.Harness != "" &&
		rec.Harness != s.Harness &&
		domain.HookReportingHarness(rec.Harness) == s.Harness
}

func staleRuntimeTokenSignal(rec domain.SessionRecord, s ports.ActivitySignal) bool {
	currentToken := strings.TrimSpace(rec.Metadata.RuntimeToken)
	if currentToken == "" {
		return false
	}
	signalToken := strings.TrimSpace(s.RuntimeToken)
	return signalToken == "" || signalToken != currentToken
}

// runtimeProbeDeadReason is the GENERIC death reason the reaper records when it
// observes a dead runtime without knowing why it died. MarkTerminatedReason
// treats it as upgradeable: a later explicit cause (a kill, a retirement) may
// replace it, never the reverse.
const runtimeProbeDeadReason = "runtime probe reported dead"

func runtimeTerminalFailureReason(f ports.RuntimeFacts) string {
	if f.Probe == ports.ProbeDead {
		return runtimeProbeDeadReason
	}
	return ""
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
	set(&base.RuntimeToken, in.RuntimeToken)
	set(&base.AgentSessionID, in.AgentSessionID)
	set(&base.Prompt, in.Prompt)
	set(&base.Model, in.Model)
	set(&base.PreviewURL, in.PreviewURL)
	// WorkspaceMode is not a plain string merge: the zero value is meaningful
	// (it reads as "worktree" for every session spawned before the field
	// existed), so only a known mode may overwrite the base. Dropping it here
	// would persist "" for an in-place session, which normalizes back to
	// worktree on the next restore and relocates the session into a worktree
	// it never had.
	if in.WorkspaceMode.IsKnown() {
		base.WorkspaceMode = in.WorkspaceMode
	}
	if in.PreviewRevision != 0 {
		base.PreviewRevision = in.PreviewRevision
	}
	if in.LaunchedHarnesses != nil {
		base.LaunchedHarnesses = in.LaunchedHarnesses
	}
	if in.AgentSessionIDs != nil {
		base.AgentSessionIDs = in.AgentSessionIDs
	}
	return base
}
