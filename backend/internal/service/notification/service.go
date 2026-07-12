package notification

import (
	"context"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

const (
	// DefaultListLimit is the unread notification page size used when none is requested.
	DefaultListLimit = 50
	// MaxListLimit caps unread notification API responses.
	MaxListLimit = 100
)

// Manager reads stored notifications for REST controllers.
type Manager struct {
	store Store
}

// Deps configures a Manager.
type Deps struct {
	Store Store
}

// New constructs a read-only notification Manager.
func New(d Deps) *Manager {
	return &Manager{store: d.Store}
}

// ListUnread returns unread notifications newest-first.
func (m *Manager) ListUnread(ctx context.Context, filter ListFilter) ([]Notification, error) {
	if m == nil || m.store == nil {
		return nil, errors.New("notification: store is required")
	}
	filter.Limit = normalizeLimit(filter.Limit)
	rows, err := m.store.ListUnreadNotifications(ctx, filter)
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

// MarkAllRead marks notification-center unread rows read while preserving
// durable operator-attention rows whose underlying condition may still persist.
func (m *Manager) MarkAllRead(ctx context.Context) ([]Notification, error) {
	if m == nil || m.store == nil {
		return nil, errors.New("notification: store is required")
	}
	rows, err := m.store.MarkAllNotificationsRead(ctx, domain.OperatorAttentionNotificationTypes())
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
	if limit <= 0 {
		return DefaultListLimit
	}
	if limit > MaxListLimit {
		return MaxListLimit
	}
	return limit
}

func notificationFromRecord(rec domain.NotificationRecord) Notification {
	rec = rec.WithInferredSubject()
	return Notification{
		NotificationRecord: rec,
		Subject:            Subject{Kind: rec.SubjectKind, ID: rec.SubjectID},
		Target:             targetForRecord(rec),
	}
}

func targetForRecord(rec domain.NotificationRecord) Target {
	rec = rec.WithInferredSubject()
	if rec.SubjectKind == domain.NotificationSubjectPR && rec.PRURL != "" {
		return Target{Kind: TargetPR, SessionID: rec.SessionID, PRURL: rec.PRURL}
	}
	if rec.SubjectKind == domain.NotificationSubjectSession {
		return Target{Kind: TargetSession, SessionID: rec.SessionID}
	}
	return Target{Kind: TargetNone}
}
