package cli

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type projectAddOptions struct {
	path              string
	id                string
	name              string
	workerAgent       string
	orchestratorAgent string
	permission        string
	workspace         string
	projectPrefix     string
	env               []string
	configJSON        string
	asWorkspace       bool
}

type projectListOptions struct {
	json bool
}

type projectGetOptions struct {
	json bool
}

type projectRemoveOptions struct {
	json bool
	yes  bool
}

// addProjectRequest mirrors the daemon's project AddInput body for
// POST /api/v1/projects. projectId and name are optional (pointers omit them).
type addProjectRequest struct {
	Path        string         `json:"path"`
	ProjectID   *string        `json:"projectId,omitempty"`
	Name        *string        `json:"name,omitempty"`
	Config      *projectConfig `json:"config,omitempty"`
	AsWorkspace bool           `json:"asWorkspace,omitempty"`
}

type projectSummary struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	ProjectPrefix   string `json:"projectPrefix"`
	SessionPrefix   string `json:"sessionPrefix"`
	ResolveError    string `json:"resolveError,omitempty"`
	Paused          bool   `json:"paused"`
	PauseState      string `json:"pauseState"`
	DrainingWorkers int    `json:"drainingWorkers,omitempty"`
}

type projectDetails struct {
	ID              string                 `json:"id"`
	Name            string                 `json:"name"`
	Kind            string                 `json:"kind"`
	Path            string                 `json:"path"`
	Repo            string                 `json:"repo"`
	DefaultBranch   string                 `json:"defaultBranch"`
	ConfigETag      string                 `json:"configETag,omitempty"`
	Agent           string                 `json:"agent,omitempty"`
	Config          *projectConfig         `json:"config,omitempty"`
	WorkspaceRepos  []workspaceRepoDetails `json:"workspaceRepos,omitempty"`
	ResolveError    string                 `json:"resolveError,omitempty"`
	Paused          bool                   `json:"paused"`
	PauseState      string                 `json:"pauseState"`
	DrainingWorkers int                    `json:"drainingWorkers,omitempty"`
}

type workspaceRepoDetails struct {
	Name         string `json:"name"`
	RelativePath string `json:"relativePath"`
	Repo         string `json:"repo"`
}

// agentConfig mirrors the daemon's typed domain.AgentConfig for the CLI client.
type agentConfig struct {
	Model       string `json:"model,omitempty"`
	Effort      string `json:"effort,omitempty"`
	Permissions string `json:"permissions,omitempty"`
	// ModelByHarness mirrors domain.AgentConfig.ModelByHarness so a
	// --config-json payload round-trips the per-harness model/effort map through
	// to the daemon instead of silently dropping it.
	ModelByHarness map[string]harnessModel `json:"modelByHarness,omitempty"`
}

// harnessModel mirrors domain.HarnessModel for the CLI client.
type harnessModel struct {
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
}

// roleOverride mirrors domain.RoleOverride.
type roleOverride struct {
	Agent       string      `json:"agent,omitempty"`
	AgentConfig agentConfig `json:"agentConfig,omitempty"`
	// Workspace mirrors domain.RoleOverride.Workspace so a --config-json payload
	// round-trips the per-role workspace mode through to the daemon instead of
	// silently dropping it.
	Workspace        string             `json:"workspace,omitempty"`
	InstructionsFile string             `json:"instructionsFile,omitempty"`
	WakeInterval     string             `json:"wakeInterval,omitempty"`
	WakeBackoff      *wakeBackoffConfig `json:"wakeBackoff,omitempty"`
}

// wakeBackoffConfig mirrors domain.WakeBackoffConfig for JSON round-trips.
type wakeBackoffConfig struct {
	Enabled *bool  `json:"enabled,omitempty"`
	Base    string `json:"base,omitempty"`
	Max     string `json:"max,omitempty"`
}

// workerMixEntry mirrors domain.WorkerMixEntry so a --config-json payload
// round-trips the weighted worker mix through to the daemon instead of dropping it.
type workerMixEntry struct {
	Agent  string `json:"agent"`
	Model  string `json:"model,omitempty"`
	Weight int    `json:"weight"`
}

// reviewerConfig mirrors domain.ReviewerConfig so project JSON round-trips
// configured reviewer harnesses through the CLI mirror.
type reviewerConfig struct {
	Harness string `json:"harness"`
}

// trackerIntakeConfig mirrors domain.TrackerIntakeConfig.
type trackerRespawnPolicy struct {
	Disabled   bool `json:"disabled,omitempty"`
	MaxRetries *int `json:"maxRetries,omitempty"`
}

