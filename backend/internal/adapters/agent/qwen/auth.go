package qwen

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// AuthStatus returns the plugin's local authentication status.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	binary, err := p.ResolveBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if status, ok, err := qwenLocalAuthStatus(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if ok {
		return status, nil
	}
	return authprobe.CLIStatus(ctx, binary, nil)
}

var qwenAPIKeyEnvVars = []string{
	"QWEN_API_KEY",
	"BAILIAN_CODING_PLAN_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"REQUESTY_API_KEY",
	"DASHSCOPE_API_KEY",
	"ZAI_API_KEY",
}

func qwenLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, name := range qwenAPIKeyEnvVars {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if home == "" {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	return qwenAuthStatusFromSettings(filepath.Join(home, ".qwen", "settings.json"))
}

func qwenAuthStatusFromSettings(path string) (ports.AgentAuthStatus, bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return ports.AgentAuthStatusUnknown, false, nil
	}

	var root any
	if err := json.Unmarshal(data, &root); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if containsQwenAPIKey(root) {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func containsQwenAPIKey(value any) bool {
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			if strings.EqualFold(key, "apiKey") || strings.EqualFold(key, "apikey") {
				if stringSetting(child) != "" {
					return true
				}
				continue
			}
			if containsQwenAPIKey(child) {
				return true
			}
		}
	case []any:
		for _, child := range v {
			if containsQwenAPIKey(child) {
				return true
			}
		}
	}
	return false
}

func stringSetting(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	text = strings.TrimSpace(text)
	if text == "" || strings.EqualFold(text, "null") || strings.EqualFold(text, "none") {
		return ""
	}
	return text
}
