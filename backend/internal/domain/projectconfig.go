package domain

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// WorkspaceMode selects how the daemon provisions a session's working
// directory. It is resolved at spawn (top-level default plus a per-role
// override) and persisted per session so a later config flip never relocates an
// already-running session.
type WorkspaceMode string

const (
	// WorkspaceModeWorktree is the default: the daemon creates a private git
	// worktree per session under its managed root and checks out an
	// `ao/<sid>/root` branch there.
	WorkspaceModeWorktree WorkspaceMode = "worktree"
	// WorkspaceModeInPlace starts the session at the project's repo root and does
	// nothing more — no daemon-created branch, no daemon-created worktree. The
	// shared root stays read-only ground truth owned by the operator's SDLC
	// skills.
	WorkspaceModeInPlace WorkspaceMode = "in-place"
)

// IsKnown reports whether m is one of the supported workspace modes. The empty
// string is NOT known: it is the zero value, which resolution treats as the
// built-in default (worktree) rather than an explicit selection.
func (m WorkspaceMode) IsKnown() bool {
	switch m {
	case WorkspaceModeWorktree, WorkspaceModeInPlace:
		return true
	default:
		return false
	}
}

// ProjectConfig is the typed per-project configuration — the SQLite twin of the
// legacy agent-orchestrator.yaml `projects.<id>` block. It is persisted as one
// JSON blob per project and resolved at spawn. Each field is typed and
// validated; there is no free-form map.
//
// Only fields with a live consumer are modeled: DefaultBranch, Env, Symlinks,
// PostCreate, AgentConfig, and the role overrides are consumed at spawn;
// ProjectPrefix feeds project-wide naming. TrackerIntake feeds the background
// issue-intake loop.
type ProjectConfig struct {
	// DefaultBranch is the base branch new session worktrees are created from.
	DefaultBranch string `json:"defaultBranch,omitempty"`
	// ProjectPrefix is the short project-wide identifier used in display names,
	// worker branches, and worktree naming.
	ProjectPrefix string `json:"projectPrefix,omitempty"`
	// SessionPrefix is a deprecated JSON alias for ProjectPrefix. It is accepted
	// for existing config blobs and old clients; new writes normalize it away.
	SessionPrefix string `json:"sessionPrefix,omitempty"`
	// Workspace is the project-wide default workspace mode. Empty resolves to
	// WorkspaceModeWorktree (today's behavior), so existing projects are
	// unchanged on upgrade. A per-role override (Worker/Orchestrator) wins over
	// this value; see ResolveWorkspaceMode.
	Workspace WorkspaceMode `json:"workspace,omitempty" enum:"worktree,in-place"`

	// Env are extra environment variables forwarded into worker session
	// runtimes. AO-internal vars (AO_SESSION, AO_PROJECT_ID, …) always win.
	Env map[string]string `json:"env,omitempty"`
	// Symlinks are repo-relative paths symlinked into each session workspace.
	Symlinks []string `json:"symlinks,omitempty"`
	// PostCreate are shell commands run in the workspace after it is created.
	PostCreate []string `json:"postCreate,omitempty"`

	// AgentConfig is the default agent config for the project.
	AgentConfig AgentConfig `json:"agentConfig,omitempty"`
	// Worker, Orchestrator, and Prime are role-specific harness/agent-config
	// overrides.
	Worker       RoleOverride `json:"worker,omitempty"`
	Orchestrator RoleOverride `json:"orchestrator,omitempty"`
	Prime        RoleOverride `json:"prime,omitempty"`

	// WorkerMix, when non-empty, distributes worker spawns across weighted
	// agent/model buckets instead of always using Worker.Harness. It drives any
	// worker spawn that passes no explicit --agent: selection is deficit-based
	// (see WorkerMix.Select) so the running fleet converges on the configured
	// ratio. Empty preserves the single Worker.Harness behavior (back-compat).
	WorkerMix WorkerMix `json:"workerMix,omitempty"`

	// Reviewers names the agent(s) that review a worker's PR when a review is
	// triggered. It is configured independently of the Worker override; an empty
	// list falls back to claude-code (see ResolveReviewerHarness).
	Reviewers []ReviewerConfig `json:"reviewers,omitempty"`

	// TrackerIntake controls issue-driven worker spawning. It is opt-in and
	// read-only toward the tracker in v1: matching issues spawn sessions, but the
	// tracker is not commented on or transitioned.
	TrackerIntake TrackerIntakeConfig `json:"trackerIntake,omitempty"`

	// AutonomousMerge allows workers for this project to complete the configured
	// merge/deploy loop after their review and CI gates pass. Empty/false keeps
	// the project parked for a human merge decision.
	AutonomousMerge bool `json:"autonomousMerge,omitempty"`
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

// ResolveWorkspaceMode picks the workspace mode for a session of the given kind.
// Precedence mirrors ResolveReviewerHarness: the matching role override wins
// (Worker for KindWorker, Orchestrator for KindOrchestrator), else the top-level
// ProjectConfig.Workspace, else the built-in WorkspaceModeWorktree default. It
// never returns "": an empty configured value (IsKnown reports false) is treated
// as "unset" and falls through to the next precedence tier.
func (c ProjectConfig) ResolveWorkspaceMode(kind SessionKind) WorkspaceMode {
	var ro RoleOverride
	switch kind {
	case KindWorker:
		ro = c.Worker
	case KindOrchestrator:
		ro = c.Orchestrator
	case KindPrime:
		ro = c.Prime
	}
	if ro.Workspace.IsKnown() {
		return ro.Workspace
	}
	if c.Workspace.IsKnown() {
		return c.Workspace
	}
	return WorkspaceModeWorktree
}

// RoleOverride overrides the harness and/or agent config for a session role.
type RoleOverride struct {
	Harness     AgentHarness `json:"agent,omitempty"`
	AgentConfig AgentConfig  `json:"agentConfig,omitempty"`
	// Workspace overrides the workspace mode for this role. Empty defers to the
	// top-level ProjectConfig.Workspace (and ultimately the worktree default);
	// see ResolveWorkspaceMode.
	Workspace WorkspaceMode `json:"workspace,omitempty" enum:"worktree,in-place"`
	// WakeInterval controls how long a supervised orchestrator-like role may sit
	// at waiting_input before the daemon sends a supervision-loop nudge. It is
	// consumed for orchestrator and prime roles; empty means use the daemon
	// default.
	WakeInterval string `json:"wakeInterval,omitempty" description:"Orchestrator and prime roles only. Positive Go duration string such as 15m; empty uses the daemon default."`
	// WakeBackoff controls exponential idle wake spacing for daemon roles. When
	// unset, backoff is enabled with WakeInterval as its base and a 60m max.
	WakeBackoff *WakeBackoffConfig `json:"wakeBackoff,omitempty"`
	// InstructionsFile is an optional path to a file whose contents the daemon
	// appends to this role's built-in system prompt at spawn and restore. It
	// lets a project carry its own standing policy per role (orchestrator vs
	// worker) without smuggling it through the shared repo instruction context
	// that every session loads. A relative path resolves against the project
	// root; an absolute path is used as-is. When configured, an invalid,
	// missing, unreadable, oversized, or empty file blocks the role from
	// launching with incomplete authority instructions.
	InstructionsFile string `json:"instructionsFile,omitempty"`
}

// WakeBackoffConfig is the JSON config for daemon-role idle wake backoff. Base
// and Max are positive Go duration strings. Empty Base inherits WakeInterval;
// empty Max uses DefaultWakeBackoffMaxInterval.
type WakeBackoffConfig struct {
	Enabled *bool  `json:"enabled,omitempty" description:"When false, keep fixed-interval wake behavior at the base interval instead of exponential idle backoff. Defaults to true."`
	Base    string `json:"base,omitempty" description:"Positive Go duration for the reset/base wake interval. Empty inherits wakeInterval."`
	Max     string `json:"max,omitempty" description:"Positive Go duration cap for exponential idle wake backoff. Empty uses the daemon default."`
}

// WakeBackoffPolicy is the parsed scheduler policy.
type WakeBackoffPolicy struct {
	Enabled bool
	Base    time.Duration
	Max     time.Duration
}

// DefaultBranchName is the base branch used when a project configures none.
const DefaultBranchName = "main"

// DefaultOrchestratorWakeInterval is the daemon fallback when a project leaves
// orchestrator.wakeInterval unset.
const DefaultOrchestratorWakeInterval = 15 * time.Minute

// DefaultWakeBackoffMaxInterval is the cap for daemon-role idle wake backoff
// when wakeBackoff.max is unset.
const DefaultWakeBackoffMaxInterval = time.Hour

const defaultOrchestratorWakeIntervalConfig = "15m"

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
	c = c.Normalized()
	def := DefaultProjectConfig()
	if c.DefaultBranch == "" {
		c.DefaultBranch = def.DefaultBranch
	}
	if c.Orchestrator.WakeInterval == "" {
		c.Orchestrator.WakeInterval = defaultOrchestratorWakeIntervalConfig
	}
	if c.Prime.WakeInterval == "" {
		c.Prime.WakeInterval = defaultOrchestratorWakeIntervalConfig
	}
	c.TrackerIntake = c.TrackerIntake.WithDefaults()
	return c
}

