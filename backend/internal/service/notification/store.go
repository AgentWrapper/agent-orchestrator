package notification

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Store is the notification service's read persistence surface.
type Store interface {
	ListNotifications(ctx context.Context, status ListStatus, since time.Time, limit int) ([]domain.NotificationRecord, error)
	MarkNotificationRead(ctx context.Context, id string) (domain.NotificationRecord, bool, error)
	MarkAllNotificationsRead(ctx context.Context) ([]domain.NotificationRecord, error)
}
