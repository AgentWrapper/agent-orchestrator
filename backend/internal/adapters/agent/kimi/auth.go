package kimi

import (
	"context"
	"encoding/json"
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

const (
	kimiCredentialsDirName = "credentials"
	kimiOAuthFileName      = "kimi-code.json"
)

type kimiOAuthCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
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
	configStatus, configKnown, err := kimiConfigAuthStatus(filepath.Join(home, "config.toml"))
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if configKnown && configStatus == ports.AgentAuthStatusAuthorized {
		return configStatus, true, nil
	}
	if status, ok, err := kimiOAuthCredentialAuthStatus(ctx, kimiOAuthCredentialPath(home)); err != nil || ok {
		return status, ok, err
	}
	return configStatus, configKnown, nil
}

func kimiOAuthCredentialPath(home string) string {
	return filepath.Join(home, kimiCredentialsDirName, kimiOAuthFileName)
}

func kimiOAuthCredentialAuthStatus(ctx context.Context, path string) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	data, err := os.ReadFile(path) //nolint:gosec // Kimi credential path under the current user's home.
	if os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if kimiOAuthCredentialAuthorized(data) {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	return ports.AgentAuthStatusUnauthorized, true, nil
}

func kimiOAuthCredentialAuthorized(data []byte) bool {
	var credential kimiOAuthCredential
	if err := json.Unmarshal(data, &credential); err != nil {
		return false
	}
	return strings.TrimSpace(credential.AccessToken) != "" || strings.TrimSpace(credential.RefreshToken) != ""
}

func kimiCodeHome() (string, bool) {
	if home := strings.TrimSpace(os.Getenv(kimiCodeHomeEnv)); home != "" {
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