type trackerIntakeConfig struct {
	Enabled       bool                  `json:"enabled,omitempty"`
	Provider      string                `json:"provider,omitempty"`
	Repo          string                `json:"repo,omitempty"`
	Assignee      string                `json:"assignee,omitempty"`
	Labels        []string              `json:"labels,omitempty"`
	ExcludeLabels []string              `json:"excludeLabels,omitempty"`
	MaxConcurrent int                   `json:"maxConcurrent,omitempty"`
	Respawn       *trackerRespawnPolicy `json:"respawn,omitempty"`
}

// projectConfig mirrors the daemon's typed domain.ProjectConfig for the CLI
// client. The CLI sets common fields via flags and the whole object via
// --config-json.
type projectConfig struct {
	DefaultBranch string `json:"defaultBranch,omitempty"`
	ProjectPrefix string `json:"projectPrefix,omitempty"`
	SessionPrefix string `json:"sessionPrefix,omitempty"`
	// AutonomousMerge mirrors domain.ProjectConfig.AutonomousMerge. It controls
	// whether spawned workers receive per-project autonomous merge permission.
	AutonomousMerge bool `json:"autonomousMerge,omitempty"`
	// Workspace mirrors domain.ProjectConfig.Workspace (the project-wide default
	// workspace mode). Empty resolves to worktree on the daemon; a --config-json
	// payload round-trips it instead of silently dropping it.
	Workspace     string              `json:"workspace,omitempty"`
	Env           map[string]string   `json:"env,omitempty"`
	Symlinks      []string            `json:"symlinks,omitempty"`
	PostCreate    []string            `json:"postCreate,omitempty"`
	AgentConfig   agentConfig         `json:"agentConfig,omitempty"`
	Worker        roleOverride        `json:"worker,omitempty"`
	Orchestrator  roleOverride        `json:"orchestrator,omitempty"`
	Prime         roleOverride        `json:"prime,omitempty"`
	WorkerMix     []workerMixEntry    `json:"workerMix,omitempty"`
	Reviewers     []reviewerConfig    `json:"reviewers,omitempty"`
	TrackerIntake trackerIntakeConfig `json:"trackerIntake,omitempty"`
}

// setConfigRequest mirrors the daemon's SetConfigInput body for
// PUT /api/v1/projects/{id}/config.
type setConfigRequest struct {
	Config    projectConfig `json:"config"`
	rawConfig json.RawMessage
}

func (r setConfigRequest) MarshalJSON() ([]byte, error) {
	if len(r.rawConfig) > 0 {
		return json.Marshal(struct {
			Config json.RawMessage `json:"config"`
		}{Config: r.rawConfig})
	}
	return json.Marshal(struct {
		Config projectConfig `json:"config"`
	}{Config: r.Config})
}

type projectSetConfigOptions struct {
	defaultBranch                string
	autonomousMerge              bool
	projectPrefix                string
	legacySessionPrefix          string
	workspace                    string
	model                        string
	permission                   string
	workerAgent                  string
	orchestratorAgent            string
	primeAgent                   string
	workerInstructionsFile       string
	orchestratorInstructionsFile string
	primeInstructionsFile        string
	primeWakeInterval            string
	env                          []string
	symlink                      []string
	postCreate                   []string
	trackerIntake                bool
	trackerRepo                  string
	trackerAssignee              string
	trackerMaxConcurrent         int
	trackerIntakeSet             bool
	autonomousMergeSet           bool
	configJSON                   string
	clear                        bool
	json                         bool
	allowProductionConfig        bool
}

// allowProductionConfigEnv is the operator-set escape hatch that pairs with the
// --allow-production-config flag for the config-mutation guard below.
const allowProductionConfigEnv = "AO_ALLOW_PRODUCTION_CONFIG"

