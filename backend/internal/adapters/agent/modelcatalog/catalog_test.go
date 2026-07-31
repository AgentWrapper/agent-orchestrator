package modelcatalog

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestBaseClassifiesStaticTextAndModeAgents(t *testing.T) {
	tests := []struct {
		agent string
		mode  ports.ModelSelectionMode
		count int
	}{
		{agent: "claude-code", mode: ports.ModelSelectionCatalog, count: 3},
		{agent: "codex", mode: ports.ModelSelectionCatalog, count: 7},
		{agent: "amp", mode: ports.ModelSelectionModeList, count: 4},
		{agent: "qwen", mode: ports.ModelSelectionText},
	}
	for _, tc := range tests {
		t.Run(tc.agent, func(t *testing.T) {
			got := Base(tc.agent)
			if got.SelectionMode != tc.mode || len(got.Models) != tc.count {
				t.Fatalf("Base(%q) = %#v", tc.agent, got)
			}
		})
	}
}

func TestParseTextModelsNormalizesOutput(t *testing.T) {
	got := parseTextModels("\x1b[32mModels\x1b[0m\n• anthropic/claude-sonnet label\n- openai/gpt-5.4\nopenai/gpt-5.4 duplicate\n")
	if len(got) != 2 || got[0].ID != "anthropic/claude-sonnet" || got[1].ID != "openai/gpt-5.4" {
		t.Fatalf("models = %#v", got)
	}
}

func TestParseJSONModelsFindsNestedModels(t *testing.T) {
	got, err := parseJSONModels([]byte(`{"providers":[{"id":"anthropic","models":[{"modelId":"claude-sonnet","displayName":"Claude Sonnet","isDefault":true}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("models = %#v", got)
	}
	var found bool
	for _, model := range got {
		if model.ID == "claude-sonnet" && model.Label == "Claude Sonnet" && model.IsDefault {
			found = true
		}
	}
	if !found {
		t.Fatalf("models = %#v, want nested claude-sonnet", got)
	}
}
