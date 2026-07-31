// Package events owns committed cloud-event fanout. PostgreSQL is authoritative;
// this in-process bus is only the live edge after durable append.
package events

import (
	"context"
	"encoding/json"
	"sync"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

type store interface {
	AppendEvent(context.Context, clouddomain.AccountID, clouddomain.SessionID, string, json.RawMessage) (clouddomain.Event, error)
	AppendUserMessage(context.Context, clouddomain.AccountID, clouddomain.SessionID, string, string) (clouddomain.Event, bool, error)
	EventsAfter(context.Context, clouddomain.AccountID, clouddomain.SessionID, int64, int) ([]clouddomain.Event, error)
	ChatEventsAfter(context.Context, clouddomain.AccountID, clouddomain.SessionID, int64, int) ([]clouddomain.Event, error)
	ResultEventsAfter(context.Context, clouddomain.AccountID, clouddomain.SessionID, int64, int) ([]clouddomain.Event, error)
	ActivePromptEventsAfter(context.Context, clouddomain.AccountID, clouddomain.SessionID, int64, int) ([]clouddomain.Event, error)
}

// Service appends durable events and fans them out to live subscribers.
type Service struct {
	store store
	mu    sync.RWMutex
	next  uint64
	subs  map[uint64]subscription
}

type subscription struct {
	accountID clouddomain.AccountID
	sessionID clouddomain.SessionID
	deliver   func(clouddomain.Event)
}

// New creates an event service backed by store.
func New(store store) *Service {
	return &Service{store: store, subs: make(map[uint64]subscription)}
}

// Append durably records an event and publishes it to live subscribers.
func (s *Service) Append(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	eventType string,
	payload json.RawMessage,
) (clouddomain.Event, error) {
	event, err := s.store.AppendEvent(ctx, accountID, sessionID, eventType, payload)
	if err != nil {
		return clouddomain.Event{}, err
	}
	s.publish(accountID, event)
	return event, nil
}

// AppendUserMessage durably records an idempotent prompt and publishes new events.
func (s *Service) AppendUserMessage(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	idempotencyKey, text string,
) (clouddomain.Event, error) {
	event, created, err := s.store.AppendUserMessage(ctx, accountID, sessionID, idempotencyKey, text)
	if err != nil {
		return clouddomain.Event{}, err
	}
	if created {
		s.publish(accountID, event)
	}
	return event, nil
}

// Replay returns durable session events after the given sequence.
func (s *Service) Replay(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	after int64,
	limit int,
) ([]clouddomain.Event, error) {
	return s.store.EventsAfter(ctx, accountID, sessionID, after, limit)
}

// ReplayChat returns durable native chat events after the given sequence.
func (s *Service) ReplayChat(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	after int64,
	limit int,
) ([]clouddomain.Event, error) {
	return s.store.ChatEventsAfter(ctx, accountID, sessionID, after, limit)
}

// ReplayResults returns structured chat output plus terminal-first completion
// hooks that carry a harness's final answer.
func (s *Service) ReplayResults(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	after int64,
	limit int,
) ([]clouddomain.Event, error) {
	return s.store.ResultEventsAfter(ctx, accountID, sessionID, after, limit)
}

// ReplayActivePrompts returns only prompts still owned by an unfinished turn.
func (s *Service) ReplayActivePrompts(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	after int64,
	limit int,
) ([]clouddomain.Event, error) {
	return s.store.ActivePromptEventsAfter(ctx, accountID, sessionID, after, limit)
}

// Subscribe registers a live event callback and returns its unsubscribe function.
func (s *Service) Subscribe(
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	deliver func(clouddomain.Event),
) func() {
	s.mu.Lock()
	id := s.next
	s.next++
	s.subs[id] = subscription{accountID: accountID, sessionID: sessionID, deliver: deliver}
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.subs, id)
		s.mu.Unlock()
	}
}

func (s *Service) publish(accountID clouddomain.AccountID, event clouddomain.Event) {
	s.mu.RLock()
	deliveries := make([]func(clouddomain.Event), 0)
	for _, subscriber := range s.subs {
		if subscriber.accountID == accountID && subscriber.sessionID == event.SessionID {
			deliveries = append(deliveries, subscriber.deliver)
		}
	}
	s.mu.RUnlock()
	for _, deliver := range deliveries {
		deliver(event)
	}
}
