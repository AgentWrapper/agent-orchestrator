package orchestratorloop

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeStore struct {
	mu       sync.Mutex
	sessions map[domain.SessionID]domain.SessionRecord
	states   map[domain.SessionID]domain.OrchestratorReengagement
	unread   map[domain.SessionID]bool
}

func (s *fakeStore) SessionHasUnreadNotification(_ context.Context, id domain.SessionID) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.unread[id], nil
}

func (s *fakeStore) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.SessionRecord, 0, len(s.sessions))
	for _, rec := range s.sessions {
		out = append(out, rec)
	}
	return out, nil
}

func (s *fakeStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.sessions[id]
	return rec, ok, nil
}

func (s *fakeStore) EnsureOrchestratorReengagement(_ context.Context, id domain.SessionID, next, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.states[id]; !ok {
		s.states[id] = domain.OrchestratorReengagement{SessionID: id, NextAttemptAt: next, State: domain.OrchestratorReengagementActive, CreatedAt: now, UpdatedAt: now}
	}
	return nil
}

func (s *fakeStore) ScheduleOrchestratorReengagement(_ context.Context, id domain.SessionID, next, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.states[id]
	if !ok {
		state = domain.OrchestratorReengagement{SessionID: id, CreatedAt: now}
	}
	if state.State == domain.OrchestratorReengagementCompleted {
		return nil
	}
	if state.ProgressSinceAttempt {
		state.AttemptCount = 0
		state.NextAttemptAt = next
		state.State = domain.OrchestratorReengagementActive
		state.AttentionNotified = false
	}
	if state.NextAttemptAt.IsZero() {
		state.NextAttemptAt = next
	}
	state.ProgressSinceAttempt = false
	state.UpdatedAt = now
	s.states[id] = state
	return nil
}

func (s *fakeStore) MarkOrchestratorReengagementProgress(_ context.Context, id domain.SessionID, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.states[id]
	if ok && state.State != domain.OrchestratorReengagementCompleted {
		state.ProgressSinceAttempt = true
		state.UpdatedAt = now
		s.states[id] = state
	}
	return nil
}

func (s *fakeStore) ListDueOrchestratorReengagements(_ context.Context, now time.Time) ([]domain.OrchestratorReengagement, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []domain.OrchestratorReengagement
	for _, state := range s.states {
		if state.State == domain.OrchestratorReengagementActive && !state.NextAttemptAt.After(now) {
			out = append(out, state)
		}
	}
	return out, nil
}

func (s *fakeStore) RecordOrchestratorReengagementAttempt(_ context.Context, id domain.SessionID, next, now time.Time, maxAttempts int) (domain.OrchestratorReengagement, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[id]
	state.AttemptCount++
	state.NextAttemptAt = next
	state.LastAttemptAt = now
	state.ProgressSinceAttempt = false
	if state.AttemptCount >= maxAttempts {
		state.State = domain.OrchestratorReengagementExhausted
	}
	state.UpdatedAt = now
	s.states[id] = state
	return state, nil
}

func (s *fakeStore) ListPendingOrchestratorAttention(context.Context) ([]domain.OrchestratorReengagement, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []domain.OrchestratorReengagement
	for _, state := range s.states {
		if state.State == domain.OrchestratorReengagementExhausted && !state.AttentionNotified {
			out = append(out, state)
		}
	}
	return out, nil
}

func (s *fakeStore) MarkOrchestratorAttentionNotified(_ context.Context, id domain.SessionID, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.states[id]
	if !ok || state.State != domain.OrchestratorReengagementExhausted || state.AttentionNotified {
		return false, nil
	}
	state.AttentionNotified = true
	state.UpdatedAt = now
	s.states[id] = state
	return true, nil
}

func (s *fakeStore) CompleteOrchestratorReengagement(_ context.Context, id domain.SessionID, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[id]
	state.SessionID = id
	state.State = domain.OrchestratorReengagementCompleted
	state.AttentionNotified = true
	state.UpdatedAt = now
	s.states[id] = state
	return true, nil
}

