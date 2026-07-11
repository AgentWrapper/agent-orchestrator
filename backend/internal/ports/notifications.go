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

	// Enrichment hints. These avoid storage reads on the hot path.
	SessionDisplayName string
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
	// Worker retry enrichment.
	RetryCount int
	RetryLimit int
	// RespawnSuppressed means a worker death notification is informational only;
	// intake deliberately will not start a replacement for this issue.
	RespawnSuppressed bool

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
