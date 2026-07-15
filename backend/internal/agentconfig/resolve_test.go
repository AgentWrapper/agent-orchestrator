package agentconfig

import (
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestEffectiveResolvesPerHarnessModel(t *testing.T) {
	cfg := domain.ProjectConfig{AgentConfig: domain.AgentConfig{
		ModelByHarness: map[domain.AgentHarness]domain.HarnessModel{
			domain.HarnessClaudeCode: {Model: "opus", Effort: domain.EffortHigh},
			domain.HarnessCodex:      {Model: "gpt-5.5-codex"},
		},
	}}

	got, err := Effective(domain.KindWorker, cfg, "", domain.HarnessClaudeCode)
	if err != nil {
		t.Fatalf("Effective: %v", err)
	}
	if got.Model != "opus" || got.Effort != domain.EffortHigh {
		t.Fatalf("resolved = %#v, want opus/high", got)
	}
}

func TestEffectiveRejectsExplicitCrossProviderModel(t *testing.T) {
	_, err := Effective(domain.KindWorker, domain.ProjectConfig{}, "opus", domain.HarnessCodex)
	if !errors.Is(err, ErrModelHarnessMismatch) {
		t.Fatalf("err = %v, want ErrModelHarnessMismatch", err)
	}
}

func TestConfiguredModelPinsUseLaunchPrecedence(t *testing.T) {
	cfg := domain.ProjectConfig{
		AgentConfig: domain.AgentConfig{
			Model: "opus",
			ModelByHarness: map[domain.AgentHarness]domain.HarnessModel{
				domain.HarnessCodex: {Model: "gpt-5.5-codex"},
				domain.HarnessAider: {Model: "aider-model"},
			},
		},
		Worker:       domain.RoleOverride{Harness: domain.HarnessCodex},
		Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		WorkerMix: domain.WorkerMix{
			{Harness: domain.HarnessCodexFugu, Model: "fugu", Weight: 50},
			{Harness: domain.HarnessClaudeCode, Weight: 50},
		},
	}

	got := ConfiguredModelPins(cfg)
	want := []ModelPin{
		{Scope: "worker", Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"},
		{Scope: "orchestrator", Harness: domain.HarnessClaudeCode, Model: "opus"},
		{Scope: "agentConfig.modelByHarness[aider]", Harness: domain.HarnessAider, Model: "aider-model"},
		{Scope: "workerMix[0]", Harness: domain.HarnessCodexFugu, Model: "fugu"},
	}
	if len(got) != len(want) {
		t.Fatalf("pins = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("pin %d = %#v, want %#v (all=%#v)", i, got[i], want[i], got)
		}
	}
}
