package domain

import (
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
)

// ProjectConfig is the typed per-project configuration — the SQLite twin of the
// legacy agent-orchestrator.yaml `projects.<id>` block. It is persisted as one
// JSON blob per project and resolved at spawn. Each field is typed and
// validated; there is no free-form map.
//
// Only fields with a live consumer are modeled: DefaultBranch, Env, Symlinks,
// PostCreate, AgentConfig, and the role overrides are consumed at spawn;
// SessionPrefix feeds the display prefix. TrackerIntake feeds the background
// issue-intake loop.
type ProjectConfig struct {
	// DefaultBranch is the base branch new session worktrees are created from.
	DefaultBranch string `json:"defaultBranch,omitempty"`
	// SessionPrefix overrides the displayed session-id prefix.
	SessionPrefix string `json:"sessionPrefix,omitempty"`

	// Env are extra environment variables forwarded into worker session
	// runtimes. AO-internal vars (AO_SESSION, AO_PROJECT_ID, …) always win.
	Env map[string]string `json:"env,omitempty"`
	// Symlinks are repo-relative paths symlinked into each session workspace.
	Symlinks []string `json:"symlinks,omitempty"`
	// PostCreate are shell commands run in the workspace after it is created.
	PostCreate []string `json:"postCreate,omitempty"`

	// AgentConfig is the default agent config for the project.
	AgentConfig AgentConfig `json:"agentConfig,omitempty"`
	// Worker and Orchestrator are role-specific harness/agent-config overrides.
	Worker       RoleOverride `json:"worker,omitempty"`
	Orchestrator RoleOverride `json:"orchestrator,omitempty"`

	// Reviewers names the agent(s) that review a worker's PR when a review is
	// triggered. It is configured independently of the Worker override; an empty
	// list falls back to claude-code (see ResolveReviewerHarness).
	Reviewers []ReviewerConfig `json:"reviewers,omitempty"`

	// TrackerIntake controls issue-driven worker spawning. It is opt-in and
	// read-only toward the tracker in v1: matching issues spawn sessions, but the
	// tracker is not commented on or transitioned.
	TrackerIntake TrackerIntakeConfig `json:"trackerIntake,omitempty"`
}

// TrackerIntakeConfig controls the first issue-intake slice for a project.
// Enabled requires at least one explicit eligibility rule so turning intake on
// cannot accidentally drain an entire issue backlog.
//
// Scope fields are provider-specific: only the field set that matches Provider
// is used; the others must be empty. Validate enforces this so a stale field
// from a prior provider does not silently survive a provider switch.
type TrackerIntakeConfig struct {
	Enabled bool `json:"enabled,omitempty"`
	// Provider defaults to github when Enabled is true.
	Provider TrackerProvider `json:"provider,omitempty" enum:"github,linear,jira"`
	// Repo is the GitHub-native repository key ("owner/repo"). When empty, the
	// intake loop derives it from the project's repo origin URL. GitHub only.
	Repo string `json:"repo,omitempty"`
	// Team is the Linear team key (e.g. "ENG"). Linear only.
	Team string `json:"team,omitempty"`
	// BaseURL is the Jira Cloud site URL (e.g. "acme.atlassian.net" or a full
	// https URL). Jira only.
	BaseURL string `json:"baseURL,omitempty"`
	// ProjectKey is the Jira project key (e.g. "ENG"). Jira only.
	ProjectKey string `json:"projectKey,omitempty"`
	// Labels narrows eligible issues. All labels are forwarded to the provider's
	// list filter; providers decide whether the match is all-of or provider-native.
	Labels []string `json:"labels,omitempty"`
	// Assignee narrows eligible issues to one assignee. Provider-specific values
	// such as "*" are passed through unchanged.
	Assignee string `json:"assignee,omitempty"`
	// Limit caps the number of issues fetched per poll. Zero lets the adapter use
	// its default.
	Limit int `json:"limit,omitempty"`
}

// ReviewerConfig names one reviewer agent by harness. The harness is drawn from
// the reviewer vocabulary (ReviewerHarness), which is distinct from the worker
// AgentHarness set.
type ReviewerConfig struct {
	Harness ReviewerHarness `json:"harness"`
}

