package kimi

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
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
	if status, ok, err := kimiLocalAuthStatus(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if ok {
		return status, nil
	}
	return authprobe.CLIStatus(ctx, binary, nil)
}

var kimiAPIKeyEnvVars = []string{
	"KIMI_API_KEY",
	"KIMI_CODE_API_KEY",
	"MOONSHOT_API_KEY",
}

func kimiLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, name := range kimiAPIKeyEnvVars {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}
	home, ok := kimiCodeHome()
	if !ok {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	return kimiConfigAuthStatus(filepath.Join(home, "config.toml"))
}

func kimiCodeHome() (string, bool) {
	if home := strings.TrimSpace(os.Getenv("KIMI_CODE_HOME")); home != "" {
		return home, true
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", false
	}
	return filepath.Join(home, ".kimi-code"), true
}

var kimiAPIKeyLineRE = regexp.MustCompile(`(?m)^\s*api_key\s*=\s*("([^"]*)"|'([^']*)'|([^\s#]+))`)

func kimiConfigAuthStatus(path string) (ports.AgentAuthStatus, bool, error) {
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
	matches := kimiAPIKeyLineRE.FindAllStringSubmatch(string(data), -1)
	if len(matches) == 0 {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	for _, match := range matches {
		for _, group := range match[2:] {
			if strings.TrimSpace(group) != "" {
				return ports.AgentAuthStatusAuthorized, true, nil
			}
		}
	}
	return ports.AgentAuthStatusUnauthorized, true, nil
}