// guardProductionConfigMutation is a COOPERATIVE containment check, not a
// security boundary. An ao-spawned agent session inherits AO_SESSION_ID (and the
// production AO_RUN_FILE) from the daemon that launched it, so a worker running
// `ao project set-config` would rewrite the LIVE daemon's config for the whole
// fleet — the exact failure that crash-looped production in #305. When a session
// id is present we refuse the mutation unless an operator deliberately overrides
// it. An operator's own shell has no AO_SESSION_ID, so it is never affected.
func guardProductionConfigMutation(allowFlag bool) error {
	sessionID := strings.TrimSpace(os.Getenv("AO_SESSION_ID"))
	if sessionID == "" {
		// Not an ao-spawned session (e.g. an operator's own shell): no guard.
		return nil
	}
	if allowFlag || envIsTruthy(os.Getenv(allowProductionConfigEnv)) {
		return nil
	}
	return fmt.Errorf(
		"refusing to mutate live project config from inside an ao-spawned session (AO_SESSION_ID=%s): "+
			"a worker writing the production daemon's config can crash-loop the whole fleet (#305). "+
			"If you are an operator and intend this, re-run with --allow-production-config or set %s=1. "+
			"(Only ao-spawned sessions inherit AO_SESSION_ID; your own shell is unaffected.)",
		sessionID, allowProductionConfigEnv,
	)
}

// envIsTruthy treats the common affirmative env-var spellings as true.
func envIsTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

type projectListResult struct {
	Projects []projectSummary `json:"projects"`
}

type projectGetResult struct {
	Status  string         `json:"status"`
	Project projectDetails `json:"project"`
}

type projectResult struct {
	Project projectDetails `json:"project"`
}

type projectRemoveResult struct {
	OK                bool   `json:"ok,omitempty"`
	ID                string `json:"id,omitempty"`
	ProjectID         string `json:"projectId,omitempty"`
	RemovedStorageDir *bool  `json:"removedStorageDir,omitempty"`
}

func newProjectCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "project",
		Short: "Manage projects",
	}
	cmd.AddCommand(newProjectListCommand(ctx))
	cmd.AddCommand(newProjectGetCommand(ctx))
	cmd.AddCommand(newProjectAddCommand(ctx))
	cmd.AddCommand(newProjectSetConfigCommand(ctx))
	cmd.AddCommand(newProjectRemoveCommand(ctx))
	return cmd
}

func newProjectListCommand(ctx *commandContext) *cobra.Command {
	var opts projectListOptions
	cmd := &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   "List registered projects",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var res projectListResult
			if err := ctx.getJSON(cmd.Context(), "projects", &res); err != nil {
				return err
			}
			sort.Slice(res.Projects, func(i, j int) bool {
				return res.Projects[i].ID < res.Projects[j].ID
			})
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), res)
			}
			return writeProjectList(cmd, res.Projects)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output projects as JSON")
	return cmd
}

func newProjectGetCommand(ctx *commandContext) *cobra.Command {
	var opts projectGetOptions
	cmd := &cobra.Command{
		Use:   "get <id>",
		Short: "Fetch one registered project",
		Args: func(cmd *cobra.Command, args []string) error {
			if err := cobra.ExactArgs(1)(cmd, args); err != nil {
				return usageError{err}
			}
			if strings.TrimSpace(args[0]) == "" {
				return usageError{errors.New("usage: project id is required")}
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			var res projectGetResult
			if err := ctx.getJSON(cmd.Context(), "projects/"+url.PathEscape(id), &res); err != nil {
				return err
			}
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), res)
			}
			return writeProjectDetails(cmd, res)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output project as JSON")
	return cmd
}

