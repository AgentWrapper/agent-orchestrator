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

// ListStatus controls which stored notifications are returned.
type ListStatus string

const (
	// ListStatusUnread returns only unread notifications.
	ListStatusUnread ListStatus = "unread"
	// ListStatusAll returns recent notifications across read states.
	ListStatusAll ListStatus = "all"
)

// ListFilter controls notification listing.
type ListFilter struct {
	Status ListStatus
	Limit  int
}
