package domain

import (
	"fmt"
	"strings"
)

// TrackerProvider identifies an issue-tracker provider implementation.
type TrackerProvider string

// Supported issue-tracker providers.
const (
	TrackerProviderGitHub TrackerProvider = "github"
	TrackerProviderLinear TrackerProvider = "linear"
)

// TrackerID identifies one issue. Native is the provider's own canonical form:
// "owner/repo#123" for GitHub and the stable issue UUID for Linear.
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

// TrackerScope identifies a provider-native scope for cross-issue queries like
// Tracker.List. Native is "owner/repo" for GitHub and "team:<id>" or
// "project:<id>" for Linear.
type TrackerScope struct {
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
// Enabled requires an explicit assignee eligibility rule so turning intake on
// cannot accidentally drain an entire issue backlog.
type TrackerIntakeConfig struct {
	Enabled bool `json:"enabled,omitempty"`
	// Provider defaults to github when Enabled is true.
	Provider TrackerProvider `json:"provider,omitempty" enum:"github,linear"`
	// Repo is the GitHub-native repository key ("owner/repo"). When empty, the
	// intake loop derives it from the project's repo origin URL. GitHub only.
	Repo string `json:"repo,omitempty"`
	// Scope is required for Linear and uses "team:<id>" or "project:<id>".
	Scope string `json:"scope,omitempty"`
	// Assignee narrows eligible issues to one assignee. Provider-specific values
	// such as "*" are passed through unchanged.
	Assignee string `json:"assignee,omitempty"`
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
	if c.Provider != TrackerProviderGitHub && c.Provider != TrackerProviderLinear {
		return fmt.Errorf("trackerIntake.provider: unsupported provider %q", c.Provider)
	}
	if err := validateNoWhitespaceField("trackerIntake.repo", c.Repo); err != nil {
		return err
	}
	if err := validateNoWhitespaceField("trackerIntake.scope", c.Scope); err != nil {
		return err
	}
	if err := validateNoWhitespaceField("trackerIntake.assignee", c.Assignee); err != nil {
		return err
	}
	if strings.TrimSpace(c.Assignee) == "" {
		return fmt.Errorf("trackerIntake: assignee is required when enabled")
	}
	switch c.Provider {
	case TrackerProviderGitHub:
		if c.Scope != "" {
			return fmt.Errorf("trackerIntake.scope: only valid for linear")
		}
	case TrackerProviderLinear:
		if c.Repo != "" {
			return fmt.Errorf("trackerIntake.repo: only valid for github")
		}
		kind, native, ok := strings.Cut(c.Scope, ":")
		if !ok || (kind != "team" && kind != "project") || native == "" {
			return fmt.Errorf(`trackerIntake.scope: linear scope must be "team:<id>" or "project:<id>"`)
		}
	}
	return nil
}