func newProjectAddCommand(ctx *commandContext) *cobra.Command {
	var opts projectAddOptions
	cmd := &cobra.Command{
		Use:   "add",
		Short: "Register a local git repo as a project",
		Long: "Register a local git repo as a project so sessions can be spawned in it.\n\n" +
			"The path must be an existing git repository on disk. With --as-workspace, " +
			"the path may be a parent folder containing direct child git repositories; " +
			"AO initializes/adopts the parent as the root repo and gitignores children.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if opts.path == "" {
				return usageError{fmt.Errorf("--path is required")}
			}
			req := addProjectRequest{Path: opts.path, AsWorkspace: opts.asWorkspace}
			if opts.id != "" {
				req.ProjectID = &opts.id
			}
			if opts.name != "" {
				req.Name = &opts.name
			}
			// A project registered with no config used to be born empty and deadlock at
			// spawn, because the standard baseline only existed in the web UI. The daemon
			// now applies it on every creation path, so these flags are overrides, not
			// requirements: whatever is left unset here the daemon fills in.
			if opts.configJSON != "" {
				var cfg projectConfig
				dec := json.NewDecoder(strings.NewReader(opts.configJSON))
				dec.DisallowUnknownFields()
				if err := dec.Decode(&cfg); err != nil {
					return usageError{fmt.Errorf("--config-json: %w", err)}
				}
				req.Config = &cfg
			} else if opts.workerAgent != "" || opts.orchestratorAgent != "" || opts.permission != "" ||
				opts.workspace != "" || opts.projectPrefix != "" || len(opts.env) > 0 {
				env, err := parseEnvPairs(opts.env)
				if err != nil {
					return err
				}
				req.Config = &projectConfig{
					Worker:        roleOverride{Agent: opts.workerAgent},
					Orchestrator:  roleOverride{Agent: opts.orchestratorAgent},
					ProjectPrefix: opts.projectPrefix,
					Workspace:     opts.workspace,
					Env:           env,
					AgentConfig:   agentConfig{Permissions: opts.permission},
				}
			}
			var res projectResult
			if err := ctx.postJSON(cmd.Context(), "projects", req, &res); err != nil {
				return err
			}
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "registered project %s at %s\n", res.Project.ID, res.Project.Path)
			return err
		},
	}
	f := cmd.Flags()
	f.StringVar(&opts.path, "path", "", "Absolute path to the local git repo (required)")
	f.StringVar(&opts.id, "id", "", "Project id (default: derived by the daemon from the path)")
	f.StringVar(&opts.name, "name", "", "Display name")
	f.StringVar(&opts.workerAgent, "worker-agent", "", "Default worker session agent")
	f.StringVar(&opts.permission, "permission", "", "Permission mode: default, accept-edits, auto, bypass-permissions")
	f.StringVar(&opts.workspace, "workspace", "", "Session workspace mode: worktree or in-place")
	f.StringVar(&opts.projectPrefix, "project-prefix", "", "Short project-wide prefix for names, branches, and worktrees")
	f.StringArrayVar(&opts.env, "env", nil, "Env var KEY=VALUE forwarded into sessions (repeatable)")
	f.StringVar(&opts.configJSON, "config-json", "", "Full config as a JSON object (overrides the field flags)")
	f.StringVar(&opts.orchestratorAgent, "orchestrator-agent", "", "Default orchestrator session agent")
	f.BoolVar(&opts.asWorkspace, "as-workspace", false, "Register a parent folder as a workspace project (root-as-repo plus direct child repos)")
	return cmd
}

