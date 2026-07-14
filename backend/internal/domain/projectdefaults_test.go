package domain_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// The standard defaults (issue #298, decision D3 / AC1). The defaults used to
// live in the React app (NEW_PROJECT_DEFAULTS), so a project created through the
// UI was runnable and one created by `ao project add` or the raw API was born
// with an empty config and deadlocked. They belong in the daemon.

func TestStandardDefaultsAreSpawnable(t *testing.T) {
	t.Parallel()

	// The whole point: a project that configures NOTHING must be born runnable.
	cfg := domain.ProjectConfig{}.WithStandardDefaults()
	if err := cfg.ValidateSpawnable(); err != nil {
		t.Fatalf("a project born with the standard defaults must be spawnable, got %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("the standard defaults must themselves be valid, got %v", err)
	}
}

func TestProjectConfigIsZeroCoversEveryField(t *testing.T) {
	t.Parallel()

	projectConfigType := reflect.TypeOf(domain.ProjectConfig{})
	cases := map[string]domain.ProjectConfig{
		"DefaultBranch":   {DefaultBranch: "main"},
		"ProjectPrefix":   {ProjectPrefix: "ao"},
		"SessionPrefix":   {SessionPrefix: "ao"},
		"Workspace":       {Workspace: domain.WorkspaceModeInPlace},
		"Env":             {Env: map[string]string{"A": "1"}},
		"Symlinks":        {Symlinks: []string{".env"}},
		"PostCreate":      {PostCreate: []string{"npm install"}},
		"AgentConfig":     {AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeBypassPermissions}},
		"Worker":          {Worker: domain.RoleOverride{Harness: domain.HarnessCodex}},
		"Orchestrator":    {Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode}},
		"Prime":           {Prime: domain.RoleOverride{Harness: domain.HarnessClaudeCode}},
		"WorkerMix":       {WorkerMix: domain.WorkerMix{{Harness: domain.HarnessCodex, Weight: 100}}},
		"Reviewers":       {Reviewers: []domain.ReviewerConfig{{Harness: domain.ReviewerClaudeCode}}},
		"TrackerIntake":   {TrackerIntake: domain.TrackerIntakeConfig{Enabled: true}},
		"AutonomousMerge": {AutonomousMerge: true},
	}
	if len(cases) != projectConfigType.NumField() {
		t.Fatalf("ProjectConfig field coverage = %d cases, want %d fields", len(cases), projectConfigType.NumField())
	}
	for i := 0; i < projectConfigType.NumField(); i++ {
		name := projectConfigType.Field(i).Name
		cfg, ok := cases[name]
		if !ok {
			t.Fatalf("ProjectConfig.IsZero test does not cover field %s", name)
		}
		if cfg.IsZero() {
			t.Fatalf("ProjectConfig with only %s set reports IsZero", name)
		}
	}
}