// FallbackReviewerHarness is the reviewer used when a project configures none
// and the worker's harness is not itself a supported reviewer.
const FallbackReviewerHarness = ReviewerClaudeCode

// ResolveReviewerHarness picks the reviewer harness for a worker. A configured
// reviewer wins; otherwise claude-code is used.
func (c ProjectConfig) ResolveReviewerHarness(_ AgentHarness) ReviewerHarness {
	if len(c.Reviewers) > 0 {
		return c.Reviewers[0].Harness
	}
	return FallbackReviewerHarness
}

// RoleOverride overrides the harness and/or agent config for a session role.
type RoleOverride struct {
	Harness     AgentHarness `json:"agent,omitempty"`
	AgentConfig AgentConfig  `json:"agentConfig,omitempty"`
}

// DefaultBranchName is the base branch used when a project configures none.
const DefaultBranchName = "main"

// DefaultProjectConfig returns the config a project has when it sets nothing:
// branch "main". Every other field defaults to its zero value (no
// env/symlinks/post-create, agent + role defaults).
func DefaultProjectConfig() ProjectConfig {
	return ProjectConfig{
		DefaultBranch: DefaultBranchName,
	}
}

// WithDefaults overlays DefaultProjectConfig onto c, filling only fields the
// project left unset. A set field is always preserved.
func (c ProjectConfig) WithDefaults() ProjectConfig {
	def := DefaultProjectConfig()
	if c.DefaultBranch == "" {
		c.DefaultBranch = def.DefaultBranch
	}
	c.TrackerIntake = c.TrackerIntake.WithDefaults()
	return c
}

// IsZero reports whether the config carries no settings, so storage can persist
// SQL NULL and resolution can skip an empty config.
func (c ProjectConfig) IsZero() bool {
	return reflect.DeepEqual(c, ProjectConfig{})
}

// Validate rejects values outside the typed vocabulary so a bad config is
// refused when it is set (CLI/API) rather than surfacing at spawn.
func (c ProjectConfig) Validate() error {
	if err := c.AgentConfig.Validate(); err != nil {
		return err
	}
	if err := validateNameComponent("sessionPrefix", c.SessionPrefix); err != nil {
		return err
	}
	for role, ro := range map[string]RoleOverride{"worker": c.Worker, "orchestrator": c.Orchestrator} {
		if ro.Harness != "" && !ro.Harness.IsKnown() {
			return fmt.Errorf("%s.agent: unknown harness %q", role, ro.Harness)
		}
		if err := ro.AgentConfig.Validate(); err != nil {
			return fmt.Errorf("%s.%w", role, err)
		}
	}
	for _, s := range c.Symlinks {
		if err := validateRepoRelative(s); err != nil {
			return fmt.Errorf("symlink %q: %w", s, err)
		}
	}
	for i, rv := range c.Reviewers {
		if !rv.Harness.IsKnown() {
			return fmt.Errorf("reviewers[%d].harness: unknown harness %q", i, rv.Harness)
		}
	}
	if err := c.TrackerIntake.Validate(); err != nil {
		return err
	}
	return nil
}

// WithDefaults fills the provider only when intake is enabled. Disabled intake
// leaves the zero value untouched so empty project configs still store as NULL.
func (c TrackerIntakeConfig) WithDefaults() TrackerIntakeConfig {
	if c.Enabled && c.Provider == "" {
		c.Provider = TrackerProviderGitHub
	}
	return c
}