func newProjectSetConfigCommand(ctx *commandContext) *cobra.Command {
	var opts projectSetConfigOptions
	cmd := &cobra.Command{
		Use:   "set-config <id>",
		Short: "Set the per-project config",
		Long: "Update a project's per-project config (branch, project prefix, autonomous merge, env, " +
			"symlinks, post-create, agent model/permissions, role overrides, tracker intake). The config " +
			"is resolved when a session spawns.\n\n" +
			"Set fields via flags to merge them into the stored config, pass the whole object with " +
			"--config-json to replace it, or --clear to reset config to the standard defaults. Repeatable collection " +
			"flags replace that field's stored collection with the values passed in this command.",
		Args: func(cmd *cobra.Command, args []string) error {
			if err := cobra.ExactArgs(1)(cmd, args); err != nil {
				return usageError{err}
			}
			if strings.TrimSpace(args[0]) == "" {
				return usageError{errors.New("usage: project id is required")}
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := guardProductionConfigMutation(opts.allowProductionConfig); err != nil {
				return err
			}
			id := strings.TrimSpace(args[0])
			opts.trackerIntakeSet = cmd.Flags().Changed("tracker-intake")
			opts.autonomousMergeSet = cmd.Flags().Changed("autonomous-merge")
			if opts.configJSON != "" && trackerConfigFlagChanged(cmd) {
				return usageError{errors.New("usage: tracker intake flags cannot be combined with --config-json; include trackerIntake in the JSON object instead")}
			}
			if opts.clear && trackerConfigFlagChanged(cmd) {
				return usageError{errors.New("usage: tracker intake flags cannot be combined with --clear; clear sends an explicit trackerIntake disable sentinel")}
			}
			if err := normalizeProjectPrefixFlags(cmd, &opts); err != nil {
				return err
			}
			config, err := buildProjectConfig(opts)
			if err != nil {
				return err
			}
			// Flag writes are read-modify-writes and carry the token they merged
			// against. --config-json and --clear are deliberate whole-object writes
			// (the config-as-code restore path is built on that), so they send the
			// wildcard precondition instead of claiming a base they never read.
			ifMatch := "*"
			if !opts.clear && opts.configJSON == "" {
				config, ifMatch, err = ctx.mergedProjectConfigFromFlags(cmd, id, config)
				if err != nil {
					return err
				}
			}
			req := setConfigRequest{Config: config}
			if opts.clear {
				req.rawConfig = json.RawMessage(`{"trackerIntake":{"enabled":false}}`)
			} else if opts.configJSON != "" {
				req.rawConfig = json.RawMessage(opts.configJSON)
			} else if opts.trackerIntakeSet && !opts.trackerIntake {
				rawConfig, err := configWithExplicitTrackerIntakeEnabled(config, false)
				if err != nil {
					return err
				}
				req.rawConfig = rawConfig
			}
			var res projectResult
			if err := ctx.putJSONIfMatch(cmd.Context(), "projects/"+url.PathEscape(id)+"/config", ifMatch, req, &res); err != nil {
				return err
			}
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), res)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "updated config for project %s\n", res.Project.ID)
			return err
		},
	}
	f := cmd.Flags()
	f.StringVar(&opts.defaultBranch, "default-branch", "", "Base branch new session worktrees are created from")
	f.StringVar(&opts.projectPrefix, "project-prefix", "", "Short project-wide prefix for names, branches, and worktrees")
	f.StringVar(&opts.legacySessionPrefix, "session-prefix", "", "Deprecated alias for --project-prefix")
	f.BoolVar(&opts.autonomousMerge, "autonomous-merge", false, "Allow this project's workers to autonomously merge after gates pass")
	f.StringVar(&opts.workspace, "workspace", "", "Session workspace mode: worktree (default) or in-place")
	f.StringVar(&opts.model, "model", "", "Agent model override (e.g. claude-opus-4-5)")
	f.StringVar(&opts.permission, "permission", "", "Permission mode: default, accept-edits, auto, bypass-permissions")
	f.StringVar(&opts.workerAgent, "worker-agent", "", "Harness override for worker sessions")
	f.StringVar(&opts.orchestratorAgent, "orchestrator-agent", "", "Harness override for orchestrator sessions")
	f.StringVar(&opts.primeAgent, "prime-agent", "", "Harness override that enables env-gated prime sessions")
	f.StringVar(&opts.workerInstructionsFile, "worker-instructions-file", "", "Path to append to worker system prompts (relative to project root, or absolute)")
	f.StringVar(&opts.orchestratorInstructionsFile, "orchestrator-instructions-file", "", "Path to append to orchestrator system prompts (relative to project root, or absolute)")
	f.StringVar(&opts.primeInstructionsFile, "prime-instructions-file", "", "Path to append to prime system prompts (relative to project root, or absolute)")
	f.StringVar(&opts.primeWakeInterval, "prime-wake-interval", "", "Prime supervision wake interval as a Go duration")
	f.StringArrayVar(&opts.env, "env", nil, "Env var KEY=VALUE forwarded into sessions (repeatable)")
	f.StringArrayVar(&opts.symlink, "symlink", nil, "Repo-relative path to symlink into workspaces (repeatable)")
	f.StringArrayVar(&opts.postCreate, "post-create", nil, "Command to run after workspace creation (repeatable)")
	f.BoolVar(&opts.trackerIntake, "tracker-intake", false, "Enable GitHub issue intake for matching issues")
	f.StringVar(&opts.trackerRepo, "tracker-repo", "", "GitHub repo for issue intake (owner/repo; default: derive from git origin)")
	f.StringVar(&opts.trackerAssignee, "tracker-assignee", "", "Required authorization selector when intake is enabled (* = any assigned issue; none is invalid)")
	f.IntVar(&opts.trackerMaxConcurrent, "tracker-max-concurrent", 0, "Required positive live-worker cap when intake is enabled")
	f.StringVar(&opts.configJSON, "config-json", "", "Full config as a JSON object (overrides field flags)")
	f.BoolVar(&opts.clear, "clear", false, "Reset config to standard defaults")
	f.BoolVar(&opts.json, "json", false, "Output the updated project as JSON")
	f.BoolVar(&opts.allowProductionConfig, "allow-production-config", false, "Operator override: allow this config mutation even when run inside an ao-spawned session")
	cmd.MarkFlagsMutuallyExclusive("clear", "config-json")
	return cmd
}

