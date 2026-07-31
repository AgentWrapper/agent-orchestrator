package modelcatalog

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestModelCommandUsesProjectWorkingDirectory(t *testing.T) {
	cmd := modelCommand(context.Background(), "agent", []string{"models"}, "/work/project")
	if cmd.Dir != "/work/project" {
		t.Fatalf("Dir = %q, want /work/project", cmd.Dir)
	}
}

func TestBaseClassifiesStaticTextAndModeAgents(t *testing.T) {
	tests := []struct {
		agent string
		mode  ports.ModelSelectionMode
		count int
	}{
		{agent: "claude-code", mode: ports.ModelSelectionCatalog, count: 3},
		{agent: "codex", mode: ports.ModelSelectionCatalog, count: 7},
		{agent: "amp", mode: ports.ModelSelectionModeList, count: 4},
		{agent: "aider", mode: ports.ModelSelectionText},
		{agent: "autohand", mode: ports.ModelSelectionText},
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

func TestParseIDLinesAcceptsOnlyWholeModelIDs(t *testing.T) {
	got, err := parseIDLines([]byte("\x1b[32mModels\x1b[0m\nanthropic/claude-sonnet\nopenai/gpt-5.4\nTip: use --model <id>\nopenai/gpt-5.4 duplicate\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "anthropic/claude-sonnet" || got[1].ID != "openai/gpt-5.4" {
		t.Fatalf("models = %#v", got)
	}
}

func TestParseGrokModelsIgnoresAuthAndDefaultStatus(t *testing.T) {
	got, err := parseGrokModels([]byte(`You are not authenticated.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "grok-4.5" || !got[0].IsDefault {
		t.Fatalf("models = %#v", got)
	}
}

func TestParseCursorModelsStopsBeforeTip(t *testing.T) {
	got, err := parseCursorModels([]byte(`Available models

auto - Auto (default)
gpt-5.6-sol-high - GPT-5.6 Sol 1M High

Tip: use --model <id> to switch.
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "auto" || got[0].Label != "Auto" || !got[0].IsDefault {
		t.Fatalf("models = %#v", got)
	}
	if got[1].ID != "gpt-5.6-sol-high" || got[1].Label != "GPT-5.6 Sol 1M High" {
		t.Fatalf("models = %#v", got)
	}
}

func TestParsePiModelsBuildsProviderQualifiedIDs(t *testing.T) {
	got, err := parsePiModels([]byte(`provider   model                       context  max-out  thinking  images
anthropic  claude-sonnet-4-6           1M       64K      yes       yes
openai     gpt-5.5                     272K     128K     yes       yes
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "anthropic/claude-sonnet-4-6" || got[1].ID != "openai/gpt-5.5" {
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

func TestParseJSONModelsSupportsKiroAndDevinFields(t *testing.T) {
	got, err := parseJSONModels([]byte(`{
		"models": [{"model_name": "Auto", "model_id": "auto"}],
		"families": [{
			"slug": "claude-opus-5",
			"family_label": "Claude Opus 5",
			"variants": [{"model_uid": "claude-opus-5-high", "label": "Claude Opus 5 High"}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"auto":               true,
		"claude-opus-5":      true,
		"claude-opus-5-high": true,
	}
	for _, item := range got {
		delete(want, item.ID)
	}
	if len(want) != 0 {
		t.Fatalf("models = %#v, missing %#v", got, want)
	}
}
