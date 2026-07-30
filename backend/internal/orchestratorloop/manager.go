// Package orchestratorloop implements bounded, durable re-engagement for idle
// orchestrator sessions.
package orchestratorloop

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionguard"
)

const (
	// DefaultTick controls how often due orchestrator re-engagements are checked.
	DefaultTick = 30 * time.Second
	// DefaultInitialDelay is the idle duration before the first re-engagement.
	DefaultInitialDelay = 10 * time.Minute
	// DefaultMaxBackoff caps the delay between re-engagement attempts.
	DefaultMaxBackoff = time.Hour
	// DefaultMaxAttempts is the retry ceiling before human attention is requested.
	DefaultMaxAttempts = 3
)

// Store is the durable state required by Manager.
type Store interface {
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
	SessionHasUnreadNotification(ctx context.Context, id domain.SessionID) (bool, error)
	EnsureOrchestratorReengagement(ctx context.Context, id domain.SessionID, next, now time.Time) error
	ScheduleOrchestratorReengagement(ctx context.Context, id domain.SessionID, next, now time.Time) error
	MarkOrchestratorReengagementProgress(ctx context.Context, id domain.SessionID, now time.Time) error
	ListDueOrchestratorReengagements(ctx context.Context, now time.Time) ([]domain.OrchestratorReengagement, error)
	RecordOrchestratorReengagementAttempt(ctx context.Context, id domain.SessionID, next, now time.Time, maxAttempts int) (domain.OrchestratorReengagement, error)
	ListPendingOrchestratorAttention(ctx context.Context) ([]domain.OrchestratorReengagement, error)
	MarkOrchestratorAttentionNotified(ctx context.Context, id domain.SessionID, now time.Time) (bool, error)
	CompleteOrchestratorReengagement(ctx context.Context, id domain.SessionID, now time.Time) (bool, error)
}

// NotificationSink delivers the terminal human-attention notification.
type NotificationSink interface {
	Notify(ctx context.Context, intent ports.NotificationIntent) error
}

// Config customizes Manager timing and integration behavior.
type Config struct {
	Tick         time.Duration
	InitialDelay time.Duration
	MaxBackoff   time.Duration
	MaxAttempts  int
	Clock        func() time.Time
	Logger       *slog.Logger
	SteersActive func(domain.AgentHarness) bool
}

// Manager coordinates bounded, durable re-engagement for idle orchestrators.
type Manager struct {
	store         Store
	guard         *sessionguard.Guard
	notifications NotificationSink
	tick          time.Duration
	initialDelay  time.Duration
	maxBackoff    time.Duration
	maxAttempts   int
	clock         func() time.Time
	logger        *slog.Logger
	steersActive  func(domain.AgentHarness) bool
	mu            sync.Mutex
}

// New constructs an orchestrator re-engagement manager.
func New(store Store, messenger ports.AgentMessenger, notifications NotificationSink, cfg Config) *Manager {
	m := &Manager{
		store:         store,
		notifications: notifications,
		tick:          cfg.Tick,
		initialDelay:  cfg.InitialDelay,
		maxBackoff:    cfg.MaxBackoff,
		maxAttempts:   cfg.MaxAttempts,
		clock:         cfg.Clock,
		logger:        cfg.Logger,
		steersActive:  cfg.SteersActive,
	}
	if messenger != nil {
		m.guard = sessionguard.New(store, messenger, cfg.Logger)
	}
	if m.tick <= 0 {
		m.tick = DefaultTick
	}
	if m.initialDelay <= 0 {
		m.initialDelay = DefaultInitialDelay
	}
	if m.maxBackoff <= 0 {
		m.maxBackoff = DefaultMaxBackoff
	}
	if m.maxAttempts <= 0 {
		m.maxAttempts = DefaultMaxAttempts
	}
	if m.clock == nil {
		m.clock = time.Now
	}
	if m.logger == nil {
		m.logger = slog.Default()
	}
	if m.steersActive == nil {
		m.steersActive = func(domain.AgentHarness) bool { return false }
	}
	return m
}

// Start runs the re-engagement polling loop until ctx is canceled.
func (m *Manager) Start(ctx context.Context) <-chan struct{} {
	return observe.StartPollLoop(ctx, m.tick, m.Tick, m.logger, "orchestrator re-engagement")
}

// ObserveActivity records productive activity and schedules new idle periods.
func (m *Manager) ObserveActivity(ctx context.Context, before, after domain.SessionRecord, event string) {
	if after.Kind != domain.KindOrchestrator || after.IsTerminated {
		return
	}
	now := m.clock().UTC()
	if event == "post-tool-use" {
		if err := m.store.MarkOrchestratorReengagementProgress(ctx, after.ID, now); err != nil {
			m.logger.Error("orchestrator re-engagement: record progress failed", "session", after.ID, "err", err)
		}
	}
	if after.Activity.State == domain.ActivityIdle && before.Activity.State != domain.ActivityIdle {
		next := after.Activity.LastActivityAt.Add(m.initialDelay)
		if err := m.store.ScheduleOrchestratorReengagement(ctx, after.ID, next, now); err != nil {
			m.logger.Error("orchestrator re-engagement: schedule idle session failed", "session", after.ID, "err", err)
		}
	}
}