// mergedProjectConfigFromFlags GETs the current config, applies only the flags the
// caller actually set, and returns the merged config together with the token of the
// config it merged against. The token matters: this is a read-modify-write against a
// whole-object replace endpoint, so without it a config that changed between the GET
// and the PUT is silently overwritten by a base that no longer exists.
func (c *commandContext) mergedProjectConfigFromFlags(cmd *cobra.Command, id string, patch projectConfig) (projectConfig, string, error) {
	var current projectGetResult
	if err := c.getJSON(cmd.Context(), "projects/"+url.PathEscape(id), &current); err != nil {
		return projectConfig{}, "", err
	}
	base := projectConfig{}
	if current.Project.Config != nil {
		base = *current.Project.Config
	}
	applyProjectConfigStandardBaseline(&base)
	applyProjectConfigFlagPatch(&base, patch, cmd)
	return base, current.Project.ConfigETag, nil
}

func applyProjectConfigStandardBaseline(cfg *projectConfig) {
	if cfg.AgentConfig.Permissions == "" {
		cfg.AgentConfig.Permissions = string(domain.PermissionModeBypassPermissions)
	}
	if cfg.Worker.Agent == "" && len(cfg.WorkerMix) == 0 {
		cfg.Worker.Agent = string(domain.HarnessCodex)
	}
	if cfg.Orchestrator.Agent == "" {
		cfg.Orchestrator.Agent = string(domain.HarnessClaudeCode)
	}
}

func normalizeProjectPrefixFlags(cmd *cobra.Command, opts *projectSetConfigOptions) error {
	flags := cmd.Flags()
	projectChanged := flags.Changed("project-prefix")
	legacyChanged := flags.Changed("session-prefix")
	if projectChanged && legacyChanged && opts.projectPrefix != opts.legacySessionPrefix {
		return usageError{errors.New("usage: --project-prefix and --session-prefix disagree; use --project-prefix")}
	}
	if !projectChanged && legacyChanged {
		opts.projectPrefix = opts.legacySessionPrefix
	}
	return nil
}

func applyProjectConfigFlagPatch(base *projectConfig, patch projectConfig, cmd *cobra.Command) {
	flags := cmd.Flags()
	if flags.Changed("default-branch") {
		base.DefaultBranch = patch.DefaultBranch
	}
	if flags.Changed("project-prefix") || flags.Changed("session-prefix") {
		base.ProjectPrefix = patch.ProjectPrefix
		base.SessionPrefix = ""
	}
	if flags.Changed("autonomous-merge") {
		base.AutonomousMerge = patch.AutonomousMerge
	}
	if flags.Changed("workspace") {
		base.Workspace = patch.Workspace
	}
	if flags.Changed("env") {
		base.Env = patch.Env
	}
	if flags.Changed("symlink") {
		base.Symlinks = patch.Symlinks
	}
	if flags.Changed("post-create") {
		base.PostCreate = patch.PostCreate
	}
	if flags.Changed("model") {
		base.AgentConfig.Model = patch.AgentConfig.Model
	}
	if flags.Changed("permission") {
		base.AgentConfig.Permissions = patch.AgentConfig.Permissions
	}
	if flags.Changed("worker-agent") {
		base.Worker.Agent = patch.Worker.Agent
	}
	if flags.Changed("worker-instructions-file") {
		base.Worker.InstructionsFile = patch.Worker.InstructionsFile
	}
	if flags.Changed("orchestrator-agent") {
		base.Orchestrator.Agent = patch.Orchestrator.Agent
	}
	if flags.Changed("orchestrator-instructions-file") {
		base.Orchestrator.InstructionsFile = patch.Orchestrator.InstructionsFile
	}
	if flags.Changed("prime-agent") {
		base.Prime.Agent = patch.Prime.Agent
	}
	if flags.Changed("prime-instructions-file") {
		base.Prime.InstructionsFile = patch.Prime.InstructionsFile
	}
	if flags.Changed("prime-wake-interval") {
		base.Prime.WakeInterval = patch.Prime.WakeInterval
	}
	if !trackerConfigFlagChanged(cmd) {
		return
	}
	if patch.TrackerIntake.Provider != "" {
		base.TrackerIntake.Provider = patch.TrackerIntake.Provider
	}
	if flags.Changed("tracker-intake") {
		base.TrackerIntake.Enabled = patch.TrackerIntake.Enabled
	}
	if flags.Changed("tracker-repo") {
		base.TrackerIntake.Repo = patch.TrackerIntake.Repo
	}
	if flags.Changed("tracker-assignee") {
		base.TrackerIntake.Assignee = patch.TrackerIntake.Assignee
	}
	if flags.Changed("tracker-max-concurrent") {
		base.TrackerIntake.MaxConcurrent = patch.TrackerIntake.MaxConcurrent
	}
}

