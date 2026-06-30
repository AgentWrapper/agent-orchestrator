package autohand

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// AuthStatus returns the plugin's local authentication status.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	return autohandConfigAuthStatus(autohandConfigPath())
}

func autohandConfigAuthStatus(configPath string) (ports.AgentAuthStatus, error) {
	data, err := os.ReadFile(configPath) //nolint:gosec // path is the user's own Autohand config
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ports.AgentAuthStatusUnknown, nil
		}
		return ports.AgentAuthStatusUnknown, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return ports.AgentAuthStatusUnknown, nil
	}

	var config map[string]json.RawMessage
	if err := json.Unmarshal(data, &config); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}

	authReady, authKnown := autohandCloudAuthReady(config)
	if authReady {
		return ports.AgentAuthStatusAuthorized, nil
	}
	if authKnown {
		return ports.AgentAuthStatusUnauthorized, nil
	}
	return ports.AgentAuthStatusUnknown, nil
}

func autohandCloudAuthReady(config map[string]json.RawMessage) (ready, known bool) {
	authRaw, ok := config["auth"]
	if !ok {
		return false, false
	}
	var auth struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(authRaw, &auth); err != nil {
		return false, false
	}
	return usableSecret(auth.Token), true
}

func usableSecret(value string) bool {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		return false
	}
	switch strings.ToLower(normalized) {
	case "api key", "apikey", "your api key", "your-api-key", "your_api_key", "token", "your token", "your-token", "your_token", "changeme", "change-me", "replace-me", "replace_me":
		return false
	default:
		return true
	}
}
