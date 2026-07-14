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
	// NotificationOrchestratorReplacementCapped means AO backed off replacement after an unhealthy supervised role exhausted its fast replacement window.
	NotificationOrchestratorReplacementCapped NotificationType = "orchestrator_replacement_capped"
	// NotificationDuplicatePR means a second open PR was observed for a tracker
	// issue that already has a different open PR. It is a loud, operator-facing
	// alert: the fleet opened a duplicate and one of the PRs should be closed or
	// adopted. See issue #181.
	NotificationDuplicatePR NotificationType = "duplicate_pr"
	// NotificationWorkerDiedUnfinished means a worker session terminated while
	// its assigned issue still needs work. Automatic respawn was removed (#313):
	// this is a terminal escalation that requires an explicit operator restart.
	NotificationWorkerDiedUnfinished NotificationType = "worker_died_unfinished"
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
	case NotificationNeedsInput, NotificationReadyToMerge, NotificationPRMerged, NotificationPRClosedUnmerged, NotificationOrchestratorReplaced, NotificationOrchestratorReplacementCapped, NotificationDuplicatePR, NotificationWorkerDiedUnfinished, NotificationModelUnreachable, NotificationModelRecovered, NotificationMainCIRed:
		return true
	default:
		return false
	}
}

// OperatorAttentionNotificationTypes returns durable notification types whose
// unread rows represent an operator-actionable condition regardless of row
// content. It doubles as the type-level mark-all-read exclusion set: read-all
// must not clear a fleet-health escalation the operator has not resolved.
// Session-derived attention, such as needs_input, is intentionally not included
// because service/attention derives it from live session state. ready_to_merge
// is also not here — only its SENSITIVE rows are operator attention (the
// parked_sensitive_merge item), which the projection queries with a
// sensitive-only filter and the mark-all-read SQL preserves via a matching
// row-level carve-out (see the sqlite notification store).
func OperatorAttentionNotificationTypes() []NotificationType {
	return []NotificationType{
		NotificationWorkerDiedUnfinished,
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

// NotificationSubjectKind identifies the durable entity a notification is about.
type NotificationSubjectKind string

const (
	// NotificationSubjectSession means the notification belongs to an AO session.
	NotificationSubjectSession NotificationSubjectKind = "session"
	// NotificationSubjectProject means the notification belongs to a project-level condition.
	NotificationSubjectProject NotificationSubjectKind = "project"
	// NotificationSubjectPR means the notification belongs to a pull request.
	NotificationSubjectPR NotificationSubjectKind = "pr"
	// NotificationSubjectModel means the notification belongs to a configured model pin.
	NotificationSubjectModel NotificationSubjectKind = "model"
)

// Valid reports whether k is a supported notification subject kind.
func (k NotificationSubjectKind) Valid() bool {
	switch k {
	case NotificationSubjectSession, NotificationSubjectProject, NotificationSubjectPR, NotificationSubjectModel:
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
	SubjectKind  NotificationSubjectKind
	SubjectID    string
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

// WithInferredSubject fills the typed subject from legacy session/pr fields when
// a caller has not set it yet. It also clears the legacy session id for durable
// project/model rows so new rows do not depend on synthetic session ids.
func (r NotificationRecord) WithInferredSubject() NotificationRecord {
	if r.SubjectKind == "" {
		switch {
		case r.Type == NotificationWorkerDiedUnfinished:
			r.SubjectKind = NotificationSubjectSession
			r.SubjectID = string(r.SessionID)
		case r.Type == NotificationModelUnreachable || r.Type == NotificationModelRecovered:
			r.SubjectKind = NotificationSubjectModel
		case r.Type == NotificationMainCIRed:
			r.SubjectKind = NotificationSubjectProject
			r.SubjectID = string(r.ProjectID)
		case r.PRURL != "":
			r.SubjectKind = NotificationSubjectPR
			r.SubjectID = r.PRURL
		default:
			r.SubjectKind = NotificationSubjectSession
			r.SubjectID = string(r.SessionID)
		}
	}
	if r.SubjectID == "" {
		switch r.SubjectKind {
		case NotificationSubjectSession:
			r.SubjectID = string(r.SessionID)
		case NotificationSubjectProject:
			r.SubjectID = string(r.ProjectID)
		case NotificationSubjectPR:
			r.SubjectID = r.PRURL
		case NotificationSubjectModel:
			r.SubjectID = string(r.ProjectID)
		}
	}
	if r.SubjectKind == NotificationSubjectProject || r.SubjectKind == NotificationSubjectModel {
		r.SessionID = ""
	}
	return r
}

// Validate checks the required fields and enum values for a stored notification.
func (r NotificationRecord) Validate() error {
	if r.ProjectID == "" || r.Title == "" || r.CreatedAt.IsZero() || r.SubjectID == "" {
		return ErrInvalidNotificationRecord
	}
	if !r.SubjectKind.Valid() {
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