type fakeMessenger struct {
	messages []string
}

func (m *fakeMessenger) Send(_ context.Context, _ domain.SessionID, message string) error {
	m.messages = append(m.messages, message)
	return nil
}

type fakeNotifications struct {
	intents []ports.NotificationIntent
	err     error
}

func (n *fakeNotifications) Notify(_ context.Context, intent ports.NotificationIntent) error {
	n.intents = append(n.intents, intent)
	return n.err
}

func testManager(store *fakeStore, messenger *fakeMessenger, notifications *fakeNotifications, now time.Time) *Manager {
	return New(store, messenger, notifications, Config{
		Clock:        func() time.Time { return now },
		InitialDelay: time.Minute,
		MaxBackoff:   10 * time.Minute,
		MaxAttempts:  3,
		Tick:         time.Hour,
	})
}

func TestTickReengagesOnlyIdleOrchestrator(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{
		sessions: map[domain.SessionID]domain.SessionRecord{
			"orch": {ID: "orch", ProjectID: "p", Kind: domain.KindOrchestrator, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-2 * time.Minute)}},
			"wait": {ID: "wait", ProjectID: "p", Kind: domain.KindOrchestrator, Activity: domain.Activity{State: domain.ActivityWaitingInput, LastActivityAt: now.Add(-2 * time.Minute)}},
			"work": {ID: "work", ProjectID: "p", Kind: domain.KindWorker, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-2 * time.Minute)}},
		},
		states: map[domain.SessionID]domain.OrchestratorReengagement{},
	}
	messenger := &fakeMessenger{}
	manager := testManager(store, messenger, &fakeNotifications{}, now)
	if err := manager.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(messenger.messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(messenger.messages))
	}
	message := messenger.messages[0]
	for _, want := range []string{"AO automated re-engagement", "not a human instruction or authorization", "ao orchestrator done --session orch"} {
		if !strings.Contains(message, want) {
			t.Fatalf("message missing %q:\n%s", want, message)
		}
	}
	if got := store.states["orch"].AttemptCount; got != 1 {
		t.Fatalf("attempt count = %d, want 1", got)
	}
	if _, ok := store.states["wait"]; ok {
		t.Fatal("waiting-input orchestrator was scheduled")
	}
	if _, ok := store.states["work"]; ok {
		t.Fatal("worker was scheduled")
	}
}

func TestTickExhaustsAndNotifiesAfterBoundedAttempts(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	rec := domain.SessionRecord{ID: "orch", ProjectID: "p", DisplayName: "coordinator", Kind: domain.KindOrchestrator, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-time.Hour)}}
	store := &fakeStore{
		sessions: map[domain.SessionID]domain.SessionRecord{"orch": rec},
		states: map[domain.SessionID]domain.OrchestratorReengagement{
			"orch": {SessionID: "orch", AttemptCount: 2, NextAttemptAt: now, State: domain.OrchestratorReengagementActive},
		},
	}
	messenger := &fakeMessenger{}
	notifications := &fakeNotifications{}
	manager := testManager(store, messenger, notifications, now)
	if err := manager.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := store.states["orch"].State; got != domain.OrchestratorReengagementExhausted {
		t.Fatalf("state = %q, want exhausted", got)
	}
	if len(notifications.intents) != 1 || notifications.intents[0].Type != domain.NotificationNeedsInput {
		t.Fatalf("notifications = %#v", notifications.intents)
	}
	if !store.states["orch"].AttentionNotified {
		t.Fatal("successful terminal notification was not recorded")
	}
	if err := manager.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(messenger.messages) != 1 {
		t.Fatalf("exhausted loop sent again: %d messages", len(messenger.messages))
	}
}

