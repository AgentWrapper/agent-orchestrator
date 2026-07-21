package notification

import (
	"context"
	"errors"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

const (
	// DefaultListLimit returns the full retained window when no limit is requested.
	DefaultListLimit = 0
	// MaxListLimit caps explicitly bounded notification API responses.
	MaxListLimit = 1000
)

// Manager reads stored notifications for REST controllers.
type Manager struct {
	store Store
	clock func() time.Time
}

// Deps configures a Manager.
type Deps struct {
	Store Store
	Clock func() time.Time
}

// New constructs a read-only notification Manager.
func New(d Deps) *Manager {
	clock := d.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Manager{store: d.Store, clock: clock}
}

// List returns retained notifications newest-first. Dashboard history is a
// rolling seven-day window; status selects unread-only or all records.
func (m *Manager) List(ctx context.Context, filter ListFilter) ([]Notification, error) {
	if m == nil || m.store == nil {
		return nil, errors.New("notification: store is required")
	}
	if filter.Status == "" {
		filter.Status = ListUnread
	}
	if !filter.Status.Valid() {
		return nil, apierr.Invalid("INVALID_NOTIFICATION_STATUS", "Notification status must be unread or all", nil)
	}
	limit := normalizeLimit(filter.Limit)
	since := m.clock().UTC().Add(-domain.NotificationRetentionWindow)
	rows, err := m.store.ListNotifications(ctx, filter.Status, since, limit)
	if err != nil {
		return nil, err
	}
	out := make([]Notification, 0, len(rows))
	for _, row := range rows {
		out = append(out, notificationFromRecord(row))
	}
	return out, nil
}

// MarkRead marks one unread notification read.
func (m *Manager) MarkRead(ctx context.Context, id string) (Notification, bool, error) {
	if m == nil || m.store == nil {
		return Notification{}, false, errors.New("notification: store is required")
	}
	if id == "" {
		return Notification{}, false, apierr.Invalid("INVALID_NOTIFICATION_ID", "Notification id is required", nil)
	}
	row, ok, err := m.store.MarkNotificationRead(ctx, id)
	if err != nil {
		return Notification{}, false, err
	}
	if !ok {
		return Notification{}, false, apierr.NotFound("NOTIFICATION_NOT_FOUND", "Unknown unread notification")
	}
	return notificationFromRecord(row), true, nil
}

// MarkAllRead marks all unread notifications read.
func (m *Manager) MarkAllRead(ctx context.Context) ([]Notification, error) {
	if m == nil || m.store == nil {
		return nil, errors.New("notification: store is required")
	}
	rows, err := m.store.MarkAllNotificationsRead(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Notification, 0, len(rows))
	for _, row := range rows {
		out = append(out, notificationFromRecord(row))
	}
	return out, nil
}

func normalizeLimit(limit int) int {
	if limit < 0 {
		return DefaultListLimit
	}
	if limit > MaxListLimit {
		return MaxListLimit
	}
	return limit
}

func notificationFromRecord(rec domain.NotificationRecord) Notification {
	return Notification{NotificationRecord: rec, Target: targetForRecord(rec)}
}

func targetForRecord(rec domain.NotificationRecord) Target {
	if rec.PRURL != "" {
		return Target{Kind: TargetPR, SessionID: rec.SessionID, PRURL: rec.PRURL}
	}
	return Target{Kind: TargetSession, SessionID: rec.SessionID}
}
