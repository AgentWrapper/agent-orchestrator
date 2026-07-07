package vibe

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

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
	if status, ok, err := vibeLocalAuthStatus(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if ok {
		return status, nil
	}
	return authprobe.CLIStatus(ctx, binary, nil)
}

const (
	// This names the default env var Vibe reads; it is not a credential value.
	vibeDefaultAPIKeyEnvVar = "MISTRAL_API_KEY" //nolint:gosec // env var name, not a credential value
	vibeKeychainService     = "vibe"
)

func vibeLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if home == "" {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	vibeHome := os.Getenv("VIBE_HOME")
	if strings.TrimSpace(vibeHome) == "" {
		vibeHome = filepath.Join(home, ".vibe")
	}

	envVars, err := vibeAPIKeyEnvVars(filepath.Join(vibeHome, "config.toml"))
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, envVar := range envVars {
		if strings.TrimSpace(os.Getenv(envVar)) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
		if status, ok, err := vibeEnvFileAuthStatus(filepath.Join(vibeHome, ".env"), envVar); err != nil || ok {
			return status, ok, err
		}
	}
	if status, ok, err := vibeSessionLogAuthStatus(ctx, filepath.Join(vibeHome, "logs", "session")); err != nil || ok {
		return status, ok, err
	}
	for _, envVar := range envVars {
		if status, ok, err := vibeKeychainAuthStatus(ctx, envVar); err != nil || ok {
			return status, ok, err
		}
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func vibeAPIKeyEnvVars(configPath string) ([]string, error) {
	vars := []string{vibeDefaultAPIKeyEnvVar, "VIBE_CODE_API_KEY"}
	data, err := os.ReadFile(configPath)
	if os.IsNotExist(err) {
		return vars, nil
	}
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || strings.TrimSpace(key) != "api_key_env_var" {
			continue
		}
		envVar := strings.Trim(strings.TrimSpace(value), `"',`)
		if envVar != "" && !strings.EqualFold(envVar, "null") && !containsString(vars, envVar) {
			vars = append(vars, envVar)
		}
	}
	return vars, nil
}

func vibeEnvFileAuthStatus(path, envVar string) (ports.AgentAuthStatus, bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) != envVar {
			continue
		}
		if strings.Trim(strings.TrimSpace(value), `"'`) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
		return ports.AgentAuthStatusUnauthorized, true, nil
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func vibeKeychainAuthStatus(ctx context.Context, envVar string) (ports.AgentAuthStatus, bool, error) {
	if strings.TrimSpace(envVar) == "" {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	//nolint:gosec // invokes macOS security with fixed command and validated account/service arguments
	out, err := exec.CommandContext(probeCtx, "security", "find-generic-password", "-s", vibeKeychainService, "-a", envVar, "-w").CombinedOutput()
	if probeCtx.Err() != nil {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err == nil && strings.TrimSpace(string(out)) != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func vibeSessionLogAuthStatus(ctx context.Context, dir string) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	paths, err := filepath.Glob(filepath.Join(dir, "session_*", "messages.jsonl"))
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return ports.AgentAuthStatusUnknown, false, err
		}
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return ports.AgentAuthStatusUnknown, false, err
		}
		if vibeMessagesShowModelUse(string(data)) {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func vibeMessagesShowModelUse(text string) bool {
	return strings.Contains(text, `"role": "assistant"`) ||
		strings.Contains(text, `"role":"assistant"`) ||
		strings.Contains(text, `"reasoning_content"`) ||
		strings.Contains(text, `"session_completion_tokens"`)
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