func TestNestedConfigIsZeroChecksCoverEveryField(t *testing.T) {
	t.Parallel()

	agentConfigType := reflect.TypeOf(domain.AgentConfig{})
	agentCases := map[string]domain.AgentConfig{
		"Model":          {Model: "gpt-5.5"},
		"Effort":         {Effort: domain.EffortHigh},
		"Permissions":    {Permissions: domain.PermissionModeBypassPermissions},
		"ModelByHarness": {ModelByHarness: map[domain.AgentHarness]domain.HarnessModel{domain.HarnessCodex: {Model: "gpt-5.5"}}},
	}
	if len(agentCases) != agentConfigType.NumField() {
		t.Fatalf("AgentConfig field coverage = %d cases, want %d fields", len(agentCases), agentConfigType.NumField())
	}
	for i := 0; i < agentConfigType.NumField(); i++ {
		name := agentConfigType.Field(i).Name
		cfg, ok := agentCases[name]
		if !ok {
			t.Fatalf("AgentConfig.IsZero test does not cover field %s", name)
		}
		if cfg.IsZero() {
			t.Fatalf("AgentConfig with only %s set reports IsZero", name)
		}
	}

	roleOverrideType := reflect.TypeOf(domain.RoleOverride{})
	roleCases := map[string]domain.RoleOverride{
		"Harness":          {Harness: domain.HarnessCodex},
		"AgentConfig":      {AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeBypassPermissions}},
		"Workspace":        {Workspace: domain.WorkspaceModeInPlace},
		"InstructionsFile": {InstructionsFile: ".claude/instructions.md"},
		"WakeInterval":     {WakeInterval: "30m"},
		"WakeBackoff":      {WakeBackoff: &domain.WakeBackoffConfig{Base: "15m", Max: "1h"}},
	}
	if len(roleCases) != roleOverrideType.NumField() {
		t.Fatalf("RoleOverride field coverage = %d cases, want %d fields", len(roleCases), roleOverrideType.NumField())
	}
	for i := 0; i < roleOverrideType.NumField(); i++ {
		name := roleOverrideType.Field(i).Name
		role, ok := roleCases[name]
		if !ok {
			t.Fatalf("RoleOverride.IsZero test does not cover field %s", name)
		}
		if role.IsZero() {
			t.Fatalf("RoleOverride with only %s set reports IsZero", name)
		}
		if (domain.ProjectConfig{Worker: role}).IsZero() {
			t.Fatalf("ProjectConfig with only Worker.%s set reports IsZero", name)
		}
	}

	trackerIntakeType := reflect.TypeOf(domain.TrackerIntakeConfig{})
	trackerCases := map[string]domain.TrackerIntakeConfig{
		"Enabled":       {Enabled: true},
		"Provider":      {Provider: domain.TrackerProviderGitHub},
		"Repo":          {Repo: "acme/demo"},
		"Assignee":      {Assignee: "*"},
		"Labels":        {Labels: []string{"agent-ok"}},
		"ExcludeLabels": {ExcludeLabels: []string{"no-ao"}},
		"MaxConcurrent": {MaxConcurrent: 1},
		"Respawn":       {Respawn: &domain.TrackerRespawnPolicy{}},
	}
	if len(trackerCases) != trackerIntakeType.NumField() {
		t.Fatalf("TrackerIntakeConfig field coverage = %d cases, want %d fields", len(trackerCases), trackerIntakeType.NumField())
	}
	for i := 0; i < trackerIntakeType.NumField(); i++ {
		name := trackerIntakeType.Field(i).Name
		intake, ok := trackerCases[name]
		if !ok {
			t.Fatalf("trackerIntakeIsZero test does not cover field %s", name)
		}
		if (domain.ProjectConfig{TrackerIntake: intake}).IsZero() {
			t.Fatalf("ProjectConfig with only TrackerIntake.%s set reports IsZero", name)
		}
	}
}

func TestCommittedProjectConfigSpecsPassTheWriteGate(t *testing.T) {
	t.Parallel()

	root := repoRootFromDomainPackage(t)
	entries, err := os.ReadDir(filepath.Join(root, "ops", "project-config"))
	if err != nil {
		t.Fatalf("read project config specs: %v", err)
	}
	seen := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		seen++
		path := filepath.Join(root, "ops", "project-config", entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		var cfg domain.ProjectConfig
		if err := json.Unmarshal(data, &cfg); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		if err := cfg.Validate(); err != nil {
			t.Fatalf("%s fails ProjectConfig.Validate: %v", entry.Name(), err)
		}
		if err := cfg.ValidateSpawnable(); err != nil {
			t.Fatalf("%s fails ProjectConfig.ValidateSpawnable: %v", entry.Name(), err)
		}
	}
	if seen == 0 {
		t.Fatal("no committed project config specs found")
	}
}

func repoRootFromDomainPackage(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "ops", "project-config")); err != nil {
		t.Fatalf("resolved repo root %s is wrong: %v", root, err)
	}
	return root
}

func TestStandardDefaultsMatchTheOperatorBaseline(t *testing.T) {
	t.Parallel()

	cfg := domain.ProjectConfig{}.WithStandardDefaults()

	if got := cfg.AgentConfig.Permissions; got != domain.PermissionModeBypassPermissions {
		t.Errorf("permissions = %q, want bypass-permissions (a project must be runnable unattended)", got)
	}
	if got := cfg.Worker.Harness; got != domain.HarnessCodex {
		t.Errorf("worker.agent = %q, want codex", got)
	}
	if got := cfg.Orchestrator.Harness; got != domain.HarnessClaudeCode {
		t.Errorf("orchestrator.agent = %q, want claude-code", got)
	}
	// Workspace stays in-place until the worktree teardown fix lands (D5). The
	// CODE default is worktree, which is the mode that silently deletes an
	// agent's inner worktree on teardown — a new project must not take it.
	if got := cfg.Workspace; got != domain.WorkspaceModeInPlace {
		t.Errorf("workspace = %q, want in-place", got)
	}
	if got := cfg.DefaultBranch; got != domain.DefaultBranchName {
		t.Errorf("defaultBranch = %q, want %q", got, domain.DefaultBranchName)
	}
}

