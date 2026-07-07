package domain

import "testing"

func TestClassifyModelProvider(t *testing.T) {
	tests := []struct {
		model string
		want  ModelProvider
	}{
		{"", ProviderUnknown},
		{"opus", ProviderAnthropic},
		{"claude-opus-4-8", ProviderAnthropic},
		{"sonnet", ProviderAnthropic},
		{"haiku", ProviderAnthropic},
		{"claude-fable-5", ProviderAnthropic},
		{"fable", ProviderAnthropic},
		{"gpt-5.5-codex", ProviderOpenAI},
		{"gpt-4o", ProviderOpenAI},
		{"o3", ProviderOpenAI},
		{"o1-mini", ProviderOpenAI},
		// fugu reuses the codex binary but its own model namespace, so it must
		// classify as fugu even though "codex" would otherwise match OpenAI.
		{"fugu-ultra", ProviderFugu},
		// unrecognized models stay unknown so resolution is permissive.
		{"llama-3", ProviderUnknown},
		{"some-internal-model", ProviderUnknown},
	}
	for _, tt := range tests {
		if got := ClassifyModelProvider(tt.model); got != tt.want {
			t.Errorf("ClassifyModelProvider(%q) = %q, want %q", tt.model, got, tt.want)
		}
	}
}

func TestAgentHarnessModelProvider(t *testing.T) {
	tests := []struct {
		harness AgentHarness
		want    ModelProvider
	}{
		{HarnessClaudeCode, ProviderAnthropic},
		{HarnessCodex, ProviderOpenAI},
		{HarnessCodexFugu, ProviderFugu},
		// Every harness AO has not mapped stays unknown (unguarded).
		{HarnessAider, ProviderUnknown},
		{HarnessGoose, ProviderUnknown},
		{"", ProviderUnknown},
	}
	for _, tt := range tests {
		if got := tt.harness.ModelProvider(); got != tt.want {
			t.Errorf("%q.ModelProvider() = %q, want %q", tt.harness, got, tt.want)
		}
	}
}
