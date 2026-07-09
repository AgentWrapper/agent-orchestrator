package domain

import (
	"fmt"
	"strings"
)

// TrackerProvider identifies an issue-tracker provider implementation.
type TrackerProvider string

// TrackerProviderGitHub is the only supported issue-tracker provider.
const TrackerProviderGitHub TrackerProvider = "github"

// IssueLabelKind groups the issue labels ao treats as load-bearing workflow
// metadata.
type IssueLabelKind string

const (
	// IssueLabelKindType identifies issue type labels such as bug, feature, and task.
	IssueLabelKindType IssueLabelKind = "type"
	// IssueLabelKindOptOut identifies labels that exclude issues from automated intake.
	IssueLabelKindOptOut IssueLabelKind = "opt-out"
	// IssueLabelKindRouting identifies labels that pin a ticket to a specific agent harness.
	IssueLabelKindRouting IssueLabelKind = "routing"
	// IssueLabelKindPoolEscape identifies labels that bypass the normal worker pool cap.
	IssueLabelKindPoolEscape IssueLabelKind = "pool-escape"
)

// IssueLabelSpec is the canonical metadata for one GitHub label ao expects on
// ao-native repos.
type IssueLabelSpec struct {
	Name        string         `json:"name"`
	Kind        IssueLabelKind `json:"kind"`
	Color       string         `json:"color"`
	Description string         `json:"description"`
}

var standardIssueLabels = []IssueLabelSpec{
	{Name: "bug", Kind: IssueLabelKindType, Color: "d73a4a", Description: "Something isn't working"},
	{Name: "feature", Kind: IssueLabelKindType, Color: "a2eeef", Description: "New capability"},
	{Name: "task", Kind: IssueLabelKindType, Color: "0e8a16", Description: "Non-feature work item"},
	{Name: "no-ao", Kind: IssueLabelKindOptOut, Color: "000000", Description: "Opt OUT of ao auto-pickup entirely — ao never works this"},
	{Name: "deferred", Kind: IssueLabelKindOptOut, Color: "cfd3d7", Description: "Opt-out: parked for future; not for auto-pickup now"},
	{Name: "charter", Kind: IssueLabelKindOptOut, Color: "c2e0c6", Description: "Opt-out: charter-managed work, handled outside auto-pickup"},
	{Name: "charter-audit", Kind: IssueLabelKindOptOut, Color: "c2e0c6", Description: "Opt-out: charter audit work, handled outside auto-pickup"},
	{Name: "human-review", Kind: IssueLabelKindOptOut, Color: "b60205", Description: "Opt-out: parked for human review; not for auto-pickup"},
	{Name: "agent:codex", Kind: IssueLabelKindRouting, Color: "1d76db", Description: "Route this ticket to codex (gpt-5.5-codex), within pool cap"},
	{Name: "agent:fugu", Kind: IssueLabelKindRouting, Color: "5319e7", Description: "Route this ticket to codex-fugu (fugu-ultra), within pool cap"},
	{Name: "agent:claude", Kind: IssueLabelKindRouting, Color: "d4a017", Description: "Route this ticket to claude-code (opus), within pool cap"},
	{Name: "nopool", Kind: IssueLabelKindPoolEscape, Color: "e11d21", Description: "Launch outside the pool/cap limits"},
}

// StandardIssueLabels returns the canonical label set ao-native repos should
// carry. Callers receive a copy so the package-level taxonomy cannot be mutated.
func StandardIssueLabels() []IssueLabelSpec {
	return append([]IssueLabelSpec(nil), standardIssueLabels...)
}

func standardIssueLabelNames(kind IssueLabelKind) []string {
	var out []string
	for _, label := range standardIssueLabels {
		if label.Kind == kind {
			out = append(out, label.Name)
		}
	}
	return out
}

// DefaultOptOutLabels is the opt-out taxonomy every ao-native repo carries by
// default (issue #80): intake works every open issue EXCEPT those bearing one of
// these labels. It is materialized into TrackerIntakeConfig.ExcludeLabels by
// WithDefaults when intake is enabled and the project left ExcludeLabels unset.
//
// "charter" is a scoped-label prefix: the intake filter treats it as excluding
// both the bare "charter" label and the whole "charter:*" family (e.g.
// charter:C03), so charter sub-labels never need enumerating. "charter-audit"
// is a distinct label (hyphen, not a "charter:" scope) and is listed on its own.
var DefaultOptOutLabels = standardIssueLabelNames(IssueLabelKindOptOut)

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

