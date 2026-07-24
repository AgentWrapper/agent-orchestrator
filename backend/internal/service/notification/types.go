// Package notification exposes read-only notification DTOs for REST controllers.
package notification

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// TargetKind describes what a dashboard should navigate to for a notification.
type TargetKind string

const (
	// TargetSession navigates to a session detail view.
	TargetSession TargetKind = "session"
	// TargetPR navigates to a pull request view.
	TargetPR TargetKind = "pr"
)

// Target is the service-facing navigation metadata for a notification.
type Target struct {
	Kind      TargetKind
	SessionID domain.SessionID
	PRURL     string
}

// Notification is the dashboard-facing service DTO assembled from a stored row.
type Notification struct {
	domain.NotificationRecord
	Target Target
}

// ListStatus selects which stored notifications are returned.
type ListStatus = domain.NotificationListStatus

const (
	// ListUnread returns only notifications that still need acknowledgement.
	ListUnread = domain.NotificationListUnread
	// ListAll returns both read and unread notifications.
	ListAll = domain.NotificationListAll
)

// ListFilter controls paginated notification history.
type ListFilter struct {
	Status ListStatus
	Limit  int
	Cursor string
}

// ListPage is one newest-first page of notification history.
type ListPage struct {
	Notifications []Notification
	NextCursor    string
	UnreadCount   int
}
