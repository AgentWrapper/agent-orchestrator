package contract

import "time"

// PRFacts is the normalized pull-request input to shared status derivation.
type PRFacts struct {
	URL            string       `json:"url"`
	Number         int          `json:"number,omitempty"`
	Draft          bool         `json:"draft,omitempty"`
	Merged         bool         `json:"merged,omitempty"`
	Closed         bool         `json:"closed,omitempty"`
	CI             CIState      `json:"ci,omitempty"`
	Review         ReviewState  `json:"review,omitempty"`
	Mergeability   Mergeability `json:"mergeability,omitempty"`
	ReviewComments bool         `json:"reviewComments,omitempty"`
	SourceBranch   string       `json:"sourceBranch,omitempty"`
	TargetBranch   string       `json:"targetBranch,omitempty"`
	UpdatedAt      time.Time    `json:"updatedAt,omitempty"`
}

// CIState is the aggregate CI status of a PR.
type CIState string

const (
	// CIUnknown means CI state has not been observed.
	CIUnknown CIState = "unknown"
	// CIPending means at least one required check is still running.
	CIPending CIState = "pending"
	// CIPassing means observed required checks are passing.
	CIPassing CIState = "passing"
	// CIFailing means at least one required check failed.
	CIFailing CIState = "failing"
)

// ReviewState is the aggregate human-review verdict on a PR.
type ReviewState string

const (
	// ReviewNone means no meaningful review verdict has been observed.
	ReviewNone ReviewState = "none"
	// ReviewApproved means the PR has an approving review.
	ReviewApproved ReviewState = "approved"
	// ReviewChangesRequested means a reviewer requested changes.
	ReviewChangesRequested ReviewState = "changes_requested"
	// ReviewRequired means a required review is still missing.
	ReviewRequired ReviewState = "review_required"
)

// Mergeability is whether a PR can currently be merged.
type Mergeability string

const (
	// MergeUnknown means mergeability has not been observed.
	MergeUnknown Mergeability = "unknown"
	// MergeMergeable means the PR can currently be merged.
	MergeMergeable Mergeability = "mergeable"
	// MergeConflicting means the PR has merge conflicts.
	MergeConflicting Mergeability = "conflicting"
	// MergeBlocked means repository rules currently block merging.
	MergeBlocked Mergeability = "blocked"
	// MergeUnstable means mergeability is transient or pending recomputation.
	MergeUnstable Mergeability = "unstable"
)

type stackInfo struct {
	Blocked       bool
	BottomOfStack bool
}

func buildStacks(prs []PRFacts) map[string]stackInfo {
	openSources := make(map[string]bool, len(prs))
	for _, pr := range prs {
		if !pr.Merged && !pr.Closed && pr.SourceBranch != "" {
			openSources[pr.SourceBranch] = true
		}
	}
	out := make(map[string]stackInfo, len(prs))
	for _, pr := range prs {
		blocked := pr.TargetBranch != "" && openSources[pr.TargetBranch]
		out[pr.URL] = stackInfo{Blocked: blocked, BottomOfStack: !blocked}
	}
	return out
}
