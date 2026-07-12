package notification

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Store is the notification service's read persistence surface.
type Store interface {
	ListUnreadNotifications(ctx context.Context, filter ListFilter) ([]domain.NotificationRecord, error)
	MarkNotificationRead(ctx context.Context, id string) (domain.NotificationRecord, bool, error)
	MarkAllNotificationsRead(ctx context.Context, excludeTypes []domain.NotificationType) ([]domain.NotificationRecord, error)
}
