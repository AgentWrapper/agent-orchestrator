package amp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
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
	if status, ok, err := ampLocalAuthStatus(ctx); err != nil || ok {
		return status, err
	}
	return ampUsageAuthStatus(ctx, binary)
}

func ampLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if strings.TrimSpace(os.Getenv("AMP_API_KEY")) != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	status, ok, err := ampSettingsAuthStatus(ampSettingsPath())
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	return status, ok, nil
}

func ampSettingsPath() string {
	if path := strings.TrimSpace(os.Getenv("AMP_SETTINGS_FILE")); path != "" {
		return expandHome(path)
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".config", "amp", "settings.json")
	}
	return ""
}

func ampSettingsAuthStatus(path string) (ports.AgentAuthStatus, bool, error) {
	if path == "" {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ports.AgentAuthStatusUnknown, false, nil
		}
		return ports.AgentAuthStatusUnknown, false, err
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, key := range []string{"amp.apiKey", "amp.api_key", "apiKey", "api_key"} {
		if value, ok := settings[key]; ok {
			if strings.TrimSpace(stringValue(value)) != "" {
				return ports.AgentAuthStatusAuthorized, true, nil
			}
			return ports.AgentAuthStatusUnauthorized, true, nil
		}
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func ampUsageAuthStatus(ctx context.Context, binary string) (ports.AgentAuthStatus, error) {
	if binary == "" {
		return ports.AgentAuthStatusUnknown, nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	out, err := authprobe.CmdRunner(probeCtx, binary, "usage", "--no-color")
	if probeCtx.Err() != nil {
		return ports.AgentAuthStatusUnknown, probeCtx.Err()
	}
	if status := authprobe.StatusFromText(string(out)); status != ports.AgentAuthStatusUnknown {
		return status, nil
	}
	if err == nil {
		return ports.AgentAuthStatusAuthorized, nil
	}
	return ports.AgentAuthStatusUnknown, nil
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	default:
		return ""
	}
}

func expandHome(path string) string {
	if path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
	}
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~/"))
		}
	}
	return path
}