// buildProjectConfig turns the set-config flags into the typed config sent to
// the daemon. --clear sends an empty config, which the daemon resets to the
// standard defaults; --config-json supplies the whole object; otherwise the field
// flags form a patch that is merged with the stored config before sending the
// request. The daemon validates the values.
func buildProjectConfig(opts projectSetConfigOptions) (projectConfig, error) {
	if opts.clear {
		return projectConfig{}, nil
	}
	if opts.configJSON != "" {
		var cfg projectConfig
		if err := json.Unmarshal([]byte(opts.configJSON), &cfg); err != nil {
			return projectConfig{}, usageError{fmt.Errorf("--config-json is not a valid JSON object: %w", err)}
		}
		return cfg, nil
	}

	env, err := parseEnvPairs(opts.env)
	if err != nil {
		return projectConfig{}, err
	}
	cfg := projectConfig{
		DefaultBranch:   opts.defaultBranch,
		ProjectPrefix:   opts.projectPrefix,
		AutonomousMerge: opts.autonomousMerge,
		Workspace:       opts.workspace,
		Env:             env,
		Symlinks:        opts.symlink,
		PostCreate:      opts.postCreate,
		AgentConfig:     agentConfig{Model: opts.model, Permissions: opts.permission},
		Worker:          roleOverride{Agent: opts.workerAgent, InstructionsFile: opts.workerInstructionsFile},
		Orchestrator:    roleOverride{Agent: opts.orchestratorAgent, InstructionsFile: opts.orchestratorInstructionsFile},
		Prime:           roleOverride{Agent: opts.primeAgent, InstructionsFile: opts.primeInstructionsFile, WakeInterval: opts.primeWakeInterval},
		TrackerIntake: trackerIntakeConfig{
			Enabled:       opts.trackerIntake,
			Provider:      trackerProviderForFlags(opts),
			Repo:          opts.trackerRepo,
			Assignee:      opts.trackerAssignee,
			MaxConcurrent: opts.trackerMaxConcurrent,
		},
	}
	if reflect.DeepEqual(cfg, projectConfig{}) && !opts.autonomousMergeSet {
		return projectConfig{}, usageError{errors.New("usage: provide at least one config flag, --config-json, or --clear")}
	}
	return cfg, nil
}

func trackerConfigFlagChanged(cmd *cobra.Command) bool {
	for _, name := range []string{
		"tracker-intake",
		"tracker-repo",
		"tracker-assignee",
		"tracker-max-concurrent",
	} {
		if cmd.Flags().Changed(name) {
			return true
		}
	}
	return false
}

func configWithExplicitTrackerIntakeEnabled(config projectConfig, enabled bool) (json.RawMessage, error) {
	data, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	var tracker map[string]json.RawMessage
	if trackerRaw, ok := raw["trackerIntake"]; ok {
		if err := json.Unmarshal(trackerRaw, &tracker); err != nil {
			return nil, err
		}
	}
	if tracker == nil {
		tracker = make(map[string]json.RawMessage)
	}
	enabledData, err := json.Marshal(enabled)
	if err != nil {
		return nil, err
	}
	tracker["enabled"] = enabledData
	trackerData, err := json.Marshal(tracker)
	if err != nil {
		return nil, err
	}
	raw["trackerIntake"] = trackerData
	return json.Marshal(raw)
}

func trackerProviderForFlags(opts projectSetConfigOptions) string {
	if opts.trackerIntake || opts.trackerRepo != "" || opts.trackerAssignee != "" || opts.trackerMaxConcurrent != 0 {
		return "github"
	}
	return ""
}

// parseEnvPairs turns repeated KEY=VALUE flags into a map.
func parseEnvPairs(pairs []string) (map[string]string, error) {
	if len(pairs) == 0 {
		return nil, nil
	}
	env := make(map[string]string, len(pairs))
	for _, pair := range pairs {
		key, value, ok := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, usageError{fmt.Errorf("invalid --env %q: expected KEY=VALUE", pair)}
		}
		env[key] = value
	}
	return env, nil
}

