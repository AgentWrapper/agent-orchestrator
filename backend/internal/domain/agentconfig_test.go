package domain

import "testing"

func TestEffortValid(t *testing.T) {
	valid := []Effort{"", EffortMinimal, EffortLow, EffortMedium, EffortHigh, EffortXHigh, EffortMax}
	for _, e := range valid {
		if !e.Valid() {
			t.Errorf("Effort(%q).Valid() = false, want true", e)
		}
	}
	for _, e := range []Effort{"huge", "none", "HIGH"} {
		if e.Valid() {
			t.Errorf("Effort(%q).Valid() = true, want false", e)
		}
	}
}

func TestAgentConfigValidate(t *testing.T) {
	tests := []struct {
		name    string
		cfg     AgentConfig
		wantErr bool
	}{
		{"empty ok", AgentConfig{}, false},
		{"scalar model + permissions ok", AgentConfig{Model: "opus", Permissions: PermissionModeAuto}, false},
		{"bad permissions", AgentConfig{Permissions: "yolo"}, true},
		{"good effort", AgentConfig{Effort: EffortHigh}, false},
		{"bad effort", AgentConfig{Effort: "ludicrous"}, true},
		{
			"good per-harness map (providers match)",
			AgentConfig{ModelByHarness: map[AgentHarness]HarnessModel{
				HarnessClaudeCode: {Model: "opus", Effort: EffortHigh},
				HarnessCodex:      {Model: "gpt-5.5-codex", Effort: EffortHigh},
				HarnessCodexFugu:  {Model: "fugu-ultra"},
			}},
			false,
		},
		{
			"per-harness map with unknown harness key",
			AgentConfig{ModelByHarness: map[AgentHarness]HarnessModel{"nope": {Model: "x"}}},
			true,
		},
		{
			"per-harness map with cross-provider model (opus on codex)",
			AgentConfig{ModelByHarness: map[AgentHarness]HarnessModel{HarnessCodex: {Model: "opus"}}},
			true,
		},
		{
			"per-harness map with bad effort",
			AgentConfig{ModelByHarness: map[AgentHarness]HarnessModel{HarnessCodex: {Model: "gpt-5.5-codex", Effort: "nope"}}},
			true,
		},
		{
			"per-harness map with unclassified harness accepts any model",
			AgentConfig{ModelByHarness: map[AgentHarness]HarnessModel{HarnessAider: {Model: "whatever"}}},
			false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.cfg.Validate(); (err != nil) != tt.wantErr {
				t.Fatalf("Validate() err = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}

func TestAgentConfigIsZero(t *testing.T) {
	if !(AgentConfig{}).IsZero() {
		t.Fatal("empty AgentConfig should be zero")
	}
	if (AgentConfig{Model: "opus"}).IsZero() {
		t.Fatal("AgentConfig with model should not be zero")
	}
	if (AgentConfig{ModelByHarness: map[AgentHarness]HarnessModel{HarnessCodex: {Model: "gpt-5.5-codex"}}}).IsZero() {
		t.Fatal("AgentConfig with per-harness map should not be zero")
	}
	// An empty (non-nil) map carries no settings and must count as zero.
	if !(AgentConfig{ModelByHarness: map[AgentHarness]HarnessModel{}}).IsZero() {
		t.Fatal("AgentConfig with an empty per-harness map should be zero")
	}
	if (AgentConfig{Effort: EffortHigh}).IsZero() {
		t.Fatal("AgentConfig with effort should not be zero")
	}
}