// TrackerRepo identifies a repository for cross-issue queries like Tracker.List.
// Native is the provider's canonical owner/project form, e.g. "owner/repo" for
// GitHub.
type TrackerRepo struct {
	Provider TrackerProvider `json:"provider"`
	Native   string          `json:"native"`
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
// Limit is an optional total-result cap. Adapters choose their own provider
// page size.
type ListFilter struct {
	State    ListStateFilter `json:"state,omitempty"`
	Labels   []string        `json:"labels,omitempty"`
	Assignee string          `json:"assignee,omitempty"`
	Limit    int             `json:"limit,omitempty"`
}

// TrackerIntakeConfig controls issue-driven worker spawning for a project.
// Intake is opt-out-by-default (issue #80): once enabled it works every open
// issue that carries none of the ExcludeLabels (which default to
// DefaultOptOutLabels). An assignee is an optional additional narrowing filter,
// not a requirement; the MaxConcurrent cap plus the opt-out labels are what keep
// enabling intake from draining an entire backlog.
type TrackerIntakeConfig struct {
	Enabled bool `json:"enabled,omitempty"`
	// Provider defaults to github when Enabled is true.
	Provider TrackerProvider `json:"provider,omitempty" enum:"github"`
	// Repo is the GitHub-native repository key ("owner/repo"). When empty, the
	// intake loop derives it from the project's repo origin URL. GitHub only.
	Repo string `json:"repo,omitempty"`
	// Assignee narrows eligible issues to one assignee. Provider-specific values
	// such as "*" are passed through unchanged.
	Assignee string `json:"assignee,omitempty"`
	// Labels, when non-empty, narrows eligible issues to those carrying at least
	// one of the listed labels (case-insensitive). An empty list imposes no
	// label requirement. Applied client-side alongside the assignee rule.
	Labels []string `json:"labels,omitempty"`
	// ExcludeLabels rejects any issue carrying at least one of the listed labels
	// (case-insensitive), even if it satisfies the assignee and Labels rules.
	// Each entry matches a label exactly OR as a scoped-label prefix ("charter"
	// excludes "charter:C03"; see observer.go). Exclusion wins over inclusion.
	//
	// This is the opt-out work gate (issue #80). A nil slice (never set) is
	// materialized to the DefaultOptOutLabels taxonomy by WithDefaults; a
	// non-nil slice — including an explicit empty one, in memory — is honored
	// verbatim. (omitempty is retained so the OpenAPI request field stays
	// optional; JSON persistence therefore collapses an empty slice back to the
	// defaults, i.e. clearing the list restores the default opt-out protection.)
	ExcludeLabels []string `json:"excludeLabels,omitempty"`
	// MaxConcurrent caps fresh worker spawn admission against the number of live
	// worker sessions for this project. Zero means no cap. When at the cap the
	// intake loop defers remaining eligible issues to a later tick (they are
	// never permanently dropped), and manual spawn requests are rejected before
	// durable spawn state is created. Lifecycle restore/re-adoption paths do not
	// terminate saved work to enforce this admission cap retroactively.
	MaxConcurrent int `json:"maxConcurrent,omitempty"`
}

// WithDefaults fills the provider and the opt-out taxonomy only when intake is
// enabled. Disabled intake leaves the zero value untouched so empty project
// configs still store as NULL. An unset ExcludeLabels (nil) is materialized to
// DefaultOptOutLabels — opt-out-by-default; a non-nil slice (including an
// explicit empty one) is honored verbatim.
func (c TrackerIntakeConfig) WithDefaults() TrackerIntakeConfig {
	if c.Enabled && c.Provider == "" {
		c.Provider = TrackerProviderGitHub
	}
	if c.Enabled && c.ExcludeLabels == nil {
		c.ExcludeLabels = append([]string(nil), DefaultOptOutLabels...)
	}
	return c
}

// Validate rejects accidental broad intake and unknown providers.
func (c TrackerIntakeConfig) Validate() error {
	if !c.Enabled {
		return nil
	}
	c = c.WithDefaults()
	if c.Enabled && c.Provider != TrackerProviderGitHub {
		return fmt.Errorf("trackerIntake.provider: unsupported provider %q", c.Provider)
	}
	if err := validateNoWhitespaceField("trackerIntake.repo", c.Repo); err != nil {
		return err
	}
	if err := validateNoWhitespaceField("trackerIntake.assignee", c.Assignee); err != nil {
		return err
	}
	// Issue #80: intake is opt-out-by-default, so an assignee is no longer
	// required to enable it — the work gate is the opt-out labels (materialized
	// by WithDefaults) plus the MaxConcurrent cap, which together replace the
	// backlog-drain protection the assignee requirement used to provide. Assignee
	// remains an optional additional narrowing filter when set.
	for i, label := range c.Labels {
		if err := validateNoWhitespaceField(fmt.Sprintf("trackerIntake.labels[%d]", i), label); err != nil {
			return err
		}
		if strings.TrimSpace(label) == "" {
			return fmt.Errorf("trackerIntake.labels[%d]: must not be empty", i)
		}
	}
	for i, label := range c.ExcludeLabels {
		if err := validateNoWhitespaceField(fmt.Sprintf("trackerIntake.excludeLabels[%d]", i), label); err != nil {
			return err
		}
		if strings.TrimSpace(label) == "" {
			return fmt.Errorf("trackerIntake.excludeLabels[%d]: must not be empty", i)
		}
	}
	if c.MaxConcurrent < 0 {
		return fmt.Errorf("trackerIntake.maxConcurrent: must not be negative")
	}
	return nil
}
