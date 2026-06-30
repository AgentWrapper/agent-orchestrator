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
		{"good reviewers", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerClaudeCode}}}, false},
		{"unknown reviewer harness", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: "nope"}}}, true},
		{"worker harness is not auto a reviewer", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerHarness(HarnessCodex)}}}, true},
		{"empty reviewer harness", ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ""}}}, true},
		{"tracker intake label rule", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Labels: []string{"agent-ready"}}}, false},
		{"tracker intake assignee rule", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: "alice"}}, false},
		{"tracker intake no rule", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true}}, true},
		{"tracker intake unknown provider", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: "unknown", Labels: []string{"agent-ready"}}}, true},
		{"tracker intake empty label", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Labels: []string{""}}}, true},
		{"tracker intake label with whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Labels: []string{" agent-ready"}}}, true},
		{"tracker intake repo with whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Repo: " acme/demo", Labels: []string{"agent-ready"}}}, true},
		{"tracker intake assignee with whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Assignee: " alice"}}, true},
		{"tracker intake negative limit", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Labels: []string{"agent-ready"}, Limit: -1}}, true},

		// Linear provider — team scope required and cross-provider fields rejected.
		{"linear intake ok", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderLinear, Team: "ENG", Labels: []string{"ready"}}}, false},
		{"linear intake missing team", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderLinear, Labels: []string{"ready"}}}, true},
		{"linear intake team whitespace", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderLinear, Team: " ENG", Labels: []string{"ready"}}}, true},
		{"linear intake leaks repo", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderLinear, Team: "ENG", Repo: "acme/demo", Labels: []string{"ready"}}}, true},
		{"linear intake leaks jira fields", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderLinear, Team: "ENG", BaseURL: "acme.atlassian.net", Labels: []string{"ready"}}}, true},
		{"linear intake no rule", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderLinear, Team: "ENG"}}, true},

		// Jira provider — base URL + project key required and cross-provider fields rejected.
		{"jira intake ok", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderJira, BaseURL: "https://acme.atlassian.net", ProjectKey: "ENG", Labels: []string{"ready"}}}, false},
		{"jira intake host ok", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderJira, BaseURL: "acme.atlassian.net", ProjectKey: "ENG", Labels: []string{"ready"}}}, false},
		{"jira intake missing base URL", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderJira, ProjectKey: "ENG", Labels: []string{"ready"}}}, true},
		{"jira intake trailing slash", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderJira, BaseURL: "acme.atlassian.net/", ProjectKey: "ENG", Labels: []string{"ready"}}}, true},
		{"jira intake missing project key", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderJira, BaseURL: "acme.atlassian.net", Labels: []string{"ready"}}}, true},
		{"jira intake leaks repo", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderJira, BaseURL: "acme.atlassian.net", ProjectKey: "ENG", Repo: "acme/demo", Labels: []string{"ready"}}}, true},
		{"jira intake leaks linear team", ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderJira, BaseURL: "acme.atlassian.net", ProjectKey: "ENG", Team: "ENG", Labels: []string{"ready"}}}, true},
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

	got = (ProjectConfig{TrackerIntake: TrackerIntakeConfig{Enabled: true, Labels: []string{"agent-ready"}}}).WithDefaults()
	if got.TrackerIntake.Provider != TrackerProviderGitHub {
		t.Fatalf("TrackerIntake.Provider = %q, want %q", got.TrackerIntake.Provider, TrackerProviderGitHub)
	}

	got = (ProjectConfig{}).WithDefaults()
	if got.TrackerIntake.Provider != "" {
		t.Fatalf("disabled TrackerIntake.Provider = %q, want empty", got.TrackerIntake.Provider)
	}
}

func TestResolveReviewerHarness(t *testing.T) {
	// A configured reviewer always wins, regardless of the worker harness.
	cfg := ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerClaudeCode}}}
	if got := cfg.ResolveReviewerHarness(HarnessAider); got != ReviewerClaudeCode {
		t.Fatalf("configured reviewer = %q, want claude-code", got)
	}

	// No reviewer configured: reuse the worker harness when it is also a
	// supported reviewer (claude-code is).
	if got := (ProjectConfig{}).ResolveReviewerHarness(HarnessClaudeCode); got != ReviewerClaudeCode {
		t.Fatalf("default = %q, want reviewer claude-code", got)
	}

	// A worker harness that is not a supported reviewer falls back to claude-code.
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
