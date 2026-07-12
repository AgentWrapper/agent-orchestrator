package domain

import (
	"errors"
	"time"
)

// NotificationType identifies a user-facing notification kind persisted for the dashboard.
type NotificationType string

const (
	// NotificationNeedsInput means an agent session is waiting for user input.
	NotificationNeedsInput NotificationType = "needs_input"
	// NotificationReadyToMerge means a PR has no known merge blockers.
	NotificationReadyToMerge NotificationType = "ready_to_merge"
	// NotificationPRMerged means a tracked PR was merged.
	NotificationPRMerged NotificationType = "pr_merged"
	// NotificationPRClosedUnmerged means a tracked PR closed without merging.
	NotificationPRClosedUnmerged NotificationType = "pr_closed_unmerged"
	// NotificationOrchestratorReplaced means AO replaced an unresponsive project orchestrator.
	NotificationOrchestratorReplaced NotificationType = "orchestrator_replaced"
	// NotificationOrchestratorReplacementCapped means AO stopped replacing an unhealthy orchestrator after hitting its replacement limit.
	NotificationOrchestratorReplacementCapped NotificationType = "orchestrator_replacement_capped"
	// NotificationDuplicatePR means a second open PR was observed for a tracker
	// issue that already has a different open PR. It is a loud, operator-facing
	// alert: the fleet opened a duplicate and one of the PRs should be closed or
	// adopted. See issue #181.
	NotificationDuplicatePR NotificationType = "duplicate_pr"
	// NotificationWorkerDiedUnfinished means a worker session terminated while
	// its assigned issue still needs work.
	NotificationWorkerDiedUnfinished NotificationType = "worker_died_unfinished"
	// NotificationWorkerRetryExhausted means tracker intake reached the clean
	// respawn retry cap for an unfinished issue.
	NotificationWorkerRetryExhausted NotificationType = "worker_retry_exhausted"
	// NotificationModelUnreachable means a configured model pin was rejected by
	// its provider/account during scheduled revalidation.
	NotificationModelUnreachable NotificationType = "model_unreachable"
	// NotificationModelRecovered means a previously unreachable model pin probed
	// successfully again.
	NotificationModelRecovered NotificationType = "model_recovered"
	// NotificationMainCIRed means the repository default branch CI is failing.
	NotificationMainCIRed NotificationType = "main_ci_red"
)

// Valid reports whether t is one of the v1 notification kinds.
func (t NotificationType) Valid() bool {
	switch t {
	case NotificationNeedsInput, NotificationReadyToMerge, NotificationPRMerged, NotificationPRClosedUnmerged, NotificationOrchestratorReplaced, NotificationOrchestratorReplacementCapped, NotificationDuplicatePR, NotificationWorkerDiedUnfinished, NotificationWorkerRetryExhausted, NotificationModelUnreachable, NotificationModelRecovered, NotificationMainCIRed:
		return true
	default:
		return false
	}
}

// OperatorAttentionNotificationTypes returns durable notification types whose
// unread rows represent an operator-actionable condition. Session-derived
// attention, such as needs_input and ready_to_merge, is intentionally not
// included here because service/attention derives it from live session/PR state.
func OperatorAttentionNotificationTypes() []NotificationType {
	return []NotificationType{
		NotificationWorkerRetryExhausted,
		NotificationMainCIRed,
		NotificationDuplicatePR,
		NotificationOrchestratorReplacementCapped,
	}
}

// NotificationStatus is the read state for a stored notification.
type NotificationStatus string

const (
	// NotificationUnread marks a notification that has not been acknowledged.
	NotificationUnread NotificationStatus = "unread"
	// NotificationRead marks a notification that has been acknowledged.
	NotificationRead NotificationStatus = "read"
)

// Valid reports whether s is a supported notification read state.
func (s NotificationStatus) Valid() bool {
	switch s {
	case NotificationUnread, NotificationRead:
		return true
	default:
		return false
	}
}

// NotificationRecord is the durable notification persistence shape.
type NotificationRecord struct {
	ID           string
	SessionID    SessionID
	ProjectID    ProjectID
	PRURL        string
	Type         NotificationType
	Title        string
	Body         string
	Sensitive    bool
	ChangedPaths []string
	HeadSHA      string
	Status       NotificationStatus
	CreatedAt    time.Time
}

var (
	// ErrInvalidNotificationType reports an unknown notification type.
	ErrInvalidNotificationType = errors.New("invalid notification type")
	// ErrInvalidNotificationStatus reports an unknown notification status.
	ErrInvalidNotificationStatus = errors.New("invalid notification status")
	// ErrInvalidNotificationRecord reports a missing required notification field.
	ErrInvalidNotificationRecord = errors.New("invalid notification record")
)

// Validate checks the required fields and enum values for a stored notification.
func (r NotificationRecord) Validate() error {
	if r.SessionID == "" || r.ProjectID == "" || r.Title == "" || r.CreatedAt.IsZero() {
		return ErrInvalidNotificationRecord
	}
	if !r.Type.Valid() {
		return ErrInvalidNotificationType
	}
	if !r.Status.Valid() {
		return ErrInvalidNotificationStatus
	}
	return nil
}
