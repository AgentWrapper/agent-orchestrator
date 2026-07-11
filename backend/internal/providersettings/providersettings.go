package providersettings

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const minimaxBaseURL = "https://api.minimax.io/anthropic"

// State is the app-wide provider settings payload stored under the AO data dir.
// It is intentionally small for now: one MiniMax credential shared across
// projects, used only for Claude-compatible launches that explicitly select a
// MiniMax model.
type State struct {
	MinimaxAPIKey string `json:"minimaxApiKey,omitempty"`
}

// Path returns the app-wide provider settings file under the AO data dir.
func Path(dataDir string) string {
	return filepath.Join(dataDir, "provider-settings.json")
}

// Load reads provider settings from path. A missing file is not an error.
func Load(path string) (State, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return State{}, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("read provider settings: %w", err)
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return State{}, fmt.Errorf("parse provider settings: %w", err)
	}
	return state, nil
}

// ClaudeEnvForModel returns the Claude-compatible provider environment for a
// selected model. Project env should be layered on top of this so explicit
// project overrides still win.
func ClaudeEnvForModel(model string, state State) map[string]string {
	model = strings.TrimSpace(model)
	key := strings.TrimSpace(state.MinimaxAPIKey)
	if !strings.HasPrefix(strings.ToLower(model), "minimax-") || key == "" {
		return nil
	}
	return map[string]string{
		"ANTHROPIC_API_KEY":    key,
		"ANTHROPIC_AUTH_TOKEN": key,
		"ANTHROPIC_BASE_URL":   minimaxBaseURL,
	}
}