// Validate rejects accidental broad intake, unknown providers, and
// cross-provider field bleed (e.g. a Linear "team" left set after switching to
// GitHub).
func (c TrackerIntakeConfig) Validate() error {
	if !c.Enabled {
		return nil
	}
	c = c.WithDefaults()
	switch c.Provider {
	case TrackerProviderGitHub:
		if err := validateNoWhitespaceField("trackerIntake.repo", c.Repo); err != nil {
			return err
		}
		if err := mustBeEmpty("trackerIntake.team", c.Team, "linear"); err != nil {
			return err
		}
		if err := mustBeEmpty("trackerIntake.baseURL", c.BaseURL, "jira"); err != nil {
			return err
		}
		if err := mustBeEmpty("trackerIntake.projectKey", c.ProjectKey, "jira"); err != nil {
			return err
		}
	case TrackerProviderLinear:
		team := strings.TrimSpace(c.Team)
		if team == "" || team != c.Team {
			return fmt.Errorf("trackerIntake.team: must be a non-empty Linear team key without surrounding whitespace")
		}
		if err := mustBeEmpty("trackerIntake.repo", c.Repo, "github"); err != nil {
			return err
		}
		if err := mustBeEmpty("trackerIntake.baseURL", c.BaseURL, "jira"); err != nil {
			return err
		}
		if err := mustBeEmpty("trackerIntake.projectKey", c.ProjectKey, "jira"); err != nil {
			return err
		}
	case TrackerProviderJira:
		base := strings.TrimSpace(c.BaseURL)
		if base == "" || base != c.BaseURL {
			return fmt.Errorf("trackerIntake.baseURL: must be a non-empty Jira site URL without surrounding whitespace")
		}
		if strings.HasSuffix(c.BaseURL, "/") {
			return fmt.Errorf("trackerIntake.baseURL: must not have a trailing slash")
		}
		projectKey := strings.TrimSpace(c.ProjectKey)
		if projectKey == "" || projectKey != c.ProjectKey {
			return fmt.Errorf("trackerIntake.projectKey: must be a non-empty Jira project key without surrounding whitespace")
		}
		if err := mustBeEmpty("trackerIntake.repo", c.Repo, "github"); err != nil {
			return err
		}
		if err := mustBeEmpty("trackerIntake.team", c.Team, "linear"); err != nil {
			return err
		}
	default:
		return fmt.Errorf("trackerIntake.provider: unknown provider %q", c.Provider)
	}
	hasLabel := false
	for i, label := range c.Labels {
		trimmed := strings.TrimSpace(label)
		if trimmed == "" {
			return fmt.Errorf("trackerIntake.labels[%d]: must not be empty", i)
		}
		if trimmed != label {
			return fmt.Errorf("trackerIntake.labels[%d]: must not contain surrounding whitespace", i)
		}
		hasLabel = true
	}
	assignee := strings.TrimSpace(c.Assignee)
	if assignee != c.Assignee {
		return fmt.Errorf("trackerIntake.assignee: must not contain surrounding whitespace")
	}
	if !hasLabel && assignee == "" {
		return fmt.Errorf("trackerIntake: enabled intake requires at least one label or assignee rule")
	}
	if c.Limit < 0 {
		return fmt.Errorf("trackerIntake.limit: must be non-negative")
	}
	return nil
}

func mustBeEmpty(field, value, owningProvider string) error {
	if strings.TrimSpace(value) != "" {
		return fmt.Errorf("%s: only valid for provider %q", field, owningProvider)
	}
	return nil
}

func validateNoWhitespaceField(field, value string) error {
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%s: must not contain surrounding whitespace", field)
	}
	if strings.ContainsAny(value, " \t\r\n") {
		return fmt.Errorf("%s: must not contain whitespace", field)
	}
	return nil
}

func validateNameComponent(name, value string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	if strings.ContainsAny(trimmed, `/\`) || trimmed == "." || trimmed == ".." {
		return fmt.Errorf("%s: must not contain path separators or traversal components", name)
	}
	return nil
}

// validateRepoRelative refuses paths that would let a project config escape
// its repo root: absolute paths and any ".." segment (before or after Clean).
// The same guard runs at spawn time as defense-in-depth, but enforcing it here
// rejects bad config when it is set rather than at every later spawn.
func validateRepoRelative(p string) error {
	trimmed := strings.TrimSpace(p)
	if trimmed == "" {
		return nil
	}
	if filepath.IsAbs(trimmed) || strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, `\`) {
		return fmt.Errorf("path must be repo-relative and must not escape the project root")
	}
	clean := filepath.Clean(trimmed)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path must be repo-relative and must not escape the project root")
	}
	for _, seg := range strings.Split(filepath.ToSlash(clean), "/") {
		if seg == ".." {
			return fmt.Errorf("path must be repo-relative and must not escape the project root")
		}
	}
	return nil
}
