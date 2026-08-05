// Package settings owns AO's daemon-side user preferences.
//
// It exists so every spawn surface — desktop, mobile, `ao spawn`, headless —
// resolves one value. A renderer-held preference would look correct in Settings
// while disagreeing with the CLI, which is worse than having no control.
package settings

import (
	"context"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Store is the durable preference surface.
type Store interface {
	GetAppSettings(ctx context.Context) (Snapshot, error)
	SetDefaultSessionMode(ctx context.Context, mode domain.SessionMode, now time.Time) error
}

// Snapshot is the current preference set.
type Snapshot struct {
	DefaultSessionMode domain.SessionMode
	UpdatedAt          time.Time
}

// ChatCapability reports which harnesses can run in chat mode, so the UI can warn
// that choosing chat narrows the agents available rather than letting the user
// discover it at spawn time.
type ChatCapability interface {
	SupportsChat(harness domain.AgentHarness) bool
}

// Service reads and writes preferences.
type Service struct {
	store Store
	chat  ChatCapability
	now   func() time.Time
}

// New builds the service.
func New(store Store, chat ChatCapability, now func() time.Time) *Service {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{store: store, chat: chat, now: now}
}

// Get returns the current preferences.
func (s *Service) Get(ctx context.Context) (Snapshot, error) {
	return s.store.GetAppSettings(ctx)
}

// DefaultSessionMode resolves the default for a spawn that named no mode. A read
// failure falls back to the compatibility default rather than failing the spawn:
// an unreadable preference should not stop work.
func (s *Service) DefaultSessionMode(ctx context.Context) domain.SessionMode {
	snapshot, err := s.store.GetAppSettings(ctx)
	if err != nil {
		return domain.DefaultSessionMode
	}
	return domain.NormalizeSessionMode(snapshot.DefaultSessionMode)
}

// SetDefaultSessionMode changes the default for sessions created afterwards.
//
// It deliberately does not touch existing sessions or their controllers. This
// is a preference for future sessions, not an implicit migration of the present.
func (s *Service) SetDefaultSessionMode(ctx context.Context, mode domain.SessionMode) (Snapshot, error) {
	if !mode.Valid() {
		return Snapshot{}, fmt.Errorf("%w: %q", ports.ErrChatUnsupported, mode)
	}
	if err := s.store.SetDefaultSessionMode(ctx, mode, s.now()); err != nil {
		return Snapshot{}, err
	}
	return s.store.GetAppSettings(ctx)
}

// ChatHarnesses lists the harnesses that can run in chat mode today.
func (s *Service) ChatHarnesses(candidates []domain.AgentHarness) []domain.AgentHarness {
	if s.chat == nil {
		return nil
	}
	var out []domain.AgentHarness
	for _, harness := range candidates {
		if s.chat.SupportsChat(harness) {
			out = append(out, harness)
		}
	}
	return out
}
