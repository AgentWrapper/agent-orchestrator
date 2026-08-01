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
	CIUnknown CIState = "unknown"
	CIPending CIState = "pending"
	CIPassing CIState = "passing"
	CIFailing CIState = "failing"
)

// ReviewState is the aggregate human-review verdict on a PR.
type ReviewState string

const (
	ReviewNone             ReviewState = "none"
	ReviewApproved         ReviewState = "approved"
	ReviewChangesRequested ReviewState = "changes_requested"
	ReviewRequired         ReviewState = "review_required"
)

// Mergeability is whether a PR can currently be merged.
type Mergeability string

const (
	MergeUnknown     Mergeability = "unknown"
	MergeMergeable   Mergeability = "mergeable"
	MergeConflicting Mergeability = "conflicting"
	MergeBlocked     Mergeability = "blocked"
	MergeUnstable    Mergeability = "unstable"
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
