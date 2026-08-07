package modelcatalog

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestModelCommandUsesProjectWorkingDirectory(t *testing.T) {
	cmd := modelCommand(context.Background(), "agent", []string{"models"}, "/work/project", map[string]string{"OPENCODE_CONFIG": "/project/opencode.json"})
	if cmd.Dir != "/work/project" {
		t.Fatalf("Dir = %q, want /work/project", cmd.Dir)
	}
	if cmd.WaitDelay != commandTerminationWait {
		t.Fatalf("WaitDelay = %s, want %s", cmd.WaitDelay, commandTerminationWait)
	}
	if !environmentContains(cmd.Env, "OPENCODE_CONFIG=/project/opencode.json") {
		t.Fatalf("Env does not contain project override: %#v", cmd.Env)
	}
}

func environmentContains(env []string, wanted string) bool {
	for _, item := range env {
		if item == wanted {
			return true
		}
	}
	return false
}

func TestCommandDiscoveryTimeoutAllowsSlowModelRegistries(t *testing.T) {
	if commandTimeout < 20*time.Second {
		t.Fatalf("commandTimeout = %s, want at least 20s", commandTimeout)
	}
}

func TestModelDiscoveryErrorExplainsTimeout(t *testing.T) {
	deadlineCtx, deadlineCancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer deadlineCancel()
	err := modelDiscoveryError(deadlineCtx, "kilocode", errors.New("signal: killed"))
	if !strings.Contains(err.Error(), "kilocode model discovery timed out after 20s") {
		t.Fatalf("error = %q, want clear timeout", err)
	}
}

func TestOpenCodeDiscoveryUsesPureMode(t *testing.T) {
	spec := commandSpecs["opencode"]
	if len(spec.args) != 2 || spec.args[0] != "--pure" || spec.args[1] != "models" {
		t.Fatalf("opencode discovery args = %q, want [--pure models]", spec.args)
	}
}

func TestAiderAndAutohandUseDocumentedDiscoveryCommands(t *testing.T) {
	tests := []struct {
		agent string
		want  []string
	}{
		{agent: "aider", want: []string{"--no-check-update", "--no-git", "--no-gitignore", "--no-analytics", "--list-models", "."}},
		{agent: "autohand", want: []string{"models", "list"}},
	}
	for _, tc := range tests {
		t.Run(tc.agent, func(t *testing.T) {
			spec := commandSpecs[tc.agent]
			if strings.Join(spec.args, "\x00") != strings.Join(tc.want, "\x00") {
				t.Fatalf("%s discovery args = %q, want %q", tc.agent, spec.args, tc.want)
			}
		})
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
		{agent: "muse", mode: ports.ModelSelectionCatalog, count: 3},
		{agent: "aider", mode: ports.ModelSelectionCatalog},
		{agent: "autohand", mode: ports.ModelSelectionCatalog},
		{agent: "qwen", mode: ports.ModelSelectionText},
		{agent: "continue", mode: ports.ModelSelectionText},
		{agent: "crush", mode: ports.ModelSelectionText},
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

func TestBaseMuseCatalogAllowsCustomModels(t *testing.T) {
	got := Base("muse")
	if got.SelectionMode != ports.ModelSelectionCatalog {
		t.Fatalf("SelectionMode = %q, want catalog", got.SelectionMode)
	}
	if !got.AllowCustom {
		t.Fatal("AllowCustom = false, want true")
	}
	if got.Source != "official-catalog" {
		t.Fatalf("Source = %q, want official-catalog", got.Source)
	}
	if len(got.Models) != 3 || got.Models[0].ID != "muse-spark" || !got.Models[0].IsDefault {
		t.Fatalf("models = %#v", got.Models)
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
