package domain

import (
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"time"
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
	// Worker and Orchestrator are role-specific harness/agent-config overrides.
	Worker       RoleOverride `json:"worker,omitempty"`
	Orchestrator RoleOverride `json:"orchestrator,omitempty"`

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
	// WakeInterval controls how long an orchestrator may sit at waiting_input
	// before the daemon sends a supervision-loop nudge. It is consumed only for
	// the orchestrator role; empty means use DefaultOrchestratorWakeInterval.
	WakeInterval string `json:"wakeInterval,omitempty" description:"Orchestrator role only. Positive Go duration string such as 15m; empty uses the daemon default."`
	// InstructionsFile is an optional path to a file whose contents the daemon
	// appends to this role's built-in system prompt at spawn and restore. It
	// lets a project carry its own standing policy per role (orchestrator vs
	// worker) without smuggling it through the shared repo instruction context
	// that every session loads. A relative path resolves against the project
	// root; an absolute path is used as-is. A missing/unreadable file never
	// blocks a spawn — the daemon logs a warning and spawns without it.
	InstructionsFile string `json:"instructionsFile,omitempty"`
}

// DefaultBranchName is the base branch used when a project configures none.
const DefaultBranchName = "main"

// DefaultOrchestratorWakeInterval is the daemon fallback when a project leaves
// orchestrator.wakeInterval unset.
const DefaultOrchestratorWakeInterval = 15 * time.Minute

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
	c.TrackerIntake = c.TrackerIntake.WithDefaults()
	return c
}

// IsZero reports whether the config carries no settings, so storage can persist
// SQL NULL and resolution can skip an empty config.
func (c ProjectConfig) IsZero() bool {
	return reflect.DeepEqual(c, ProjectConfig{})
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
	if c.Workspace != "" && !c.Workspace.IsKnown() {
		return fmt.Errorf("workspace: unknown mode %q", c.Workspace)
	}
	for role, ro := range map[string]RoleOverride{"worker": c.Worker, "orchestrator": c.Orchestrator} {
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
	if _, err := c.Orchestrator.WakeIntervalDuration(); err != nil {
		return fmt.Errorf("orchestrator.wakeInterval: %w", err)
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
