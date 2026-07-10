package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestProjectConfigValidate(t *testing.T) {
	tests := []struct {
		name    string
		cfg     ProjectConfig
		wantErr bool
	}{
		{"empty ok", ProjectConfig{}, false},
		{"good agent config", ProjectConfig{AgentConfig: AgentConfig{Model: "m", Permissions: PermissionModeAuto}}, false},
		{"bad permission", ProjectConfig{AgentConfig: AgentConfig{Permissions: "yolo"}}, true},
		{"good project prefix", ProjectConfig{ProjectPrefix: "ao"}, false},
		{"good legacy session prefix", ProjectConfig{SessionPrefix: "ao"}, false},
		{"project prefix with slash", ProjectConfig{ProjectPrefix: "ao/project"}, true},
		{"project prefix with backslash", ProjectConfig{ProjectPrefix: `ao\project`}, true},
		{"project prefix traversal component", ProjectConfig{ProjectPrefix: ".."}, true},
		{"session prefix with slash", ProjectConfig{SessionPrefix: "ao/project"}, true},
		{"good role override", ProjectConfig{Worker: RoleOverride{Harness: HarnessCodex}}, false},
		{"unknown role harness", ProjectConfig{Orchestrator: RoleOverride{Harness: "nope"}}, true},
		{"bad role agent config", ProjectConfig{Worker: RoleOverride{AgentConfig: AgentConfig{Permissions: "nope"}}}, true},
		{"good worker instructions file", ProjectConfig{Worker: RoleOverride{InstructionsFile: ".claude/worker-policy.md"}}, false},
		{"good absolute orchestrator instructions file", ProjectConfig{Orchestrator: RoleOverride{InstructionsFile: "/etc/ao/orchestrator.md"}}, false},
		{"worker instructions file with whitespace", ProjectConfig{Worker: RoleOverride{InstructionsFile: " .claude/worker-policy.md"}}, true},
		{"orchestrator instructions file escapes root", ProjectConfig{Orchestrator: RoleOverride{InstructionsFile: "../orchestrator.md"}}, true},
		{"worker instructions file embedded parent escape", ProjectConfig{Worker: RoleOverride{InstructionsFile: "a/../../worker.md"}}, true},
		{"good symlinks", ProjectConfig{Symlinks: []string{".env", "configs/dev.toml"}}, false},
		{"symlink absolute path", ProjectConfig{Symlinks: []string{"/etc/passwd"}}, true},
		{"symlink parent escape", ProjectConfig{Symlinks: []string{"../escape"}}, true},
		{"symlink embedded parent", ProjectConfig{Symlinks: []string{"a/../../b"}}, true},
		{"symlink bare ..", ProjectConfig{Symlinks: []string{".."}}, true},
		{"good reviewers", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerClaudeCode}}}, false},
		{"good codex reviewer", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerCodex}}}, false},
		{"good opencode reviewer", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerOpenCode}}}, false},
		{"unknown reviewer harness", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: "nope"}}}, true},
		{"worker-only harness is not auto a reviewer", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerHarness(HarnessAider)}}}, true},
		{"empty reviewer harness", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ""}}}, true},
		{"good worker mix", ProjectConfig{WorkerMix: WorkerMix{{Harness: HarnessCodex, Weight: 70}, {Harness: HarnessClaudeCode, Weight: 30}}}, false},
		{"worker mix bad sum", ProjectConfig{WorkerMix: WorkerMix{{Harness: HarnessCodex, Weight: 70}, {Harness: HarnessClaudeCode, Weight: 20}}}, true},
		{"tracker intake assignee rule", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice"}}, false},
		{"tracker intake explicit github", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderGitHub, Assignee: "alice"}}, false},
		{"tracker intake no assignee (opt-out-by-default)", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true}}, false},
		{"tracker intake unknown provider", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: "linear", Assignee: "alice"}}, true},
		{"tracker intake repo with whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Repo: " acme/demo", Assignee: "alice"}}, true},
		{"tracker intake assignee with whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: " alice"}}, true},
		{"tracker intake good labels", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice", Labels: []string{"agent-ok"}, ExcludeLabels: []string{"agent:noauto"}}}, false},
		{"tracker intake label with whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice", Labels: []string{" agent-ok"}}}, true},
		{"tracker intake empty label", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice", Labels: []string{""}}}, true},
		{"tracker intake exclude label with whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice", ExcludeLabels: []string{"agent:noauto "}}}, true},
		{"tracker intake good max concurrent", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 4}}, false},
		{"tracker intake negative max concurrent", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: -1}}, true},
		{"good top-level workspace worktree", ProjectConfig{Workspace: WorkspaceModeWorktree}, false},
		{"good top-level workspace in-place", ProjectConfig{Workspace: WorkspaceModeInPlace}, false},
		{"unknown top-level workspace", ProjectConfig{Workspace: "cloud"}, true},
		{"good worker workspace override", ProjectConfig{Worker: RoleOverride{Workspace: WorkspaceModeInPlace}}, false},
		{"unknown worker workspace override", ProjectConfig{Worker: RoleOverride{Workspace: "cloud"}}, true},
		{"unknown orchestrator workspace override", ProjectConfig{Orchestrator: RoleOverride{Workspace: "nope"}}, true},
		{"good orchestrator wake interval", ProjectConfig{Orchestrator: RoleOverride{WakeInterval: "15m"}}, false},
		{"negative orchestrator wake interval", ProjectConfig{Orchestrator: RoleOverride{WakeInterval: "-1m"}}, true},
		{"zero orchestrator wake interval", ProjectConfig{Orchestrator: RoleOverride{WakeInterval: "0s"}}, true},
		{"invalid orchestrator wake interval", ProjectConfig{Orchestrator: RoleOverride{WakeInterval: "soon"}}, true},
		{"worker wake interval unsupported", ProjectConfig{Worker: RoleOverride{WakeInterval: "15m"}}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.cfg.Validate(); (err != nil) != tt.wantErr {
				t.Fatalf("Validate() err = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}

func TestDefaultProjectConfig(t *testing.T) {
	def := DefaultProjectConfig()

	// The one documented non-empty default.
	if def.DefaultBranch != "main" {
		t.Fatalf("default DefaultBranch = %q, want main", def.DefaultBranch)
	}

	// Every other field defaults to its zero value: clearing the documented
	// default must leave the config completely empty.
	def.DefaultBranch = ""
	if !def.IsZero() {
		t.Fatalf("default config has unexpected non-zero fields: %#v", def)
	}
}

func TestProjectConfigWithDefaults(t *testing.T) {
	// An unset config gets the documented defaults.
	got := (ProjectConfig{}).WithDefaults()
	if got.DefaultBranch != DefaultBranchName {
		t.Fatalf("WithDefaults = %#v, want branch=main", got)
	}

	// Set fields are preserved, not overwritten.
	got = (ProjectConfig{
		DefaultBranch: "develop",
		AgentConfig:   AgentConfig{Model: "m"},
	}).WithDefaults()
	if got.DefaultBranch != "develop" {
		t.Fatalf("WithDefaults overwrote set fields: %#v", got)
	}
	if got.AgentConfig.Model != "m" {
		t.Fatalf("WithDefaults dropped a set field: %#v", got.AgentConfig)
	}

	got = (ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice"}}).WithDefaults()
	if got.TrackerIntake.Provider != TrackerProviderGitHub {
		t.Fatalf("TrackerIntake.Provider = %q, want %q", got.TrackerIntake.Provider, TrackerProviderGitHub)
	}

	got = (ProjectConfig{}).WithDefaults()
	if got.TrackerIntake.Provider != "" {
		t.Fatalf("disabled TrackerIntake.Provider = %q, want empty", got.TrackerIntake.Provider)
	}

	got = (ProjectConfig{}).WithDefaults()
	if got.Orchestrator.WakeInterval != "15m" {
		t.Fatalf("default orchestrator wake interval = %s, want 15m", got.Orchestrator.WakeInterval)
	}
	got = (ProjectConfig{Orchestrator: RoleOverride{WakeInterval: "30m"}}).WithDefaults()
	if got.Orchestrator.WakeInterval != "30m" {
		t.Fatalf("explicit orchestrator wake interval = %s, want 30m", got.Orchestrator.WakeInterval)
	}
	if d, err := got.Orchestrator.WakeIntervalDuration(); err != nil || d != 30*time.Minute {
		t.Fatalf("parsed orchestrator wake interval = %s, %v; want 30m", d, err)
	}
}

func TestProjectConfigProjectPrefixAlias(t *testing.T) {
	var legacy ProjectConfig
	if err := json.Unmarshal([]byte(`{"sessionPrefix":"legacy"}`), &legacy); err != nil {
		t.Fatalf("unmarshal legacy sessionPrefix: %v", err)
	}
	if got := legacy.EffectiveProjectPrefix(); got != "legacy" {
		t.Fatalf("legacy EffectiveProjectPrefix = %q, want legacy", got)
	}

	var canonical ProjectConfig
	if err := json.Unmarshal([]byte(`{"projectPrefix":"canon","sessionPrefix":"legacy"}`), &canonical); err != nil {
		t.Fatalf("unmarshal projectPrefix: %v", err)
	}
	if got := canonical.EffectiveProjectPrefix(); got != "canon" {
		t.Fatalf("canonical EffectiveProjectPrefix = %q, want canon", got)
	}

	normalized := legacy.Normalized()
	if normalized.ProjectPrefix != "legacy" || normalized.SessionPrefix != "" {
		t.Fatalf("normalized legacy prefix = %#v, want projectPrefix only", normalized)
	}
	blob, err := json.Marshal(normalized)
	if err != nil {
		t.Fatalf("marshal normalized: %v", err)
	}
	if got := string(blob); !strings.Contains(got, `"projectPrefix":"legacy"`) || strings.Contains(got, `"sessionPrefix"`) {
		t.Fatalf("normalized JSON = %s, want projectPrefix without sessionPrefix", got)
	}
}

func TestResolveReviewerHarness(t *testing.T) {
	// A configured reviewer always wins, regardless of the worker harness.
	cfg := ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerClaudeCode}}}
	if got := cfg.ResolveReviewerHarness(HarnessAider); got != ReviewerClaudeCode {
		t.Fatalf("configured reviewer = %q, want claude-code", got)
	}

	// No reviewer configured: always use claude-code, regardless of the worker
	// harness (see #2241).
	if got := (ProjectConfig{}).ResolveReviewerHarness(HarnessClaudeCode); got != ReviewerClaudeCode {
		t.Fatalf("default = %q, want reviewer claude-code", got)
	}
	if got := (ProjectConfig{}).ResolveReviewerHarness(HarnessCodex); got != ReviewerClaudeCode {
		t.Fatalf("default = %q, want reviewer claude-code", got)
	}
	if got := (ProjectConfig{}).ResolveReviewerHarness(HarnessOpenCode); got != ReviewerClaudeCode {
		t.Fatalf("default = %q, want reviewer claude-code", got)
	}

	// A worker harness that is not claude-code also falls back to claude-code.
	if got := (ProjectConfig{}).ResolveReviewerHarness(HarnessAider); got != FallbackReviewerHarness {
		t.Fatalf("fallback = %q, want %q", got, FallbackReviewerHarness)
	}
}

func TestProjectConfigIsZero(t *testing.T) {
	if !(ProjectConfig{}).IsZero() {
		t.Fatal("empty config should be zero")
	}
	if (ProjectConfig{DefaultBranch: "main"}).IsZero() {
		t.Fatal("populated config should not be zero")
	}
	if (ProjectConfig{Env: map[string]string{"A": "b"}}).IsZero() {
		t.Fatal("config with env should not be zero")
	}
	// A config that sets no workspace mode is still zero: the default lives in
	// ResolveWorkspaceMode, not in the stored config, so SQL-NULL persistence and
	// IsZero() semantics are preserved.
	if !(ProjectConfig{Workspace: ""}).IsZero() {
		t.Fatal("config with empty workspace mode should be zero")
	}
	if (ProjectConfig{Workspace: WorkspaceModeInPlace}).IsZero() {
		t.Fatal("config with an explicit workspace mode should not be zero")
	}
}

func TestWorkspaceModeIsKnown(t *testing.T) {
	if !WorkspaceModeWorktree.IsKnown() {
		t.Fatal("worktree must be known")
	}
	if !WorkspaceModeInPlace.IsKnown() {
		t.Fatal("in-place must be known")
	}
	// The zero value is deliberately NOT known: resolution treats it as "unset"
	// and falls through to the default rather than as an explicit selection.
	if WorkspaceMode("").IsKnown() {
		t.Fatal("empty mode must not be known")
	}
	if WorkspaceMode("cloud").IsKnown() {
		t.Fatal("unknown mode must not be known")
	}
}

func TestResolveWorkspaceMode(t *testing.T) {
	// No config at all: both kinds resolve to the worktree default, never "".
	for _, kind := range []SessionKind{KindWorker, KindOrchestrator} {
		if got := (ProjectConfig{}).ResolveWorkspaceMode(kind); got != WorkspaceModeWorktree {
			t.Fatalf("default for %s = %q, want worktree", kind, got)
		}
	}

	// Top-level default applies to both kinds when no role override is set.
	cfg := ProjectConfig{Workspace: WorkspaceModeInPlace}
	if got := cfg.ResolveWorkspaceMode(KindWorker); got != WorkspaceModeInPlace {
		t.Fatalf("worker top-level = %q, want in-place", got)
	}
	if got := cfg.ResolveWorkspaceMode(KindOrchestrator); got != WorkspaceModeInPlace {
		t.Fatalf("orchestrator top-level = %q, want in-place", got)
	}

	// The role override wins over the top-level default, per kind.
	cfg = ProjectConfig{
		Workspace:    WorkspaceModeInPlace,
		Worker:       RoleOverride{Workspace: WorkspaceModeWorktree},
		Orchestrator: RoleOverride{Workspace: WorkspaceModeInPlace},
	}
	if got := cfg.ResolveWorkspaceMode(KindWorker); got != WorkspaceModeWorktree {
		t.Fatalf("worker override = %q, want worktree", got)
	}
	if got := cfg.ResolveWorkspaceMode(KindOrchestrator); got != WorkspaceModeInPlace {
		t.Fatalf("orchestrator override = %q, want in-place", got)
	}

	// An empty role override defers to the top-level value, not the built-in
	// default, so one role can override while the other inherits.
	cfg = ProjectConfig{
		Workspace:    WorkspaceModeInPlace,
		Orchestrator: RoleOverride{Workspace: WorkspaceModeWorktree},
	}
	if got := cfg.ResolveWorkspaceMode(KindWorker); got != WorkspaceModeInPlace {
		t.Fatalf("worker inherits top-level = %q, want in-place", got)
	}
	if got := cfg.ResolveWorkspaceMode(KindOrchestrator); got != WorkspaceModeWorktree {
		t.Fatalf("orchestrator override = %q, want worktree", got)
	}
}

func TestProjectConfigWorkspaceJSONRoundTrip(t *testing.T) {
	// A config that sets no workspace mode must not emit the field (omitempty on a
	// string), at the top level or inside either role override, so a minimal blob
	// stays minimal. (The role-override objects themselves always appear — Go's
	// omitempty does not elide a zero struct — but their "workspace" key must not.)
	blob, err := json.Marshal(ProjectConfig{DefaultBranch: "main"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got := string(blob); strings.Contains(got, `"workspace"`) {
		t.Fatalf("marshaled config unexpectedly carries a workspace key: %s", got)
	}

	// A config that sets the fields round-trips them at both the top level and on
	// a role override.
	in := ProjectConfig{
		Workspace: WorkspaceModeInPlace,
		Worker:    RoleOverride{Workspace: WorkspaceModeWorktree},
	}
	blob, err = json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out ProjectConfig
	if err := json.Unmarshal(blob, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Workspace != WorkspaceModeInPlace {
		t.Fatalf("round-trip top-level = %q, want in-place", out.Workspace)
	}
	if out.Worker.Workspace != WorkspaceModeWorktree {
		t.Fatalf("round-trip worker override = %q, want worktree", out.Worker.Workspace)
	}
}
