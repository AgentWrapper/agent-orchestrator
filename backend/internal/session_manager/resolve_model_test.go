package sessionmanager

import (
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// cfgWithMix builds a project config whose base agentConfig pins a
// provider-correct model per harness — the shape this deployment uses to keep a
// worker mix from leaking one model across providers.
func cfgWithMix() domain.ProjectConfig {
	return domain.ProjectConfig{
		AgentConfig: domain.AgentConfig{
			ModelByHarness: map[domain.AgentHarness]domain.HarnessModel{
				domain.HarnessClaudeCode: {Model: "opus", Effort: domain.EffortHigh},
				domain.HarnessCodex:      {Model: "gpt-5.5-codex", Effort: domain.EffortHigh},
				domain.HarnessCodexFugu:  {Model: "fugu"},
			},
		},
	}
}

func TestEffectiveAgentConfig_PerHarnessMap(t *testing.T) {
	cfg := cfgWithMix()

	// Each harness resolves to its own provider-correct model + effort, with no
	// manual per-spawn model, and no leak across providers.
	cases := []struct {
		harness    domain.AgentHarness
		wantModel  string
		wantEffort domain.Effort
	}{
		{domain.HarnessClaudeCode, "opus", domain.EffortHigh},
		{domain.HarnessCodex, "gpt-5.5-codex", domain.EffortHigh},
		{domain.HarnessCodexFugu, "fugu", ""},
	}
	for _, tc := range cases {
		got, err := effectiveAgentConfig(domain.KindWorker, cfg, "", tc.harness)
		if err != nil {
			t.Fatalf("%s: unexpected err %v", tc.harness, err)
		}
		if got.Model != tc.wantModel {
			t.Errorf("%s: model = %q, want %q", tc.harness, got.Model, tc.wantModel)
		}
		if got.Effort != tc.wantEffort {
			t.Errorf("%s: effort = %q, want %q", tc.harness, got.Effort, tc.wantEffort)
		}
	}
}

func TestEffectiveAgentConfig_ScalarModelNeverLeaksAcrossProvider(t *testing.T) {
	// The exact bug #66 fixes: worker role pinned model=opus, then a codex worker
	// is spawned. The opus scalar must be IGNORED for the codex harness (not
	// passed, not an error) — a mismatched pinned model silently leaking is what
	// hung the codex workers.
	cfg := domain.ProjectConfig{
		Worker: domain.RoleOverride{AgentConfig: domain.AgentConfig{Model: "opus"}},
	}
	got, err := effectiveAgentConfig(domain.KindWorker, cfg, "", domain.HarnessCodex)
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got.Model != "" {
		t.Fatalf("codex model = %q, want empty (opus must not leak)", got.Model)
	}
	// The same opus scalar DOES apply to a claude-code spawn (provider matches).
	got, err = effectiveAgentConfig(domain.KindWorker, cfg, "", domain.HarnessClaudeCode)
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got.Model != "opus" {
		t.Fatalf("claude-code model = %q, want opus", got.Model)
	}
}

func TestEffectiveAgentConfig_ScalarEffortSurvivesModelGate(t *testing.T) {
	// A scalar model that's the wrong provider is gated out, but the scalar
	// effort is provider-neutral and must still apply to the harness.
	cfg := domain.ProjectConfig{
		AgentConfig: domain.AgentConfig{Model: "opus", Effort: domain.EffortHigh},
	}
	got, err := effectiveAgentConfig(domain.KindWorker, cfg, "", domain.HarnessCodex)
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got.Model != "" {
		t.Fatalf("model = %q, want empty (opus gated out on codex)", got.Model)
	}
	if got.Effort != domain.EffortHigh {
		t.Fatalf("effort = %q, want high (survives the model gate)", got.Effort)
	}
}

func TestEffectiveAgentConfig_ExplicitCrossProviderModelFailsLoud(t *testing.T) {
	cfg := cfgWithMix()
	// An explicit per-spawn model of the wrong provider is a loud error, never a
	// silent hang.
	_, err := effectiveAgentConfig(domain.KindWorker, cfg, "opus", domain.HarnessCodex)
	if !errors.Is(err, ErrModelHarnessMismatch) {
		t.Fatalf("err = %v, want ErrModelHarnessMismatch", err)
	}
}

func TestEffectiveAgentConfig_ExplicitModelOverridesAndMapWins(t *testing.T) {
	cfg := cfgWithMix()
	// Deploy pool: explicit --model haiku on a claude-code spawn overrides the
	// per-harness opus (same provider, so allowed).
	got, err := effectiveAgentConfig(domain.KindWorker, cfg, "haiku", domain.HarnessClaudeCode)
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got.Model != "haiku" {
		t.Fatalf("model = %q, want haiku (explicit override)", got.Model)
	}
}

func TestEffectiveAgentConfig_ClaudeCodeDefaultsToOpusNotAccountDefault(t *testing.T) {
	// Issue #61: a claude-code spawn that pins nothing at any level must NOT fall
	// through to the account CLI default (Fable in this deployment — the priciest
	// model). Resolution substitutes opus so a *default* never lands on the most
	// expensive model.
	got, err := effectiveAgentConfig(domain.KindWorker, domain.ProjectConfig{}, "", domain.HarnessClaudeCode)
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got.Model != "opus" {
		t.Fatalf("claude-code default model = %q, want opus", got.Model)
	}
}

func TestEffectiveAgentConfig_OpusDefaultOnlyForClaudeCode(t *testing.T) {
	// The default guard is claude-code-only: every other harness keeps its own
	// runtime/account default (empty model → no override injected), so codex and
	// the many unmapped harnesses are unaffected.
	for _, h := range []domain.AgentHarness{domain.HarnessCodex, domain.HarnessCodexFugu, domain.HarnessAider} {
		got, err := effectiveAgentConfig(domain.KindWorker, domain.ProjectConfig{}, "", h)
		if err != nil {
			t.Fatalf("%s: unexpected err %v", h, err)
		}
		if got.Model != "" {
			t.Fatalf("%s: model = %q, want empty (opus default must not leak)", h, got.Model)
		}
	}
}

func TestEffectiveAgentConfig_ExplicitFableHonoredOverDefault(t *testing.T) {
	// The guard catches only the *unintended* empty default. An explicit fable
	// choice — here pinned at project level — is a deliberate selection and must
	// be honored untouched.
	cfg := domain.ProjectConfig{AgentConfig: domain.AgentConfig{Model: "fable"}}
	got, err := effectiveAgentConfig(domain.KindWorker, cfg, "", domain.HarnessClaudeCode)
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got.Model != "fable" {
		t.Fatalf("model = %q, want fable (explicit choice honored)", got.Model)
	}
}

func TestEffectiveAgentConfig_ExplicitSpawnFableHonoredOverDefault(t *testing.T) {
	// An explicit per-spawn `--model fable` on claude-code is also deliberate and
	// wins over the opus default.
	got, err := effectiveAgentConfig(domain.KindWorker, domain.ProjectConfig{}, "fable", domain.HarnessClaudeCode)
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got.Model != "fable" {
		t.Fatalf("model = %q, want fable (explicit spawn choice honored)", got.Model)
	}
}

func TestEffectiveAgentConfig_UnknownHarnessIsPermissive(t *testing.T) {
	// A harness AO has not mapped is unguarded: any scalar model passes through,
	// preserving behavior for the 20+ other harnesses.
	cfg := domain.ProjectConfig{
		Worker: domain.RoleOverride{AgentConfig: domain.AgentConfig{Model: "some-model"}},
	}
	got, err := effectiveAgentConfig(domain.KindWorker, cfg, "", domain.HarnessAider)
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got.Model != "some-model" {
		t.Fatalf("model = %q, want some-model", got.Model)
	}
}

func TestEffectiveAgentConfig_RoleMapOverridesBaseMap(t *testing.T) {
	cfg := cfgWithMix()
	// A worker role override for codex beats the base map for codex.
	cfg.Worker = domain.RoleOverride{AgentConfig: domain.AgentConfig{
		ModelByHarness: map[domain.AgentHarness]domain.HarnessModel{
			domain.HarnessCodex: {Model: "gpt-5.5-codex-mini", Effort: domain.EffortMedium},
		},
	}}
	got, err := effectiveAgentConfig(domain.KindWorker, cfg, "", domain.HarnessCodex)
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got.Model != "gpt-5.5-codex-mini" || got.Effort != domain.EffortMedium {
		t.Fatalf("resolved = %#v, want gpt-5.5-codex-mini/medium", got)
	}
}
