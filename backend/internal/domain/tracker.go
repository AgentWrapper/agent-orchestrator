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
	// IssueLabelKindStatus identifies informational workflow-state labels.
	IssueLabelKindStatus IssueLabelKind = "status"
	// IssueLabelKindRouting identifies labels that pin a ticket to a specific agent harness.
	IssueLabelKindRouting IssueLabelKind = "routing"
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
	{Name: "deferred", Kind: IssueLabelKindStatus, Color: "cfd3d7", Description: "Informational status: deferred for future consideration"},
	{Name: "charter", Kind: IssueLabelKindStatus, Color: "c2e0c6", Description: "Informational status: charter-managed work"},
	{Name: "charter-audit", Kind: IssueLabelKindStatus, Color: "c2e0c6", Description: "Informational status: charter audit work"},
	{Name: "human-review", Kind: IssueLabelKindStatus, Color: "b60205", Description: "Informational status: human review requested"},
	{Name: "agent:codex", Kind: IssueLabelKindRouting, Color: "1d76db", Description: "Route this ticket to codex (gpt-5.5-codex), within pool cap"},
	{Name: "agent:fugu", Kind: IssueLabelKindRouting, Color: "5319e7", Description: "Route this ticket to codex-fugu (fugu-ultra), within pool cap"},
	{Name: "agent:claude", Kind: IssueLabelKindRouting, Color: "d4a017", Description: "Route this ticket to claude-code (opus), within pool cap"},
}

// StandardIssueLabels returns the canonical label set ao-native repos should
// carry. Callers receive a copy so the package-level taxonomy cannot be mutated.
func StandardIssueLabels() []IssueLabelSpec {
	return append([]IssueLabelSpec(nil), standardIssueLabels...)
}

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

// DefaultWorkerRespawnMaxRetries keeps automatic replacement disabled unless an
// operator explicitly configures a positive bounded retry count.
const DefaultWorkerRespawnMaxRetries = 0

// TrackerRespawnPolicy controls clean worker retry behavior for tracker intake.
// MaxRetries is a pointer so an explicit JSON zero can mean "notify but do not
// respawn" instead of being confused with "unset". The unset default is zero.
type TrackerRespawnPolicy struct {
	Disabled   bool `json:"disabled,omitempty"`
	MaxRetries *int `json:"maxRetries,omitempty"`
}

// WithDefaults materializes the default retry cap.
func (p TrackerRespawnPolicy) WithDefaults() TrackerRespawnPolicy {
	if p.MaxRetries == nil {
		defaultMaxRetries := DefaultWorkerRespawnMaxRetries
		p.MaxRetries = &defaultMaxRetries
	}
	return p
}

// IsEnabled reports whether tracker intake should launch clean replacement
// workers after an unfinished worker dies.
func (p TrackerRespawnPolicy) IsEnabled() bool {
	return !p.Disabled
}

// EffectiveMaxRetries returns the materialized retry cap.
func (p TrackerRespawnPolicy) EffectiveMaxRetries() int {
	p = p.WithDefaults()
	if p.MaxRetries == nil {
		return DefaultWorkerRespawnMaxRetries
	}
	return *p.MaxRetries
}

// TrackerIntakeConfig controls issue-driven worker spawning for a project.
// Assignment is the sole admission signal: enabled intake requires an assignee
// selector and a finite positive concurrency cap.
type TrackerIntakeConfig struct {
	Enabled bool `json:"enabled,omitempty"`
	// Provider defaults to github when Enabled is true.
	Provider TrackerProvider `json:"provider,omitempty" enum:"github"`
	// Repo is the GitHub-native repository key ("owner/repo"). When empty, the
	// intake loop derives it from the project's repo origin URL. GitHub only.
	Repo string `json:"repo,omitempty"`
	// Assignee authorizes eligible issues. "*" means any assigned issue. Empty
	// and "none" are invalid when intake is enabled.
	Assignee string `json:"assignee,omitempty"`
	// Labels is retained only for persisted-config compatibility. Intake ignores
	// it; labels never grant or veto admission.
	Labels []string `json:"labels,omitempty" deprecated:"true" description:"Ignored compatibility field; assignment is the sole admission signal. Park work by unassigning it."`
	// ExcludeLabels is retained only for persisted-config compatibility. Intake
	// ignores it; park work by unassigning it.
	ExcludeLabels []string `json:"excludeLabels,omitempty" deprecated:"true" description:"Ignored compatibility field; assignment is the sole admission signal. Park work by unassigning it."`
	// MaxConcurrent caps fresh worker spawn admission against the number of live
	// worker sessions for this project. Enabled intake requires a positive cap.
	// When at the cap the
	// intake loop defers remaining eligible issues to a later tick (they are
	// never permanently dropped), and manual spawn requests are rejected before
	// durable spawn state is created. Lifecycle restore/re-adoption paths do not
	// terminate saved work to enforce this admission cap retroactively.
	MaxConcurrent int `json:"maxConcurrent,omitempty"`
	// Respawn controls clean replacement workers for unfinished issues whose
	// previous worker sessions terminated. Defaults to zero retries.
	Respawn *TrackerRespawnPolicy `json:"respawn,omitempty"`
}

// EffectiveRespawnPolicy returns the configured respawn policy with defaults
// applied without mutating the persisted config shape.
func (c TrackerIntakeConfig) EffectiveRespawnPolicy() TrackerRespawnPolicy {
	if c.Respawn == nil {
		return (TrackerRespawnPolicy{}).WithDefaults()
	}
	return c.Respawn.WithDefaults()
}

// WithDefaults fills the provider only when intake is enabled. Disabled intake
// leaves the zero value untouched so empty project configs still store as NULL.
func (c TrackerIntakeConfig) WithDefaults() TrackerIntakeConfig {
	if c.Enabled && c.Provider == "" {
		c.Provider = TrackerProviderGitHub
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
	assignee := strings.TrimSpace(c.Assignee)
	if assignee == "" {
		return fmt.Errorf("trackerIntake.assignee: required when intake is enabled")
	}
	if strings.EqualFold(assignee, "none") {
		return fmt.Errorf("trackerIntake.assignee: %q would authorize unassigned issues", c.Assignee)
	}
	if c.MaxConcurrent <= 0 {
		return fmt.Errorf("trackerIntake.maxConcurrent: must be positive when intake is enabled")
	}
	if c.Respawn != nil && c.Respawn.MaxRetries != nil && *c.Respawn.MaxRetries < 0 {
		return fmt.Errorf("trackerIntake.respawn.maxRetries: must not be negative")
	}
	return nil
}
