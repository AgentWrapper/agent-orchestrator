// Package notify owns notification write-side production and live dashboard fan-out.
package notify

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const defaultPublishTimeout = 2 * time.Second

// Store is the write-side notification persistence boundary.
type Store interface {
	CreateNotification(ctx context.Context, rec domain.NotificationRecord) (domain.NotificationRecord, bool, error)
}

// Publisher pushes newly persisted notifications to live dashboard subscribers.
type Publisher interface {
	Publish(ctx context.Context, rec domain.NotificationRecord) error
}

// Intent is the lifecycle-to-notification producer contract.
type Intent = ports.NotificationIntent

// Manager validates lifecycle intents, enriches them into stored rows, persists
// unread notifications, and publishes newly inserted rows to live subscribers.
type Manager struct {
	store          Store
	publisher      Publisher
	publishTimeout time.Duration
	clock          func() time.Time
	newID          func() string
}

// Deps configures a Manager.
type Deps struct {
	Store          Store
	Publisher      Publisher
	PublishTimeout time.Duration
	Clock          func() time.Time
	NewID          func() string
}

// New constructs a write-side notification manager.
func New(d Deps) *Manager {
	m := &Manager{
		store:          d.Store,
		publisher:      d.Publisher,
		publishTimeout: d.PublishTimeout,
		clock:          d.Clock,
		newID:          d.NewID,
	}
	if m.publishTimeout <= 0 {
		m.publishTimeout = defaultPublishTimeout
	}
	if m.clock == nil {
		m.clock = time.Now
	}
	if m.newID == nil {
		m.newID = func() string { return "ntf_" + uuid.NewString() }
	}
	return m
}

// Notify stores one notification intent and publishes it after persistence.
// Duplicate unread rows are treated as a clean no-op.
func (m *Manager) Notify(ctx context.Context, intent Intent) error {
	if m == nil || m.store == nil {
		return errors.New("notify: store is required")
	}
	if intent.CreatedAt.IsZero() {
		intent.CreatedAt = m.clock().UTC()
	}
	rec, err := enrich(intent)
	if err != nil {
		return fmt.Errorf("notify enrich: %w", err)
	}
	rec.ID = m.newID()
	created, inserted, err := m.store.CreateNotification(ctx, rec)
	if err != nil {
		return fmt.Errorf("notify store: %w", err)
	}
	if !inserted || m.publisher == nil {
		return nil
	}
	if err := m.publish(ctx, created); err != nil {
		return fmt.Errorf("notify publish: %w", err)
	}
	return nil
}

func (m *Manager) publish(ctx context.Context, rec domain.NotificationRecord) error {
	if m.publishTimeout <= 0 {
		return m.publisher.Publish(ctx, rec)
	}
	pubCtx, cancel := context.WithTimeout(ctx, m.publishTimeout)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- m.publisher.Publish(pubCtx, rec)
	}()

	select {
	case err := <-errCh:
		return err
	case <-pubCtx.Done():
		return pubCtx.Err()
	}
}