// IsZero reports whether the config carries no settings, so storage can persist
// SQL NULL and resolution can skip an empty config.
func (c ProjectConfig) IsZero() bool {
	return c.DefaultBranch == "" &&
		c.ProjectPrefix == "" &&
		c.SessionPrefix == "" &&
		c.Workspace == "" &&
		len(c.Env) == 0 &&
		len(c.Symlinks) == 0 &&
		len(c.PostCreate) == 0 &&
		c.AgentConfig.IsZero() &&
		c.Worker.IsZero() &&
		c.Orchestrator.IsZero() &&
		c.Prime.IsZero() &&
		len(c.WorkerMix) == 0 &&
		len(c.Reviewers) == 0 &&
		trackerIntakeIsZero(c.TrackerIntake) &&
		!c.AutonomousMerge
}

func trackerIntakeIsZero(c TrackerIntakeConfig) bool {
	return !c.Enabled &&
		c.Provider == "" &&
		c.Repo == "" &&
		c.Assignee == "" &&
		len(c.Labels) == 0 &&
		len(c.ExcludeLabels) == 0 &&
		c.MaxConcurrent == 0 &&
		c.Respawn == nil
}

// EffectiveProjectPrefix returns the canonical project prefix, accepting the
// legacy sessionPrefix field as an input alias. projectPrefix wins when both
// fields are present.
func (c ProjectConfig) EffectiveProjectPrefix() string {
	if p := strings.TrimSpace(c.ProjectPrefix); p != "" {
		return p
	}
	return strings.TrimSpace(c.SessionPrefix)
}

