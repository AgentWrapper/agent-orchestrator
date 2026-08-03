package modelcatalog

import (
	"context"
	"errors"
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
	if len(models) != 2 || models[0].ID != "anthropic/claude-opus" || !models[0].IsDefault || models[0].Provider != "anthropic" {
		t.Fatalf("models = %#v", models)
	}
	for _, model := range models {
		if strings.Contains(model.ID+model.Label+model.Provider, "must-not-leak") {
			t.Fatalf("credential leaked into model metadata: %#v", model)
		}
	}
}

func TestParseCurrentCrushConfigExtractsQualifiedModels(t *testing.T) {
	models, err := parseCrushConfig([]byte(`{
		"models":{"large":{"provider":"openai","model":"gpt-5"}},
		"providers":{"openai":{"api_key":"must-not-leak","models":[
			{"id":"gpt-5","name":"GPT-5"},
			{"id":"gpt-5-mini","name":"GPT-5 mini"}
		]}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "openai/gpt-5" || models[0].Label != "GPT-5" || !models[0].IsDefault {
		t.Fatalf("models = %#v", models)
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

func TestParseContinueConfigOnlyIncludesChatCapableModels(t *testing.T) {
	models, err := parseContinueConfig([]byte(`
models:
  - name: Default chat
    model: chat-default
  - name: Explicit chat
    model: chat-explicit
    roles: [chat, edit]
  - name: Autocomplete only
    model: autocomplete-only
    roles: [autocomplete]
  - name: Embeddings only
    model: embeddings-only
    roles: embeddings
autocompleteModels:
  - name: Legacy autocomplete
    model: legacy-autocomplete
embedOptions:
  model: nested-embedding
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "chat-default" || models[1].ID != "chat-explicit" {
		t.Fatalf("models = %#v, want only chat-capable entries", models)
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

func TestParseQwenConfigSupportsCurrentProviderShape(t *testing.T) {
	models, err := parseQwenConfig([]byte(`{
		"model":{"name":"claude-sonnet-4"},
		"modelProviders":{"anthropic":{"protocol":"anthropic","models":[
			{"id":"claude-sonnet-4","name":"Claude Sonnet 4","envKey":"ANTHROPIC_API_KEY"}
		]}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "claude-sonnet-4" || models[0].Label != "Claude Sonnet 4" || models[0].Provider != "anthropic" || !models[0].IsDefault {
		t.Fatalf("models = %#v", models)
	}
}

func TestConfigPathsHonorAgentOverrides(t *testing.T) {
	t.Run("crush", func(t *testing.T) {
		ctx := testConfigPathContext("/home/alice", "/repo", "linux", map[string]string{
			"CRUSH_GLOBAL_CONFIG": "/profiles/crush-config",
			"CRUSH_GLOBAL_DATA":   "/profiles/crush-data",
			"CRUSH_DATA_DIR":      "/legacy/crush-data",
			"XDG_DATA_HOME":       "/xdg/data",
		})
		paths := crushConfigPaths(ctx)
		assertConfigPath(t, paths, "/profiles/crush-config", "crush.json")
		assertConfigPath(t, paths, "/profiles/crush-data", "crush.json")
		assertConfigPath(t, paths, "/xdg/data/crush", "providers.json")
		assertConfigPath(t, paths, "/legacy/crush-data", "providers.json")
	})

	t.Run("opencode", func(t *testing.T) {
		ctx := testConfigPathContext("/home/alice", "/repo", "linux", map[string]string{
			"OPENCODE_CONFIG":     "/profiles/work.jsonc",
			"OPENCODE_CONFIG_DIR": "/profiles/opencode",
			"XDG_CONFIG_HOME":     "/xdg/config",
		})
		paths := openCodeConfigPaths(ctx)
		assertConfigPath(t, paths, "/xdg/config/opencode", "opencode.json")
		assertConfigPath(t, paths, "/profiles", "work.jsonc")
		assertConfigPath(t, paths, "/profiles/opencode", "opencode.jsonc")
		assertConfigPath(t, paths, "/etc/opencode", "opencode.json")
	})

	t.Run("continue", func(t *testing.T) {
		ctx := testConfigPathContext("/home/alice", "/repo", "windows", nil)
		paths := configSpecs["continue"].paths(ctx)
		assertConfigPath(t, paths, "/home/alice", filepath.Join(".continue", "config.yaml"))
		assertConfigPath(t, paths, "/repo", filepath.Join(".continue", "config.yaml"))
	})

	t.Run("qwen", func(t *testing.T) {
		ctx := testConfigPathContext("/home/alice", "/repo", "linux", map[string]string{
			"QWEN_HOME":                      "profiles/qwen",
			"QWEN_CODE_SYSTEM_DEFAULTS_PATH": "/managed/qwen/defaults.json",
			"QWEN_CODE_SYSTEM_SETTINGS_PATH": "/managed/qwen/locked.json",
		})
		paths := qwenConfigPaths(ctx)
		assertConfigPath(t, paths, "/managed/qwen", "defaults.json")
		assertConfigPath(t, paths, "/repo/profiles/qwen", "settings.json")
		assertConfigPath(t, paths, "/repo", filepath.Join(".qwen", "settings.json"))
		assertConfigPath(t, paths, "/managed/qwen", "locked.json")
	})

	t.Run("kimi", func(t *testing.T) {
		ctx := testConfigPathContext("/home/alice", "/repo", "linux", map[string]string{
			"KIMI_CODE_HOME": "/profiles/kimi",
		})
		paths := configSpecs["kimi"].paths(ctx)
		assertConfigPath(t, paths, "/profiles/kimi", "config.toml")
	})
}

func TestConfigPathsCoverPlatformManagedLocations(t *testing.T) {
	tests := []struct {
		goos         string
		programData  string
		opencodeRoot string
		qwenRoot     string
		crushRoot    string
	}{
		{goos: "darwin", opencodeRoot: "/Library/Application Support/opencode", qwenRoot: "/Library/Application Support/QwenCode", crushRoot: "/home/alice/.local/share/crush"},
		{goos: "linux", opencodeRoot: "/etc/opencode", qwenRoot: "/etc/qwen-code", crushRoot: "/home/alice/.local/share/crush"},
		{goos: "windows", programData: `C:\ProgramData`, opencodeRoot: `C:\ProgramData/opencode`, qwenRoot: `C:\ProgramData/qwen-code`, crushRoot: `C:\Users\alice/AppData/Local/crush`},
	}
	for _, test := range tests {
		t.Run(test.goos, func(t *testing.T) {
			env := map[string]string{"ProgramData": test.programData}
			ctx := testConfigPathContext(platformHome(test.goos), "", test.goos, env)
			if got := filepath.ToSlash(openCodeManagedConfigDir(ctx)); got != test.opencodeRoot {
				t.Fatalf("OpenCode managed root = %q, want %q", got, test.opencodeRoot)
			}
			if got := filepath.ToSlash(qwenSystemConfigDir(ctx)); got != test.qwenRoot {
				t.Fatalf("Qwen managed root = %q, want %q", got, test.qwenRoot)
			}
			assertConfigPath(t, crushConfigPaths(ctx), test.crushRoot, "providers.json")
		})
	}
}

func TestOpenCodeConfigPathsWalkToGitRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	workingDir := filepath.Join(root, "packages", "web")
	if err := os.MkdirAll(workingDir, 0o700); err != nil {
		t.Fatal(err)
	}
	paths := openCodeConfigPaths(testConfigPathContext(t.TempDir(), workingDir, "linux", nil))
	assertConfigPath(t, paths, root, "opencode.json")
	assertConfigPath(t, paths, filepath.Join(root, "packages"), "opencode.jsonc")
	assertConfigPath(t, paths, filepath.Join(workingDir, ".opencode"), "opencode.json")
}

func testConfigPathContext(home, workingDir, goos string, env map[string]string) configPathContext {
	return configPathContext{
		ctx:        context.Background(),
		home:       home,
		workingDir: workingDir,
		goos:       goos,
		getenv: func(name string) string {
			return env[name]
		},
	}
}

func assertConfigPath(t *testing.T, paths []configPath, root, name string) {
	t.Helper()
	wantRoot := filepath.ToSlash(filepath.Clean(root))
	wantName := filepath.ToSlash(filepath.Clean(name))
	for _, path := range paths {
		if filepath.ToSlash(filepath.Clean(path.root)) == wantRoot && filepath.ToSlash(filepath.Clean(path.name)) == wantName {
			return
		}
	}
	t.Fatalf("config path root=%q name=%q not found in %#v", root, name, paths)
}

func platformHome(goos string) string {
	if goos == "windows" {
		return `C:\Users\alice`
	}
	return "/home/alice"
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
	models, err := configModelsFromPaths(context.Background(), configSpecs["continue"], []configPath{
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

func TestConfigModelsFromPathsAppliesLaterDefaultPrecedence(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"model":"global/model","provider":{"global":{"models":{"model":{"name":"Global label"}}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "project.json"), []byte(`{"model":"project/model","provider":{"project":{"models":{"model":{"name":"Project label"}}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models, err := configModelsFromPaths(context.Background(), configSpecs["opencode"], []configPath{
		{root: dir, name: "global.json"},
		{root: dir, name: "project.json"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %#v", models)
	}
	defaults := 0
	for _, model := range models {
		if model.IsDefault {
			defaults++
			if model.ID != "project/model" {
				t.Fatalf("default = %#v, want project/model", model)
			}
		}
	}
	if defaults != 1 {
		t.Fatalf("defaults = %d in %#v, want one", defaults, models)
	}
}

func TestConfigModelsUsesProjectEnvironmentOverrides(t *testing.T) {
	home := t.TempDir()
	customDir := t.TempDir()
	custom := filepath.Join(customDir, "project-opencode.json")
	if err := os.WriteFile(custom, []byte(`{"model":"project/model"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	models, err := ConfigModels(context.Background(), "opencode", "/work/project", map[string]string{
		"OPENCODE_CONFIG": custom,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "project/model" || !models[0].IsDefault {
		t.Fatalf("models = %#v", models)
	}
}

func TestConfigModelsHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ConfigModels(ctx, "opencode", "", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("ConfigModels error = %v, want context canceled", err)
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
	if _, _, err := readBoundedConfig(context.Background(), configPath{root: filepath.Dir(path), name: filepath.Base(path)}); err == nil {
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
	if _, _, err := readBoundedConfig(context.Background(), configPath{root: dir, name: filepath.Base(link)}); err == nil {
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
	if _, _, err := readBoundedConfig(context.Background(), configPath{root: root, name: filepath.Join("linked", "config.json")}); err == nil {
		t.Fatal("readBoundedConfig: want symlink-component error")
	}
}

func TestReadBoundedConfigRejectsSymlinkRoot(t *testing.T) {
	parent := t.TempDir()
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(target, "config.json"), []byte(`{"model":"must-not-read"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(parent, "linked-root")
	if err := os.Symlink(target, root); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, _, err := readBoundedConfig(context.Background(), configPath{root: root, name: "config.json"}); err == nil {
		t.Fatal("readBoundedConfig: want symlink-root error")
	}
}

func TestReadBoundedConfigRejectsParentTraversal(t *testing.T) {
	root := t.TempDir()
	if _, _, err := readBoundedConfig(context.Background(), configPath{root: root, name: filepath.Join("..", "config.json")}); err == nil {
		t.Fatal("readBoundedConfig: want traversal error")
	}
}

func TestConfigVersionChangesWhenConfigMetadataChanges(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	path := filepath.Join(home, ".config", "opencode", "opencode.json")
	before := ConfigVersion(context.Background(), "opencode", "", nil)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"model":"zai/glm-5"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	after := ConfigVersion(context.Background(), "opencode", "", nil)
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
