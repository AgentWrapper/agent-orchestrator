package domain

import (
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/contract"
)

// ---- PR read model ----

// PRFacts is the per-session PR snapshot the status derivation reads from the
// pr table.
type PRFacts struct {
	URL            string
	Number         int
	Draft          bool
	Merged         bool
	Closed         bool
	CI             CIState
	Review         ReviewDecision
	Mergeability   Mergeability
	ReviewComments bool // has unresolved review comments (any author) to address
	SourceBranch   string
	TargetBranch   string
	UpdatedAt      time.Time
}

// PullRequest is the app-level representation of one tracked pull request as
// persisted by the PR store. It is intentionally separate from the sqlc
// generated sqlite row type so storage details do not leak outside sqlite.
type PullRequest struct {
	URL          string
	SessionID    SessionID
	Number       int
	Draft        bool
	Merged       bool
	Closed       bool
	CI           CIState
	Review       ReviewDecision
	Mergeability Mergeability
	UpdatedAt    time.Time
	// StateChangedAt is when the current normalized PR lifecycle state became
	// active. It is seeded from provider timestamps and updated when AO observes
	// a draft/open/merged/closed transition.
	StateChangedAt time.Time

	Provider string
	Host     string
	Repo     string

	SourceBranch   string
	TargetBranch   string
	HeadSHA        string
	Title          string
	Additions      int
	Deletions      int
	ChangedFiles   int
	Author         string
	BaseSHA        string
	MergeCommitSHA string

	ProviderState            string
	ProviderMergeable        string
	ProviderMergeStateStatus string
	HTMLURL                  string

	CreatedAtProvider time.Time
	UpdatedAtProvider time.Time
	MergedAtProvider  time.Time
	ClosedAtProvider  time.Time

	MetadataHash string
	CIHash       string
	ReviewHash   string

	ObservedAt       time.Time
	CIObservedAt     time.Time
	ReviewObservedAt time.Time
}

// PullRequestCheck is one normalized CI check run for a pull request.
type PullRequestCheck struct {
	Name       string
	CommitHash string
	Status     PRCheckStatus
	Conclusion string
	URL        string
	Details    string
	LogTail    string
	CreatedAt  time.Time
}

// PullRequestComment is one normalized review comment for a pull request.
type PullRequestComment struct {
	ThreadID  string
	ID        string
	Author    string
	File      string
	Line      int
	Body      string
	URL       string
	Resolved  bool
	IsBot     bool
	CreatedAt time.Time
}

// PullRequestReviewThread is one normalized review thread for a pull request.
type PullRequestReviewThread struct {
	ThreadID     string
	Path         string
	Line         int
	Resolved     bool
	IsBot        bool
	SemanticHash string
	UpdatedAt    time.Time
}

// PullRequestReview is one submitted provider review for a pull request.
type PullRequestReview struct {
	ID          string
	Author      string
	State       ReviewDecision
	URL         string
	Body        string
	IsBot       bool
	SubmittedAt time.Time
}

// CIState is the aggregate CI status of a PR.
type CIState string

// CI states.
const (
	CIUnknown CIState = CIState(contract.CIUnknown)
	CIPending CIState = CIState(contract.CIPending)
	CIPassing CIState = CIState(contract.CIPassing)
	CIFailing CIState = CIState(contract.CIFailing)
)

// ReviewDecision is the aggregate human-review verdict on a PR.
type ReviewDecision string

// Review decisions.
const (
	ReviewNone           ReviewDecision = ReviewDecision(contract.ReviewNone)
	ReviewApproved       ReviewDecision = ReviewDecision(contract.ReviewApproved)
	ReviewChangesRequest ReviewDecision = ReviewDecision(contract.ReviewChangesRequested)
	ReviewRequired       ReviewDecision = ReviewDecision(contract.ReviewRequired)
)

// Mergeability is whether a PR can currently be merged.
type Mergeability string

// Mergeability states.
const (
	MergeUnknown     Mergeability = Mergeability(contract.MergeUnknown)
	MergeMergeable   Mergeability = Mergeability(contract.MergeMergeable)
	MergeConflicting Mergeability = Mergeability(contract.MergeConflicting)
	MergeBlocked     Mergeability = Mergeability(contract.MergeBlocked)
	MergeUnstable    Mergeability = Mergeability(contract.MergeUnstable)
)

// PRState is the normalized lifecycle of one tracked pull request as stored in
// the pr table.
type PRState string

// PR states.
const (
	PRStateDraft  PRState = "draft"
	PRStateOpen   PRState = "open"
	PRStateMerged PRState = "merged"
	PRStateClosed PRState = "closed"
)

// PRCheckStatus is one CI check run's normalized status.
type PRCheckStatus string

// PR check statuses.
const (
	PRCheckUnknown    PRCheckStatus = "unknown"
	PRCheckQueued     PRCheckStatus = "queued"
	PRCheckInProgress PRCheckStatus = "in_progress"
	PRCheckPassed     PRCheckStatus = "passed"
	PRCheckFailed     PRCheckStatus = "failed"
	PRCheckSkipped    PRCheckStatus = "skipped"
	PRCheckCancelled  PRCheckStatus = "cancelled"
)