// Normalized converts legacy sessionPrefix input into canonical projectPrefix
// storage. It intentionally clears SessionPrefix so new JSON emits only the
// canonical field.
func (c ProjectConfig) Normalized() ProjectConfig {
	if strings.TrimSpace(c.ProjectPrefix) == "" {
		c.ProjectPrefix = strings.TrimSpace(c.SessionPrefix)
	}
	c.SessionPrefix = ""
	return c
}

// MaxProjectPrefixRunes caps the project prefix so it cannot corrupt session
// names. A session display name is "<prefix> #<issue> <slug>" and is capped at
// 20 runes on every path, so an unbounded prefix eats the whole budget and
// truncates the issue number out of the name — a 17-rune prefix turned
// "polymath-ventures #281" into "polymath-ventures #2". Reserving " #99999"
// (7 runes) plus at least one rune of slug leaves 12.
const MaxProjectPrefixRunes = 12

// Validate rejects values outside the typed vocabulary so a bad config is
// refused when it is set (CLI/API) rather than surfacing at spawn.
func (c ProjectConfig) Validate() error {
	c = c.Normalized()
	if err := c.AgentConfig.Validate(); err != nil {
		return err
	}
	if err := validateNameComponent("projectPrefix", c.ProjectPrefix); err != nil {
		return err
	}
	if n := utf8.RuneCountInString(c.ProjectPrefix); n > MaxProjectPrefixRunes {
		return fmt.Errorf("projectPrefix: %d runes exceeds the %d-rune cap; a longer prefix truncates the issue number out of session names", n, MaxProjectPrefixRunes)
	}
	if err := validateGitRefName("defaultBranch", c.DefaultBranch); err != nil {
		return err
	}
	for k := range c.Env {
		if err := validateEnvKey(k); err != nil {
			return err
		}
	}
	if c.Workspace != "" && !c.Workspace.IsKnown() {
		return fmt.Errorf("workspace: unknown mode %q", c.Workspace)
	}
	for role, ro := range map[string]RoleOverride{"worker": c.Worker, "orchestrator": c.Orchestrator, "prime": c.Prime} {
		if ro.Harness != "" && !ro.Harness.IsKnown() {
			return fmt.Errorf("%s.agent: unknown harness %q", role, ro.Harness)
		}
		if ro.Workspace != "" && !ro.Workspace.IsKnown() {
			return fmt.Errorf("%s.workspace: unknown mode %q", role, ro.Workspace)
		}
		if err := ro.AgentConfig.Validate(); err != nil {
			return fmt.Errorf("%s.%w", role, err)
		}
		if err := validateInstructionsFile(role+".instructionsFile", ro.InstructionsFile); err != nil {
			return err
		}
	}
	if c.Worker.WakeInterval != "" {
		return fmt.Errorf("worker.wakeInterval: not supported")
	}
	if c.Worker.WakeBackoff != nil {
		return fmt.Errorf("worker.wakeBackoff: not supported")
	}
	if _, err := c.Orchestrator.WakeIntervalDuration(); err != nil {
		return fmt.Errorf("orchestrator.wakeInterval: %w", err)
	}
	if _, err := c.Prime.WakeIntervalDuration(); err != nil {
		return fmt.Errorf("prime.wakeInterval: %w", err)
	}
	if _, err := c.Orchestrator.WakeBackoffPolicy(); err != nil {
		return fmt.Errorf("orchestrator.wakeBackoff: %w", err)
	}
	if _, err := c.Prime.WakeBackoffPolicy(); err != nil {
		return fmt.Errorf("prime.wakeBackoff: %w", err)
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
	if err := c.WorkerMix.Validate(); err != nil {
		return err
	}
	if err := c.TrackerIntake.Validate(); err != nil {
		return err
	}
	return nil
}

// WakeIntervalDuration parses the configured wake interval. An empty value
// resolves to DefaultOrchestratorWakeInterval.
func (r RoleOverride) WakeIntervalDuration() (time.Duration, error) {
	if r.WakeInterval == "" {
		return DefaultOrchestratorWakeInterval, nil
	}
	d, err := time.ParseDuration(r.WakeInterval)
	if err != nil {
		return 0, err
	}
	if d <= 0 {
		return 0, fmt.Errorf("must be positive")
	}
	return d, nil
}

// WakeBackoffPolicy parses the daemon-role wake backoff config. An unset
// wakeBackoff block means enabled backoff using WakeInterval as the base and a
// one-hour cap. A disabled block keeps fixed-interval wake behavior.
func (r RoleOverride) WakeBackoffPolicy() (WakeBackoffPolicy, error) {
	base, err := r.WakeIntervalDuration()
	if err != nil {
		return WakeBackoffPolicy{}, err
	}
	maxInterval := DefaultWakeBackoffMaxInterval
	enabled := true
	maxSet := false
	if r.WakeBackoff != nil {
		if r.WakeBackoff.Enabled != nil {
			enabled = *r.WakeBackoff.Enabled
		}
		if r.WakeBackoff.Base != "" {
			base, err = parsePositiveDuration("base", r.WakeBackoff.Base)
			if err != nil {
				return WakeBackoffPolicy{}, err
			}
		}
		if r.WakeBackoff.Max != "" {
			maxInterval, err = parsePositiveDuration("max", r.WakeBackoff.Max)
			if err != nil {
				return WakeBackoffPolicy{}, err
			}
			maxSet = true
		}
	}
	if !maxSet && maxInterval < base {
		maxInterval = base
	}
	if maxSet && maxInterval < base {
		return WakeBackoffPolicy{}, fmt.Errorf("max must be greater than or equal to base")
	}
	return WakeBackoffPolicy{Enabled: enabled, Base: base, Max: maxInterval}, nil
}

func parsePositiveDuration(field, value string) (time.Duration, error) {
	d, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", field, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("%s: must be positive", field)
	}
	return d, nil
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

// validateGitRefName rejects a branch name git itself would refuse, so a typo
// like "mian" is caught at save rather than failing every later spawn at
// workspace creation with nothing on the Settings page to explain why. The rules
// are git-check-ref-format's, applied to a single branch name (one that may
// contain "/" but must not start or end with it).
func validateGitRefName(field, value string) error {
	if value == "" {
		return nil
	}
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%s: must not have leading or trailing whitespace", field)
	}
	invalid := func(reason string) error {
		return fmt.Errorf("%s: %q is not a valid branch name (%s)", field, value, reason)
	}
	if strings.ContainsAny(value, " ~^:?*[\\") {
		return invalid("must not contain space, ~, ^, :, ?, *, [ or backslash")
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return invalid("must not contain control characters")
		}
	}
	if strings.Contains(value, "..") || strings.Contains(value, "@{") {
		return invalid(`must not contain ".." or "@{"`)
	}
	if strings.HasPrefix(value, "/") || strings.HasSuffix(value, "/") || strings.Contains(value, "//") {
		return invalid("must not start or end with / or contain //")
	}
	if strings.HasPrefix(value, "-") || value == "@" {
		return invalid(`must not start with "-" or be "@"`)
	}
	if strings.HasSuffix(value, ".") || strings.HasSuffix(value, ".lock") {
		return invalid(`must not end with "." or ".lock"`)
	}
	for _, seg := range strings.Split(value, "/") {
		if seg == "" || strings.HasPrefix(seg, ".") || strings.HasSuffix(seg, ".lock") {
			return invalid("no path segment may be empty, start with a dot, or end with .lock")
		}
	}
	return nil
}

