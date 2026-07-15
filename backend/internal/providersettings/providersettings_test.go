package providersettings

import "testing"

func TestFromEnvironmentReadsMiniMaxKeyWithoutPersistence(t *testing.T) {
	getenv := func(key string) string {
		if key == "MINIMAX_API_KEY" {
			return "  test-key  "
		}
		return ""
	}
	state := FromEnvironment(getenv)
	if state.MinimaxAPIKey != "test-key" {
		t.Fatalf("MinimaxAPIKey = %q, want trimmed environment value", state.MinimaxAPIKey)
	}
}

func TestClaudeEnvForModelIsCaseInsensitiveAndRequiresKey(t *testing.T) {
	for _, model := range []string{"MiniMax-M3", "minimax-M3", "MINIMAX-M3"} {
		env := ClaudeEnvForModel(model, State{MinimaxAPIKey: "test-key"})
		if env["ANTHROPIC_AUTH_TOKEN"] != "test-key" || env["ANTHROPIC_BASE_URL"] != minimaxBaseURL {
			t.Fatalf("model %q env = %#v", model, env)
		}
	}
	if env := ClaudeEnvForModel("sonnet", State{MinimaxAPIKey: "test-key"}); env != nil {
		t.Fatalf("sonnet env = %#v, want nil", env)
	}
	if env := ClaudeEnvForModel("MiniMax-M3", State{}); env != nil {
		t.Fatalf("empty-key env = %#v, want nil", env)
	}
}
