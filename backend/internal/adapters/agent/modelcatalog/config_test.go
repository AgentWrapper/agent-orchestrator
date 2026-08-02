package modelcatalog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseCrushConfigExtractsModelsWithoutCredentials(t *testing.T) {
	models, err := parseCrushConfig([]byte(`[
		{"id":"anthropic","api_key":"must-not-leak","default_large_model_id":"claude-opus","models":[
			{"id":"claude-opus","name":"Claude Opus"},
			{"id":"claude-sonnet","name":"Claude Sonnet"}
		]}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "claude-opus" || !models[0].IsDefault || models[0].Provider != "anthropic" {
		t.Fatalf("models = %#v", models)
	}
	for _, model := range models {
		if strings.Contains(model.ID+model.Label+model.Provider, "must-not-leak") {
			t.Fatalf("credential leaked into model metadata: %#v", model)
		}
	}
}

func TestParseContinueConfigExtractsConfiguredModels(t *testing.T) {
	models, err := parseContinueConfig([]byte(`
models:
  - name: Claude Sonnet
    provider: anthropic
    model: claude-sonnet-4
    apiKey: must-not-leak
  - name: Local Qwen
    provider: ollama
    model: qwen3-coder
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "claude-sonnet-4" || models[0].Provider != "anthropic" {
		t.Fatalf("models = %#v", models)
	}
}

func TestParseOpenCodeJSONCExtractsSelectedAndCustomModels(t *testing.T) {
	models, err := parseOpenCodeConfig([]byte(`{
		// Project plugins are data only and are never loaded by this parser.
		"model": "zai/glm-5",
		"provider": {
			"zai": {"options":{"apiKey":"must-not-leak"},"models": {
				"glm-5": {"name":"GLM 5"},
			}},
		},
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "zai/glm-5" || models[0].Label != "GLM 5" || !models[0].IsDefault {
		t.Fatalf("models = %#v", models)
	}
}

func TestParseQwenConfigExtractsProviderModels(t *testing.T) {
	models, err := parseQwenConfig([]byte(`{
		"defaultModel":"qwen3-coder",
		"modelProviders": {
			"openai": [
				{"id":"qwen3-coder","name":"Qwen 3 Coder","envKey":"SECRET"},
				{"id":"glm-5","name":"GLM 5"}
			],
			"credentials-only": {"apiKey":"must-not-leak"}
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "qwen3-coder" || !models[0].IsDefault || models[0].Provider != "openai" {
		t.Fatalf("models = %#v", models)
	}
}

func TestParseKimiConfigUsesModelSectionsOnly(t *testing.T) {
	models, err := parseKimiConfig([]byte(`
default_model = "zai/glm-5"
api_key = "must-not-leak"

[providers.zai]
type = "openai"
model = "not-a-catalog-entry"

[models."zai/glm-5"]
provider = "zai"
model = "glm-5"
display_name = "GLM 5"

[models.'moonshot/kimi-k2']
provider = "moonshot"
model = "kimi-k2"
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "zai/glm-5" || models[0].Label != "GLM 5" || !models[0].IsDefault {
		t.Fatalf("models = %#v", models)
	}
	for _, model := range models {
		if model.ID == "not-a-catalog-entry" || strings.Contains(model.ID+model.Label+model.Provider, "must-not-leak") {
			t.Fatalf("unrelated config value leaked into catalog: %#v", model)
		}
	}
}

func TestParseKimiConfigSupportsTOMLStringEscapes(t *testing.T) {
	models, err := parseKimiConfig([]byte(`
default_model = "zai/glm\u002d5"

[models."zai/glm\u002d5"]
provider = "zai\tcloud"
display_name = "GLM\nFive \U0001F680"
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "zai/glm-5" || models[0].Provider != "zai\tcloud" || models[0].Label != "GLM\nFive 🚀" {
		t.Fatalf("models = %#v", models)
	}
}

func TestConfigModelsFromPathsMergesFilesAndIgnoresMissing(t *testing.T) {
	dir := t.TempDir()
	global := filepath.Join(dir, "global.yaml")
	project := filepath.Join(dir, "project.yaml")
	if err := os.WriteFile(global, []byte("models:\n  - name: Global\n    model: shared\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(project, []byte("models:\n  - name: Project\n    provider: local\n    model: project-only\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	models, err := configModelsFromPaths(configSpecs["continue"], []configPath{
		{root: dir, name: filepath.Base(global)},
		{root: dir, name: "missing.yaml"},
		{root: dir, name: filepath.Base(project)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %#v", models)
	}
}

func TestReadBoundedConfigRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large.json")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxConfigFileSize + 1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readBoundedConfig(configPath{root: filepath.Dir(path), name: filepath.Base(path)}); err == nil {
		t.Fatal("readBoundedConfig: want size-limit error")
	}
}

func TestReadBoundedConfigRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.json")
	link := filepath.Join(dir, "config.json")
	if err := os.WriteFile(target, []byte(`{"model":"secret-shaped-value"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, _, err := readBoundedConfig(configPath{root: dir, name: filepath.Base(link)}); err == nil {
		t.Fatal("readBoundedConfig: want symlink error")
	}
}

func TestReadBoundedConfigRejectsSymlinkDirectoryComponent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "config.json"), []byte(`{"model":"must-not-read"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, _, err := readBoundedConfig(configPath{root: root, name: filepath.Join("linked", "config.json")}); err == nil {
		t.Fatal("readBoundedConfig: want symlink-component error")
	}
}

func TestReadBoundedConfigRejectsParentTraversal(t *testing.T) {
	root := t.TempDir()
	if _, _, err := readBoundedConfig(configPath{root: root, name: filepath.Join("..", "config.json")}); err == nil {
		t.Fatal("readBoundedConfig: want traversal error")
	}
}

func TestConfigVersionChangesWhenConfigMetadataChanges(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	path := filepath.Join(home, ".config", "opencode", "opencode.json")
	before := ConfigVersion("opencode", "")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"model":"zai/glm-5"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	after := ConfigVersion("opencode", "")
	if before == "" || after == "" || before == after {
		t.Fatalf("versions before=%q after=%q, want a change", before, after)
	}
}

func TestStripJSONCKeepsCommaBraceInsideString(t *testing.T) {
	cleaned, err := stripJSONC([]byte(`{"model":"name,}",}`))
	if err != nil {
		t.Fatal(err)
	}
	root, err := parseJSONObject(cleaned)
	if err != nil {
		t.Fatal(err)
	}
	if got := firstString(root, "model"); got != "name,}" {
		t.Fatalf("model = %q, want name,}", got)
	}
}

func TestStripJSONCAcceptsLineCommentAtEOF(t *testing.T) {
	cleaned, err := stripJSONC([]byte("{\"model\":\"glm-5\"} // valid through EOF"))
	if err != nil {
		t.Fatal(err)
	}
	root, err := parseJSONObject(cleaned)
	if err != nil {
		t.Fatal(err)
	}
	if got := firstString(root, "model"); got != "glm-5" {
		t.Fatalf("model = %q, want glm-5", got)
	}
}

func TestNormalizeCombinesMetadataFromDuplicateSources(t *testing.T) {
	models, err := parseOpenCodeConfig([]byte(`{"model":"zai/glm-5","provider":{"zai":{"models":{"glm-5":{"name":"GLM 5"}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].Label != "GLM 5" || models[0].Provider != "zai" || !models[0].IsDefault {
		t.Fatalf("models = %#v", models)
	}
}
