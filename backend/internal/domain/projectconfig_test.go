package domain

import "testing"

func TestProjectConfigValidate(t *testing.T) {
	tests := []struct {
		name    string
		cfg     ProjectConfig
		wantErr bool
	}{
		{"empty ok", ProjectConfig{}, false},
		{"good agent config", ProjectConfig{AgentConfig: AgentConfig{Model: "m", Permissions: PermissionModeAuto}}, false},
		{"bad permission", ProjectConfig{AgentConfig: AgentConfig{Permissions: "yolo"}}, true},
		{"good session prefix", ProjectConfig{SessionPrefix: "ao"}, false},
		{"session prefix with slash", ProjectConfig{SessionPrefix: "ao/project"}, true},
		{"session prefix with backslash", ProjectConfig{SessionPrefix: `ao\project`}, true},
		{"session prefix traversal component", ProjectConfig{SessionPrefix: ".."}, true},
		{"good role override", ProjectConfig{Worker: RoleOverride{Harness: HarnessCodex}}, false},
		{"unknown role harness", ProjectConfig{Orchestrator: RoleOverride{Harness: "nope"}}, true},
		{"bad role agent config", ProjectConfig{Worker: RoleOverride{AgentConfig: AgentConfig{Permissions: "nope"}}}, true},
		{"good symlinks", ProjectConfig{Symlinks: []string{".env", "configs/dev.toml"}}, false},
		{"symlink absolute path", ProjectConfig{Symlinks: []string{"/etc/passwd"}}, true},
		{"symlink parent escape", ProjectConfig{Symlinks: []string{"../escape"}}, true},
		{"symlink embedded parent", ProjectConfig{Symlinks: []string{"a/../../b"}}, true},
		{"symlink bare ..", ProjectConfig{Symlinks: []string{".."}}, true},
		{"good prompt rules", ProjectConfig{AgentRules: "Run tests.", AgentRulesFile: "docs/agent-rules.md", OrchestratorRules: "Delegate work."}, false},
		{"agent rules file absolute path", ProjectConfig{AgentRulesFile: "/etc/passwd"}, true},
		{"agent rules file parent escape", ProjectConfig{AgentRulesFile: "../rules.md"}, true},
		{"agent rules file cleans to dot", ProjectConfig{AgentRulesFile: "docs/.."}, true},
		{"agent rules file bare dot", ProjectConfig{AgentRulesFile: "."}, true},
		{"good reviewers", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerClaudeCode}}}, false},
		{"good codex reviewer", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerCodex}}}, false},
		{"good opencode reviewer", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerOpenCode}}}, false},
		{"unknown reviewer harness", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: "nope"}}}, true},
		{"worker-only harness is not auto a reviewer", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerHarness(HarnessAider)}}}, true},
		{"empty reviewer harness", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ""}}}, true},
		{"tracker intake assignee rule", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice"}}, false},
		{"tracker intake explicit github", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderGitHub, Assignee: "alice"}}, false},
		{"github scm defaults", ProjectConfig{SCM: SCMProjectConfig{}}, false},
		{"explicit gitlab scm", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: "gitlab-dzr", Repo: "group/subgroup/project"}}, false},
		{"gitlab repo with dot git suffix", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: "gitlab-dzr", Repo: "group/subgroup/project.git"}}, false},
		{"unknown scm provider", ProjectConfig{SCM: SCMProjectConfig{Provider: "bitbucket", ConnectionID: "bitbucket-default"}}, true},
		{"gitlab scm requires connection", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab}}, true},
		{"connection id with slash", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: "gitlab/team"}}, true},
		{"connection id with whitespace", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: " gitlab-dzr"}}, true},
		{"github repo has exactly two segments", ProjectConfig{SCM: SCMProjectConfig{Repo: "owner/subgroup/repo"}}, true},
		{"gitlab repo allows subgroup segments", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: "gitlab-dzr", Repo: "group/subgroup/repo"}}, false},
		{"repo rejects empty segment", ProjectConfig{SCM: SCMProjectConfig{Repo: "owner//repo"}}, true},
		{"repo rejects traversal segment", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: "gitlab-dzr", Repo: "group/../repo"}}, true},
		{"tracker inherits gitlab scm", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: "gitlab-dzr"}, TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice"}}, false},
		{"tracker provider matches scm", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: "gitlab-dzr"}, TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderGitLab, Assignee: "alice"}}, false},
		{"tracker provider mismatches scm", ProjectConfig{SCM: SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: "gitlab-dzr"}, TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderGitHub, Assignee: "alice"}}, true},
		{"tracker intake no rule", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true}}, true},
		{"tracker intake unknown provider", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: "linear", Assignee: "alice"}}, true},
		{"tracker intake repo with whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Repo: " acme/demo", Assignee: "alice"}}, true},
		{"tracker intake assignee with whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: " alice"}}, true},
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

	// The documented non-empty defaults.
	if def.DefaultBranch != "main" {
		t.Fatalf("default DefaultBranch = %q, want main", def.DefaultBranch)
	}
	if def.SCM.Provider != SCMProviderGitHub || def.SCM.ConnectionID != "github-default" {
		t.Fatalf("default SCM = %#v, want github/github-default", def.SCM)
	}

	// Every other field defaults to its zero value: clearing the documented
	// defaults must leave the config completely empty.
	def.DefaultBranch = ""
	def.SCM = SCMProjectConfig{}
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
	if got.SCM.Provider != SCMProviderGitHub || got.SCM.ConnectionID != "github-default" {
		t.Fatalf("WithDefaults SCM = %#v, want github/github-default", got.SCM)
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

	got = (ProjectConfig{
		SCM:           SCMProjectConfig{Provider: SCMProviderGitLab, ConnectionID: "gitlab-dzr", Repo: "group/subgroup/project"},
		Coordinator:   CoordinatorConfig{AutoWake: true},
		TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice"},
	}).WithDefaults()
	if got.SCM.Provider != SCMProviderGitLab || got.SCM.ConnectionID != "gitlab-dzr" || got.SCM.Repo != "group/subgroup/project" {
		t.Fatalf("WithDefaults overwrote GitLab SCM: %#v", got.SCM)
	}
	if got.TrackerIntake.Provider != TrackerProviderGitLab {
		t.Fatalf("TrackerIntake.Provider = %q, want %q", got.TrackerIntake.Provider, TrackerProviderGitLab)
	}
	if !got.Coordinator.AutoWake {
		t.Fatal("WithDefaults cleared coordinator auto-wake")
	}

	got = (ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice"}}).WithDefaults()
	if got.TrackerIntake.Provider != TrackerProviderGitHub {
		t.Fatalf("TrackerIntake.Provider = %q, want %q", got.TrackerIntake.Provider, TrackerProviderGitHub)
	}

	got = (ProjectConfig{}).WithDefaults()
	if got.TrackerIntake.Provider != "" {
		t.Fatalf("disabled TrackerIntake.Provider = %q, want empty", got.TrackerIntake.Provider)
	}
}

func TestSCMProjectConfigValidateAppliesDefaultsWithoutMutation(t *testing.T) {
	original := SCMProjectConfig{}
	if err := original.Validate(); err != nil {
		t.Fatalf("Validate legacy zero config: %v", err)
	}
	if original != (SCMProjectConfig{}) {
		t.Fatalf("Validate mutated original: %#v", original)
	}

	resolved := original.WithDefaults()
	if resolved.Provider != SCMProviderGitHub || resolved.ConnectionID != "github-default" {
		t.Fatalf("WithDefaults = %#v, want github/github-default", resolved)
	}
	if original != (SCMProjectConfig{}) {
		t.Fatalf("WithDefaults mutated original: %#v", original)
	}
}

func TestResolveReviewerHarness(t *testing.T) {
	// A configured reviewer always wins, regardless of the worker harness.
	cfg := ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerClaudeCode}}}
	if got := cfg.ResolveReviewerHarness(HarnessAider); got != ReviewerClaudeCode {
		t.Fatalf("configured reviewer = %q, want claude-code", got)
	}

	// No reviewer configured: reuse the worker's harness when it is itself a
	// supported reviewer.
	if got := (ProjectConfig{}).ResolveReviewerHarness(HarnessClaudeCode); got != ReviewerClaudeCode {
		t.Fatalf("claude-code worker = %q, want reviewer claude-code", got)
	}
	if got := (ProjectConfig{}).ResolveReviewerHarness(HarnessCodex); got != ReviewerCodex {
		t.Fatalf("codex worker = %q, want reviewer codex", got)
	}
	if got := (ProjectConfig{}).ResolveReviewerHarness(HarnessOpenCode); got != ReviewerOpenCode {
		t.Fatalf("opencode worker = %q, want reviewer opencode", got)
	}

	// A worker harness that is not itself a reviewer (e.g. crush, aider) falls
	// back to claude-code.
	if got := (ProjectConfig{}).ResolveReviewerHarness(HarnessCrush); got != FallbackReviewerHarness {
		t.Fatalf("crush worker = %q, want %q", got, FallbackReviewerHarness)
	}
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
}