// Models are pinned PER HARNESS, never as a naked scalar. A model name is only
// meaningful relative to a harness: a scalar model attached to an incompatible
// harness saves clean, displays back as set, and is silently dropped at spawn.
func TestStandardDefaultsPinModelsPerHarnessNotAsAScalar(t *testing.T) {
	t.Parallel()

	cfg := domain.ProjectConfig{}.WithStandardDefaults()

	if cfg.AgentConfig.Model != "" || cfg.Worker.AgentConfig.Model != "" || cfg.Orchestrator.AgentConfig.Model != "" {
		t.Fatal("the defaults must not write a scalar model: it is the representation that silently drops")
	}

	worker, ok := cfg.Worker.AgentConfig.ModelByHarness[domain.HarnessCodex]
	if !ok {
		t.Fatal("worker must pin a model for its own harness (codex)")
	}
	if worker.Model != domain.DefaultCodexModel {
		t.Errorf("worker codex model = %q, want %q", worker.Model, domain.DefaultCodexModel)
	}

	orch, ok := cfg.Orchestrator.AgentConfig.ModelByHarness[domain.HarnessClaudeCode]
	if !ok {
		t.Fatal("orchestrator must pin a model for its own harness (claude-code)")
	}
	if orch.Model != domain.DefaultClaudeCodeModel {
		t.Errorf("orchestrator claude-code model = %q, want %q", orch.Model, domain.DefaultClaudeCodeModel)
	}
}

// Defaults fill; they never overwrite. An operator who has chosen a value keeps it.
func TestStandardDefaultsNeverOverwriteAConfiguredValue(t *testing.T) {
	t.Parallel()

	configured := domain.ProjectConfig{
		DefaultBranch: "trunk",
		Workspace:     domain.WorkspaceModeWorktree,
		AgentConfig:   domain.AgentConfig{Permissions: domain.PermissionModeAcceptEdits},
		Worker:        domain.RoleOverride{Harness: domain.HarnessCodexFugu},
		Orchestrator:  domain.RoleOverride{Harness: domain.HarnessCodex},
	}
	got := configured.WithStandardDefaults()

	if got.DefaultBranch != "trunk" {
		t.Errorf("defaultBranch = %q, want the configured %q", got.DefaultBranch, "trunk")
	}
	if got.Workspace != domain.WorkspaceModeWorktree {
		t.Errorf("workspace = %q, want the configured worktree", got.Workspace)
	}
	if got.AgentConfig.Permissions != domain.PermissionModeAcceptEdits {
		t.Errorf("permissions = %q, want the configured accept-edits", got.AgentConfig.Permissions)
	}
	if got.Worker.Harness != domain.HarnessCodexFugu {
		t.Errorf("worker.agent = %q, want the configured codex-fugu", got.Worker.Harness)
	}
	// And it must NOT pin a codex model onto a codex-fugu worker: the model
	// defaults key off the harness the role actually resolves to.
	if _, ok := got.Worker.AgentConfig.ModelByHarness[domain.HarnessCodex]; ok {
		t.Error("must not pin a codex model on a worker whose harness is codex-fugu")
	}

	projectModel := domain.ProjectConfig{
		AgentConfig:  domain.AgentConfig{Model: "sonnet", Permissions: domain.PermissionModeBypassPermissions},
		Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		Worker:       domain.RoleOverride{Harness: domain.HarnessCodex},
	}.WithStandardDefaults()
	if _, ok := projectModel.Orchestrator.AgentConfig.ModelByHarness[domain.HarnessClaudeCode]; ok {
		t.Fatal("must not pin a default claude-code model over a compatible project-level scalar model")
	}

	roleModel := domain.ProjectConfig{
		AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeBypassPermissions},
		Worker: domain.RoleOverride{
			Harness:     domain.HarnessCodex,
			AgentConfig: domain.AgentConfig{Model: "gpt-5"},
		},
		Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}.WithStandardDefaults()
	if _, ok := roleModel.Worker.AgentConfig.ModelByHarness[domain.HarnessCodex]; ok {
		t.Fatal("must not pin a default codex model over a compatible role scalar model")
	}
}

// A WorkerMix already supplies the worker harness, so the default must not
// stamp a Worker.Harness that contradicts the mix.
func TestStandardDefaultsDoNotOverrideAWorkerMix(t *testing.T) {
	t.Parallel()

	cfg := domain.ProjectConfig{
		WorkerMix: domain.WorkerMix{
			{Harness: domain.HarnessCodexFugu, Weight: 100},
		},
	}.WithStandardDefaults()

	if cfg.Worker.Harness != "" {
		t.Errorf("worker.agent = %q, want empty: the mix already resolves the harness", cfg.Worker.Harness)
	}
	if err := cfg.ValidateSpawnable(); err != nil {
		t.Fatalf("a mix-configured project must still be spawnable after defaults, got %v", err)
	}
}
