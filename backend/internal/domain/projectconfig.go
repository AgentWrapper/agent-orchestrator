package domain

import (
	"fmt"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
)

// ProjectConfig is the typed per-project configuration — the SQLite twin of the
// legacy agent-orchestrator.yaml `projects.<id>` block. It is persisted as one
// JSON blob per project and resolved at spawn. Each field is typed and
// validated; there is no free-form map.
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

	// AgentRules are project-specific standing instructions for worker sessions.
	AgentRules string `json:"agentRules,omitempty"`
	// AgentRulesFile is a repo-relative Markdown/text file whose contents are
	// appended to AgentRules for worker sessions.
	AgentRulesFile string `json:"agentRulesFile,omitempty"`
	// OrchestratorRules are project-specific standing instructions for
	// orchestrator sessions.
	OrchestratorRules string `json:"orchestratorRules,omitempty"`

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

	// SCM selects the provider, connection, and optional repository override for
	// this project. Provider selection is never daemon-global.
	SCM SCMProjectConfig `json:"scm,omitempty"`
	// Coordinator controls project Coordinator behavior.
	Coordinator CoordinatorConfig `json:"coordinator,omitempty"`
}

// SCMProvider identifies an SCM provider implementation.
type SCMProvider string

// Supported SCM providers.
const (
	SCMProviderGitHub SCMProvider = "github"
	SCMProviderGitLab SCMProvider = "gitlab"
)

// SCMProjectConfig selects the SCM connection and optional repository override
// for one project.
type SCMProjectConfig struct {
	Provider     SCMProvider `json:"provider,omitempty" enum:"github,gitlab"`
	ConnectionID string      `json:"connectionId,omitempty"`
	Repo         string      `json:"repo,omitempty"`
}

// CoordinatorConfig controls automatic Coordinator wake-up for one project.
type CoordinatorConfig struct {
	AutoWake bool `json:"autoWake,omitempty"`
}

// IsKnown reports whether p names a supported SCM provider.
func (p SCMProvider) IsKnown() bool {
	return p == SCMProviderGitHub || p == SCMProviderGitLab
}

// WithDefaults resolves the legacy empty SCM config to the built-in GitHub
// connection without changing the stored config.
func (c SCMProjectConfig) WithDefaults() SCMProjectConfig {
	if c.Provider == "" {
		c.Provider = SCMProviderGitHub
	}
	if c.ConnectionID == "" && c.Provider == SCMProviderGitHub {
		c.ConnectionID = "github-default"
	}
	return c
}

// Validate rejects unknown providers, unsafe connection IDs, and repository
// paths that the selected provider cannot parse.
func (c SCMProjectConfig) Validate() error {
	if !c.Provider.IsKnown() {
		return fmt.Errorf("scm.provider: unsupported provider %q", c.Provider)
	}
	if err := validateIDComponent("scm.connectionId", c.ConnectionID); err != nil {
		return err
	}
	if err := validateSCMRepo(c.Provider, c.Repo); err != nil {
		return fmt.Errorf("scm.repo %q: %w", c.Repo, err)
	}
	return nil
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
// reviewer wins. Otherwise the worker's own harness is reused when it is itself
// a supported reviewer (e.g. a codex worker is reviewed by codex); a worker
// whose harness is not a reviewer (e.g. crush) falls back to claude-code.
func (c ProjectConfig) ResolveReviewerHarness(worker AgentHarness) ReviewerHarness {
	if len(c.Reviewers) > 0 {
		return c.Reviewers[0].Harness
	}
	if rh := ReviewerHarness(worker); rh.IsKnown() {
		return rh
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

// DefaultProjectConfig returns the resolved config a project has when it sets
// nothing: branch "main" and the built-in GitHub SCM connection. Every other
// field defaults to its zero value.
func DefaultProjectConfig() ProjectConfig {
	return ProjectConfig{
		DefaultBranch: DefaultBranchName,
		SCM:           (SCMProjectConfig{}).WithDefaults(),
	}
}

// WithDefaults overlays DefaultProjectConfig onto c, filling only fields the
// project left unset. A set field is always preserved.
func (c ProjectConfig) WithDefaults() ProjectConfig {
	def := DefaultProjectConfig()
	if c.DefaultBranch == "" {
		c.DefaultBranch = def.DefaultBranch
	}
	c.SCM = c.SCM.WithDefaults()
	c.TrackerIntake = c.TrackerIntake.withDefaults(c.SCM.Provider)
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
	scm := c.SCM.WithDefaults()
	if err := scm.Validate(); err != nil {
		return err
	}
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
	if err := validateRepoRelative(c.AgentRulesFile); err != nil {
		return fmt.Errorf("agentRulesFile %q: %w", c.AgentRulesFile, err)
	}
	for i, rv := range c.Reviewers {
		if !rv.Harness.IsKnown() {
			return fmt.Errorf("reviewers[%d].harness: unknown harness %q", i, rv.Harness)
		}
	}
	if err := c.TrackerIntake.validate(scm.Provider); err != nil {
		return err
	}
	return nil
}

var idComponentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func validateIDComponent(name, value string) error {
	if value == "" {
		return fmt.Errorf("%s: is required", name)
	}
	if strings.Contains(value, "..") || !idComponentPattern.MatchString(value) {
		return fmt.Errorf("%s: must be a safe ID component", name)
	}
	return nil
}

func validateSCMRepo(provider SCMProvider, repo string) error {
	if repo == "" {
		return nil
	}
	if strings.TrimSpace(repo) != repo || strings.ContainsAny(repo, "\\:#?\t\n\r ") {
		return fmt.Errorf("must be a repository path")
	}
	path := strings.TrimSuffix(repo, ".git")
	parts := strings.Split(path, "/")
	if (provider == SCMProviderGitHub && len(parts) != 2) || (provider == SCMProviderGitLab && len(parts) < 2) {
		return fmt.Errorf("must be a valid %s repository path", provider)
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("must be a valid %s repository path", provider)
		}
	}
	return nil
}

func validateNoWhitespaceField(name, value string) error {
	if value == "" {
		return nil
	}
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%s: must not have leading or trailing whitespace", name)
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
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path must be repo-relative and must not escape the project root")
	}
	for _, seg := range strings.Split(filepath.ToSlash(clean), "/") {
		if seg == ".." {
			return fmt.Errorf("path must be repo-relative and must not escape the project root")
		}
	}
	return nil
}
