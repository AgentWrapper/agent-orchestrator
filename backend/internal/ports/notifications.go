package ports

import (
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// NotificationIntent is the lifecycle-to-notification-producer contract. It is
// not an HTTP DTO; lifecycle fills it from facts it already has after the
// underlying session/PR state write succeeds.
type NotificationIntent struct {
	Type      domain.NotificationType
	SessionID domain.SessionID
	ProjectID domain.ProjectID
	IssueID   domain.IssueID
	PRURL     string
	CreatedAt time.Time

	// Subject identifies the durable entity this notification is about. When
	// unset, notify enriches it from the legacy session/pr fields for backwards
	// compatibility with older producers.
	SubjectKind domain.NotificationSubjectKind
	SubjectID   string

	// Enrichment hints. These avoid storage reads on the hot path.
	SessionDisplayName string
	SessionKind        domain.SessionKind
	PRNumber           int
	PRTitle            string
	PRSourceBranch     string
	PRTargetBranch     string
	Provider           string
	Repo               string
	Sensitive          bool
	ChangedPaths       []string
	// HeadSHA is the PR head commit the notification was derived from. It is
	// part of the operator-visible signature (a new push is a real state
	// change) and is surfaced to downstream consumers such as the Slack
	// notifier so they can dedupe on it too.
	HeadSHA string
	// TerminalFailureReason is the dead session's recorded terminal failure
	// provenance (worker_died_unfinished only): where the worker died, so the
	// operator can diagnose before explicitly restarting the issue.
	TerminalFailureReason string
	// RecoveryIncidentID / RecoveryAttempt / RecoveryRung identify the durable
	// recovery loop backing a worker_died_unfinished escalation.
	RecoveryIncidentID string
	RecoveryAttempt    int
	RecoveryRung       domain.RecoveryRung

	// Duplicate-PR enrichment (domain.NotificationDuplicatePR only). IssueRef is
	// the tracker reference both PRs claim (e.g. "owner/repo#169"); PRURL is the
	// newer/duplicate PR and DuplicateOfPRURL is the pre-existing open PR.
	IssueRef         string
	DuplicateOfPRURL string

	// Model health enrichment.
	ModelHarness domain.AgentHarness
	Model        string
	ModelScope   string
	Reason       string
}
