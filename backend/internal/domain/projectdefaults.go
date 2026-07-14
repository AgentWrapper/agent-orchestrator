package domain

import "strings"

// DefaultCodexModel is the model a codex role is pinned to when a project
// configures none. It is canonical — confirmed against the codex CLI's own model
// list, where it is one of the seven models the binary actually accepts. AO's
// legacy hardcoded candidate list offered three "*-codex" names that do not
// exist at all, one of which 400s on this account.
const DefaultCodexModel = "gpt-5.5"

// DefaultProjectWorkspaceMode is the workspace mode a new project is born with.
//
// It is deliberately in-place, even though ResolveWorkspaceMode's built-in
// fallback is worktree. In worktree mode the session cwd is an AO-managed
// worktree, and an agent following the standard worktree recipe creates its own
// worktree *inside* it. AO's teardown then removes the AO worktree without
// noticing the inner one — on a host whose git excludes hide it, the dirty probe
// reports clean, the remove succeeds, and the agent's uncommitted work is
// silently deleted. Until that teardown path handles inner worktrees, a project
// that configures nothing must not be steered into the mode that can lose work.
const DefaultProjectWorkspaceMode = WorkspaceModeInPlace

// WithStandardDefaults fills the settings a project needs to be born runnable,
// leaving every value the operator actually chose untouched.
//
// These defaults used to live in the React app, so a project created through the
// UI got a permission mode and a model pin and ran, while one created by
// `ao project add` or the raw API was born with an empty config and deadlocked at
// spawn. Putting them in the daemon makes every creation path — UI, CLI, API —
// produce the same runnable project.
//
// Models are pinned PER HARNESS, never as a scalar: a model name is only
// meaningful relative to a harness, and a scalar model paired with an
// incompatible harness saves clean, reads back as set, and is silently dropped at
// spawn. Each role's model default therefore keys off the harness that role
// actually resolves to, so a role the operator pointed at a different harness
// never acquires a foreign model.
func (c ProjectConfig) WithStandardDefaults() ProjectConfig {
	return c.WithStandardDefaultsFor(HarnessCodex)
}

// WithStandardDefaultsFor is WithStandardDefaults with the daemon's configured
// default worker harness supplied by the service layer. The domain-level default
// remains codex, but a daemon launched with AO_AGENT still gets the worker
// harness it was explicitly configured to use.
func (c ProjectConfig) WithStandardDefaultsFor(defaultWorker AgentHarness) ProjectConfig {
	c = c.Normalized()
	if !defaultWorker.IsKnown() {
		defaultWorker = HarnessCodex
	}

	if c.DefaultBranch == "" {
		c.DefaultBranch = DefaultBranchName
	}
	if !c.Workspace.IsKnown() {
		c.Workspace = DefaultProjectWorkspaceMode
	}
	if c.AgentConfig.Permissions == "" {
		c.AgentConfig.Permissions = PermissionModeBypassPermissions
	}

	// A worker mix already resolves the harness, and stamping Worker.Harness on
	// top of one would assert a harness the mix may never select.
	if c.Worker.Harness == "" && len(c.WorkerMix) == 0 {
		c.Worker.Harness = defaultWorker
	}
	if c.Orchestrator.Harness == "" {
		c.Orchestrator.Harness = HarnessClaudeCode
	}

	c.Worker.AgentConfig = withDefaultModelFor(c.Worker.AgentConfig, c.Worker.Harness, c.AgentConfig.Model)
	c.Orchestrator.AgentConfig = withDefaultModelFor(c.Orchestrator.AgentConfig, c.Orchestrator.Harness, c.AgentConfig.Model)

	return c
}

// withDefaultModelFor pins the standard model for exactly the harness the role
// resolves to, and only when that harness has a standard model and the role has
// not already pinned one.
func withDefaultModelFor(ac AgentConfig, harness AgentHarness, baseModel string) AgentConfig {
	model := standardModelFor(harness)
	if model == "" {
		return ac
	}
	if scalarModelAppliesToHarness(ac.Model, harness) || scalarModelAppliesToHarness(baseModel, harness) {
		return ac
	}
	if _, pinned := ac.ModelByHarness[harness]; pinned {
		return ac
	}
	if ac.ModelByHarness == nil {
		ac.ModelByHarness = map[AgentHarness]HarnessModel{}
	} else {
		pins := make(map[AgentHarness]HarnessModel, len(ac.ModelByHarness)+1)
		for h, m := range ac.ModelByHarness {
			pins[h] = m
		}
		ac.ModelByHarness = pins
	}
	ac.ModelByHarness[harness] = HarnessModel{Model: model}
	return ac
}

func scalarModelAppliesToHarness(model string, harness AgentHarness) bool {
	model = strings.TrimSpace(model)
	if model == "" {
		return false
	}
	return ClassifyModelProvider(model).CompatibleWith(harness.ModelProvider())
}

// standardModelFor is the project-default model per harness. It is distinct from
// DefaultModelForHarness, which is the spawn-time substitution applied when a
// resolved spawn has no model at all; this one seeds a NEW project's config so
// the pin is visible and editable rather than implicit.
func standardModelFor(h AgentHarness) string {
	switch h {
	case HarnessClaudeCode:
		return DefaultClaudeCodeModel
	case HarnessCodex:
		return DefaultCodexModel
	default:
		// codex-fugu and every unmapped harness keep their own CLI default. Pinning
		// a model we have not confirmed the harness accepts would reintroduce the
		// unvalidated-magic-word class this ticket exists to kill.
		return ""
	}
}
