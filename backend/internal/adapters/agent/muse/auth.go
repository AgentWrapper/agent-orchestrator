package muse

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// AuthStatus reports whether Muse can see a configured provider credential.
// Muse also supports unauthenticated local Ollama endpoints, so an absent key is
// unknown rather than unauthorized.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	if _, err := p.ResolveBinary(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if status, ok, err := museLocalAuthStatus(ctx); err != nil || ok {
		return status, err
	}
	return ports.AgentAuthStatusUnknown, nil
}

// These are Muse's built-in provider variables plus the variables its model
// picker documents for supported OpenAI-compatible providers.
var museAPIKeyEnvVars = []string{
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"ANTHROPIC_API_KEY",
	"CEREBRAS_API_KEY",
	"SYN_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"ARK_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"COHERE_API_KEY",
	"DEEPSEEK_API_KEY",
	"TOGETHER_API_KEY",
	"FIREWORKS_API_KEY",
	"XAI_API_KEY",
	"PERPLEXITY_API_KEY",
	"HUGGINGFACE_API_KEY",
}

func museLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, name := range museAPIKeyEnvVars {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}

	path, ok := museConfigPath()
	if !ok {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	return museConfigAuthStatus(path)
}

// museConfigPath mirrors Muse's path selection: an explicitly configured XDG
// config root wins, otherwise all state defaults to ~/.muse.
func museConfigPath() (string, bool) {
	if root := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); root != "" {
		return filepath.Join(root, "muse", "muse.cfg"), true
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", false
	}
	return filepath.Join(home, ".muse", "muse.cfg"), true
}

func museConfigAuthStatus(path string) (ports.AgentAuthStatus, bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // user-selected Muse config path
	if os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}

	knownKeys := make(map[string]struct{}, len(museAPIKeyEnvVars))
	for _, name := range museAPIKeyEnvVars {
		knownKeys[name] = struct{}{}
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		if _, ok := knownKeys[strings.ToUpper(strings.TrimSpace(key))]; !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(strings.SplitN(value, "#", 2)[0]), `"'`)
		if value != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}
	return ports.AgentAuthStatusUnknown, false, nil
}