// validateEnvKey rejects a name that is not a legal POSIX environment variable
// name. An illegal key persists cleanly today and is forwarded into every session
// runtime, where it is silently dropped — a setting that appears set and does
// nothing.
func validateEnvKey(key string) error {
	if key == "" {
		return fmt.Errorf("env: key must not be empty")
	}
	for i, r := range key {
		switch {
		case r == '_':
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9' && i > 0:
		default:
			return fmt.Errorf("env[%q]: not a valid environment variable name (letters, digits and underscore only; must not start with a digit)", key)
		}
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

// validateInstructionsFile does light path-sanity on a role's instructions-file
// path. Unlike symlinks, an ABSOLUTE path is allowed (an operator may point at a
// file outside the repo). A relative path must not escape the project root via
// "..", mirroring validateRepoRelative's traversal guard. Whitespace-only paths
// are rejected so a stray space is not treated as a real file.
func validateInstructionsFile(name, p string) error {
	if p == "" {
		return nil
	}
	if strings.TrimSpace(p) != p {
		return fmt.Errorf("%s: must not have leading or trailing whitespace", name)
	}
	if filepath.IsAbs(p) {
		return nil
	}
	clean := filepath.Clean(p)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%s: relative path must not escape the project root", name)
	}
	for _, seg := range strings.Split(filepath.ToSlash(clean), "/") {
		if seg == ".." {
			return fmt.Errorf("%s: relative path must not escape the project root", name)
		}
	}
	return nil
}
