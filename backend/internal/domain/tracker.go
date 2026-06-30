package domain

// TrackerProvider identifies an issue-tracker provider implementation.
type TrackerProvider string

// Supported issue-tracker providers. Each value maps 1:1 to a backend adapter
// under backend/internal/adapters/tracker/<provider>.
const (
	TrackerProviderGitHub TrackerProvider = "github"
	TrackerProviderLinear TrackerProvider = "linear"
	TrackerProviderJira   TrackerProvider = "jira"
)

// TrackerID identifies one issue. Native is the provider's own canonical form
// ("owner/repo#123" for GitHub) and is parsed by the adapter.
type TrackerID struct {
	Provider TrackerProvider `json:"provider"`
	Native   string          `json:"native"`
}

// NormalizedIssueState is the cross-provider issue-state vocabulary every
// adapter must implement. The closed list is intentional — adding a value
// here is a port-level decision because every adapter must map it.
type NormalizedIssueState string

// The normalized cross-provider issue states.
const (
	IssueOpen       NormalizedIssueState = "open"
	IssueInProgress NormalizedIssueState = "in_progress"
	IssueInReview   NormalizedIssueState = "review"
	IssueDone       NormalizedIssueState = "done"
	IssueCancelled  NormalizedIssueState = "cancelled"
)

// Issue is the minimum projection every tracker can produce. Provider-specific
// metadata stays inside provider-specific code paths.
type Issue struct {
	ID        TrackerID            `json:"id"`
	Title     string               `json:"title"`
	Body      string               `json:"body"`
	State     NormalizedIssueState `json:"state"`
	URL       string               `json:"url"`
	Labels    []string             `json:"labels,omitempty"`
	Assignees []string             `json:"assignees,omitempty"`
}

// TrackerRepo identifies a repository (or its provider analogue) for
// cross-issue queries like Tracker.List. Native is the provider's canonical
// scope key:
//   - GitHub: "owner/repo"
//   - Linear: team key, e.g. "ENG"
//   - Jira: project key, e.g. "ENG"
//
// BaseURL is provider-specific metadata. Only Jira uses it (the Cloud site URL,
// e.g. "https://acme.atlassian.net") because Jira issues are addressed against
// a tenant's own site rather than a global API host. GitHub and Linear leave it
// empty.
type TrackerRepo struct {
	Provider TrackerProvider `json:"provider"`
	Native   string          `json:"native"`
	BaseURL  string          `json:"baseURL,omitempty"`
}

// ListStateFilter narrows Tracker.List results by the provider's coarse
// state (open vs closed). It is intentionally NOT the 5-value normalized
// enum — finer filtering (e.g. "only in-review issues") goes through the
// Labels field of ListFilter.
type ListStateFilter string

// Coarse list-state filters for Tracker.List.
const (
	// ListAll is the zero value and returns issues in any state.
	ListAll    ListStateFilter = ""
	ListOpen   ListStateFilter = "open"
	ListClosed ListStateFilter = "closed"
)

// ListFilter is the query the Session Manager passes to Tracker.List.
// Empty / zero values mean "no filter on this dimension".
//
// Limit is the requested page size. The adapter applies its own default when
// zero and caps at the provider's per-page maximum.
type ListFilter struct {
	State    ListStateFilter `json:"state,omitempty"`
	Labels   []string        `json:"labels,omitempty"`
	Assignee string          `json:"assignee,omitempty"`
	Limit    int             `json:"limit,omitempty"`
}
