package domain

import "testing"

func TestTrackerIntakeConfigWithDefaults(t *testing.T) {
	tests := []struct {
		name     string
		cfg      TrackerIntakeConfig
		scm      SCMProvider
		provider TrackerProvider
	}{
		{"disabled stays empty", TrackerIntakeConfig{}, SCMProviderGitLab, ""},
		{"inherits github", TrackerIntakeConfig{Enabled: true}, SCMProviderGitHub, TrackerProviderGitHub},
		{"inherits gitlab", TrackerIntakeConfig{Enabled: true}, SCMProviderGitLab, TrackerProviderGitLab},
		{"keeps explicit provider", TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderGitHub}, SCMProviderGitLab, TrackerProviderGitHub},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.cfg.withDefaults(tt.scm).Provider; got != tt.provider {
				t.Fatalf("WithDefaults(%q).Provider = %q, want %q", tt.scm, got, tt.provider)
			}
		})
	}
}

func TestTrackerIntakeConfigValidateProvider(t *testing.T) {
	tests := []struct {
		name    string
		cfg     TrackerIntakeConfig
		scm     SCMProvider
		wantErr bool
	}{
		{"inherits gitlab", TrackerIntakeConfig{Enabled: true, Assignee: "alice"}, SCMProviderGitLab, false},
		{"explicit gitlab matches", TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderGitLab, Assignee: "alice"}, SCMProviderGitLab, false},
		{"github mismatches gitlab", TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderGitHub, Assignee: "alice"}, SCMProviderGitLab, true},
		{"gitlab mismatches github", TrackerIntakeConfig{Enabled: true, Provider: TrackerProviderGitLab, Assignee: "alice"}, SCMProviderGitHub, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.cfg.validate(tt.scm); (err != nil) != tt.wantErr {
				t.Fatalf("Validate(%q) err = %v, wantErr = %v", tt.scm, err, tt.wantErr)
			}
		})
	}
}

func TestTrackerIntakeConfigRejectsBlankLabel(t *testing.T) {
	cfg := TrackerIntakeConfig{Enabled: true, Assignee: "alice", Labels: []string{"ready", " "}}
	if err := cfg.validate(SCMProviderGitHub); err == nil {
		t.Fatal("validate() error = nil, want blank label rejection")
	}
}