func TestTickRetriesDurablePendingAttentionAfterFailure(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	rec := domain.SessionRecord{ID: "orch", ProjectID: "p", DisplayName: "coordinator", Kind: domain.KindOrchestrator, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-time.Hour)}}
	store := &fakeStore{
		sessions: map[domain.SessionID]domain.SessionRecord{"orch": rec},
		states: map[domain.SessionID]domain.OrchestratorReengagement{
			"orch": {SessionID: "orch", AttemptCount: 3, LastAttemptAt: now.Add(-time.Minute), State: domain.OrchestratorReengagementExhausted},
		},
	}
	notifications := &fakeNotifications{err: errors.New("temporary notification failure")}
	manager := testManager(store, &fakeMessenger{}, notifications, now)

	if err := manager.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.states["orch"].AttentionNotified {
		t.Fatal("failed notification was marked delivered")
	}

	notifications.err = nil
	if err := manager.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !store.states["orch"].AttentionNotified {
		t.Fatal("retried notification was not marked delivered")
	}
	if len(notifications.intents) != 2 {
		t.Fatalf("notification attempts = %d, want 2", len(notifications.intents))
	}

	if err := manager.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(notifications.intents) != 2 {
		t.Fatalf("delivered notification retried again: %d attempts", len(notifications.intents))
	}
}

func TestTickDefersWhileHumanNotificationIsPending(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	rec := domain.SessionRecord{ID: "orch", ProjectID: "p", Kind: domain.KindOrchestrator, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-time.Hour)}}
	store := &fakeStore{
		sessions: map[domain.SessionID]domain.SessionRecord{"orch": rec},
		states: map[domain.SessionID]domain.OrchestratorReengagement{
			"orch": {SessionID: "orch", NextAttemptAt: now, State: domain.OrchestratorReengagementActive},
		},
		unread: map[domain.SessionID]bool{"orch": true},
	}
	messenger := &fakeMessenger{}
	manager := testManager(store, messenger, &fakeNotifications{}, now)
	if err := manager.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(messenger.messages) != 0 {
		t.Fatalf("pending human notification did not defer re-engagement: %d messages", len(messenger.messages))
	}
}

func TestObserveActivityResetsOnlyAfterToolProgressAndIdle(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{
		sessions: map[domain.SessionID]domain.SessionRecord{},
		states: map[domain.SessionID]domain.OrchestratorReengagement{
			"orch": {SessionID: "orch", AttemptCount: 2, NextAttemptAt: now, State: domain.OrchestratorReengagementExhausted},
		},
	}
	manager := testManager(store, &fakeMessenger{}, &fakeNotifications{}, now)
	active := domain.SessionRecord{ID: "orch", Kind: domain.KindOrchestrator, Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now}}
	manager.ObserveActivity(context.Background(), active, active, "post-tool-use")
	if !store.states["orch"].ProgressSinceAttempt {
		t.Fatal("post-tool-use did not record progress")
	}
	idle := active
	idle.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	manager.ObserveActivity(context.Background(), active, idle, "stop")
	state := store.states["orch"]
	if state.AttemptCount != 0 || state.State != domain.OrchestratorReengagementActive || state.ProgressSinceAttempt {
		t.Fatalf("state after progress and idle = %#v", state)
	}
}

func TestCompleteDurablyStopsReengagement(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	rec := domain.SessionRecord{ID: "orch", ProjectID: "p", Kind: domain.KindOrchestrator, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-time.Hour)}}
	store := &fakeStore{sessions: map[domain.SessionID]domain.SessionRecord{"orch": rec}, states: map[domain.SessionID]domain.OrchestratorReengagement{}}
	messenger := &fakeMessenger{}
	manager := testManager(store, messenger, &fakeNotifications{}, now)
	if err := manager.Complete(context.Background(), "orch"); err != nil {
		t.Fatal(err)
	}
	if err := manager.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(messenger.messages) != 0 {
		t.Fatalf("completed orchestrator received %d messages", len(messenger.messages))
	}
}