func newProjectRemoveCommand(ctx *commandContext) *cobra.Command {
	var opts projectRemoveOptions
	cmd := &cobra.Command{
		Use:     "rm <id>",
		Aliases: []string{"remove", "delete"},
		Short:   "Remove a registered project",
		Args: func(cmd *cobra.Command, args []string) error {
			if err := cobra.ExactArgs(1)(cmd, args); err != nil {
				return usageError{err}
			}
			if strings.TrimSpace(args[0]) == "" {
				return usageError{errors.New("usage: project id is required")}
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			if !opts.yes {
				confirmed, err := confirmProjectRemoval(cmd, id)
				if err != nil {
					return err
				}
				if !confirmed {
					_, err := fmt.Fprintln(cmd.OutOrStdout(), "aborted")
					return err
				}
			}
			var res projectRemoveResult
			if err := ctx.deleteJSON(cmd.Context(), "projects/"+url.PathEscape(id), &res); err != nil {
				return err
			}
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), res)
			}
			removedID := res.ProjectID
			if removedID == "" {
				removedID = res.ID
			}
			if removedID == "" {
				removedID = id
			}
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "removed project %s\n", removedID)
			return err
		},
	}
	cmd.Flags().BoolVarP(&opts.yes, "yes", "y", false, "Skip confirmation prompt")
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output removal result as JSON")
	return cmd
}

func writeProjectList(cmd *cobra.Command, projects []projectSummary) error {
	out := cmd.OutOrStdout()
	if len(projects) == 0 {
		if _, err := fmt.Fprintln(out, "No projects registered."); err != nil {
			return err
		}
		_, err := fmt.Fprintln(out, "Run `ao project add --path <path>` to register one.")
		return err
	}

	tw := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "ID\tNAME\tKIND\tPROJECT PREFIX\tSTATE\tSTATUS"); err != nil {
		return err
	}
	for _, p := range projects {
		status := "ok"
		if p.ResolveError != "" {
			status = "degraded: " + p.ResolveError
		}
		kind := p.Kind
		if kind == "" {
			kind = "single_repo"
		}
		prefix := p.ProjectPrefix
		if prefix == "" {
			prefix = p.SessionPrefix
		}
		if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", p.ID, p.Name, kind, prefix, formatPauseState(p.PauseState, p.DrainingWorkers), status); err != nil {
			return err
		}
	}
	return tw.Flush()
}

// formatPauseState renders the observable pause state for CLI display, showing
// the live worker count while draining. An empty state (older daemon) falls
// back to "running".
func formatPauseState(state string, drainingWorkers int) string {
	switch state {
	case "", "running":
		return "running"
	case "draining":
		return fmt.Sprintf("draining (%d)", drainingWorkers)
	default:
		return state
	}
}

func writeProjectDetails(cmd *cobra.Command, res projectGetResult) error {
	out := cmd.OutOrStdout()
	p := res.Project
	if _, err := fmt.Fprintf(out, "Project %s (%s)\n", p.ID, res.Status); err != nil {
		return err
	}
	fields := []struct {
		label string
		value string
	}{
		{label: "name", value: p.Name},
		{label: "kind", value: p.Kind},
		{label: "path", value: p.Path},
		{label: "repo", value: p.Repo},
		{label: "default branch", value: p.DefaultBranch},
		{label: "agent", value: p.Agent},
		{label: "pause state", value: formatPauseState(p.PauseState, p.DrainingWorkers)},
		{label: "config", value: formatProjectConfig(p.Config)},
		{label: "resolve error", value: p.ResolveError},
	}
	for _, f := range fields {
		if f.value == "" {
			continue
		}
		if _, err := fmt.Fprintf(out, "  %s: %s\n", f.label, f.value); err != nil {
			return err
		}
	}
	if len(p.WorkspaceRepos) > 0 {
		if _, err := fmt.Fprintln(out, "  workspace repos:"); err != nil {
			return err
		}
		for _, repo := range p.WorkspaceRepos {
			desc := repo.RelativePath
			if repo.Repo != "" {
				desc += " (" + repo.Repo + ")"
			}
			if _, err := fmt.Fprintf(out, "    %s: %s\n", repo.Name, desc); err != nil {
				return err
			}
		}
	}
	return nil
}

// formatProjectConfig renders the per-project config as compact JSON for the
// `project get` text view. A nil config returns "" so the row is skipped.
func formatProjectConfig(config *projectConfig) string {
	if config == nil {
		return ""
	}
	data, err := json.Marshal(config)
	if err != nil {
		return ""
	}
	return string(data)
}

func confirmProjectRemoval(cmd *cobra.Command, id string) (bool, error) {
	if _, err := fmt.Fprintf(cmd.OutOrStdout(), "Remove project %q? Type the project id to confirm: ", id); err != nil {
		return false, err
	}
	reader := bufio.NewReader(cmd.InOrStdin())
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return false, err
	}
	return strings.TrimSpace(line) == id, nil
}
