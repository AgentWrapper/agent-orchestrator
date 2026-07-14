// Package notification exposes read-only notification DTOs for REST controllers.
package notification

import (
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TargetKind describes what a dashboard should navigate to for a notification.
type TargetKind string

const (
	// TargetSession navigates to a session detail view.
	TargetSession TargetKind = "session"
	// TargetPR navigates to a pull request view.
	TargetPR TargetKind = "pr"
	// TargetNone means the notification has no dashboard navigation target.
	TargetNone TargetKind = "none"
)

// Target is the service-facing navigation metadata for a notification.
type Target struct {
	Kind      TargetKind
	SessionID domain.SessionID
	PRURL     string
}

// Subject describes the durable entity a notification is about.
type Subject struct {
	Kind domain.NotificationSubjectKind
	ID   string
}

// Notification is the dashboard-facing service DTO assembled from a stored row.
type Notification struct {
	domain.NotificationRecord
	Subject Subject
	Target  Target
}

// ListFilter controls unread notification listing.
type ListFilter struct {
	Limit int
	Types []domain.NotificationType
	// SensitiveOnly restricts the listing to rows with the sensitive flag set.
	// The operator-attention projection uses it so unbounded routine (non-
	// sensitive) ready_to_merge rows can never consume the page budget that
	// durable escalations share.
	SensitiveOnly bool
	// CreatedBefore / BeforeID form an exclusive composite pagination cursor
	// over the newest-first ordering (created_at DESC, id DESC): rows strictly
	// older than CreatedBefore, plus rows at exactly CreatedBefore with a
	// smaller id. They let ack-independent readers (the Slack notifier, which
	// never marks rows read on delivery) walk an unread backlog larger than one
	// page. Zero values disable the cursor.
	CreatedBefore time.Time
	BeforeID      string
}