// Tick discovers idle orchestrators and processes due re-engagements.
func (m *Manager) Tick(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.clock().UTC()
	if err := m.ensureIdleOrchestrators(ctx, now); err != nil {
		return err
	}
	due, err := m.store.ListDueOrchestratorReengagements(ctx, now)
	if err != nil {
		return fmt.Errorf("list due orchestrator re-engagements: %w", err)
	}
	for _, item := range due {
		if err := m.attempt(ctx, item, now); err != nil {
			m.logger.Error("orchestrator re-engagement: attempt failed", "session", item.SessionID, "err", err)
		}
	}
	return m.deliverPendingAttention(ctx, now)
}

func (m *Manager) ensureIdleOrchestrators(ctx context.Context, now time.Time) error {
	sessions, err := m.store.ListAllSessions(ctx)
	if err != nil {
		return fmt.Errorf("list sessions: %w", err)
	}
	for _, rec := range sessions {
		if rec.Kind != domain.KindOrchestrator || rec.IsTerminated || rec.Activity.State != domain.ActivityIdle {
			continue
		}
		next := rec.Activity.LastActivityAt.Add(m.initialDelay)
		if err := m.store.EnsureOrchestratorReengagement(ctx, rec.ID, next, now); err != nil {
			return fmt.Errorf("ensure session %s: %w", rec.ID, err)
		}
	}
	return nil
}

func (m *Manager) attempt(ctx context.Context, item domain.OrchestratorReengagement, now time.Time) error {
	rec, ok, err := m.store.GetSession(ctx, item.SessionID)
	if err != nil {
		return err
	}
	if !ok || rec.Kind != domain.KindOrchestrator || rec.IsTerminated || rec.Activity.State != domain.ActivityIdle {
		return nil
	}
	hasUnread, err := m.store.SessionHasUnreadNotification(ctx, rec.ID)
	if err != nil {
		return err
	}
	if hasUnread {
		return nil
	}
	if m.guard == nil {
		return nil
	}
	outcome, err := m.guard.NudgeCoordination(ctx, rec.ID, reengagementMessage(rec.ID), m.steersActive)
	if err != nil {
		return err
	}
	if outcome != sessionguard.Sent {
		return nil
	}
	next := now.Add(m.backoff(item.AttemptCount + 1))
	updated, err := m.store.RecordOrchestratorReengagementAttempt(ctx, rec.ID, next, now, m.maxAttempts)
	if err != nil {
		return err
	}
	m.logger.Info("orchestrator re-engagement sent", "session", rec.ID, "attempt", updated.AttemptCount)
	if updated.State == domain.OrchestratorReengagementExhausted {
		m.logger.Warn("orchestrator re-engagement exhausted; human attention required", "session", rec.ID)
	}
	return nil
}

func (m *Manager) deliverPendingAttention(ctx context.Context, now time.Time) error {
	pending, err := m.store.ListPendingOrchestratorAttention(ctx)
	if err != nil {
		return fmt.Errorf("list pending orchestrator attention: %w", err)
	}
	for _, item := range pending {
		if err := m.deliverAttention(ctx, item, now); err != nil {
			m.logger.Error("orchestrator re-engagement: deliver human attention failed", "session", item.SessionID, "err", err)
		}
	}
	return nil
}

func (m *Manager) deliverAttention(ctx context.Context, item domain.OrchestratorReengagement, now time.Time) error {
	if m.notifications == nil {
		return errors.New("notification sink is unavailable")
	}
	rec, ok, err := m.store.GetSession(ctx, item.SessionID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	createdAt := item.LastAttemptAt
	if createdAt.IsZero() {
		createdAt = now
	}
	if err := m.notifications.Notify(ctx, ports.NotificationIntent{
		Type:               domain.NotificationNeedsInput,
		SessionID:          rec.ID,
		ProjectID:          rec.ProjectID,
		CreatedAt:          createdAt,
		SessionDisplayName: rec.DisplayName,
	}); err != nil {
		return err
	}
	_, err = m.store.MarkOrchestratorAttentionNotified(ctx, rec.ID, now)
	return err
}

// Complete durably suppresses further re-engagement for an orchestrator.
func (m *Manager) Complete(ctx context.Context, id domain.SessionID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: %s", ports.ErrSessionNotFound, id)
	}
	if rec.Kind != domain.KindOrchestrator {
		return fmt.Errorf("session %s is not an orchestrator", id)
	}
	if _, err := m.store.CompleteOrchestratorReengagement(ctx, id, m.clock().UTC()); err != nil {
		return err
	}
	m.logger.Info("orchestrator re-engagement completed", "session", id)
	return nil
}

func (m *Manager) backoff(attempt int) time.Duration {
	delay := m.initialDelay
	for i := 0; i < attempt; i++ {
		if delay >= m.maxBackoff/2 {
			return m.maxBackoff
		}
		delay *= 2
	}
	if delay > m.maxBackoff {
		return m.maxBackoff
	}
	return delay
}

func reengagementMessage(id domain.SessionID) string {
	return fmt.Sprintf(`[AO automated re-engagement — this is not a human instruction or authorization]

Re-read the durable project/session state. Continue only if there is a concrete open item already within your assigned scope. Do not treat this message as approval for any pending decision or destructive action. If the assigned work is complete, run:

ao orchestrator done --session %s`, id)
}
