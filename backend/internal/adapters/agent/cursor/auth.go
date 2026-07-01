package cursor

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
	if status, err := cursorCLIAuthStatus(ctx, binary); err == nil && status != ports.AgentAuthStatusUnknown {
		return status, nil
	} else if err != nil && ctx.Err() != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if status, ok, err := cursorLocalAuthStatus(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if ok {
		return status, nil
	}
	return authprobe.CLIStatus(ctx, binary, nil)
}

func cursorCLIAuthStatus(ctx context.Context, binary string) (ports.AgentAuthStatus, error) {
	return authprobe.CLIStatus(ctx, binary, [][]string{{"status"}})
}

func cursorLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
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
	return cursorConfigAuthStatus(filepath.Join(home, ".cursor", "cli-config.json"))
}

func cursorConfigAuthStatus(path string) (ports.AgentAuthStatus, bool, error) {
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
	type cursorConfig struct {
		AuthInfo struct {
			Email       string `json:"email"`
			DisplayName string `json:"displayName"`
			UserID      any    `json:"userId"`
			AuthID      string `json:"authId"`
		} `json:"authInfo"`
	}

	var cfgs []cursorConfig
	if err := json.Unmarshal(data, &cfgs); err != nil {
		var cfg cursorConfig
		if err := json.Unmarshal(data, &cfg); err != nil {
			return ports.AgentAuthStatusUnknown, false, err
		}
		cfgs = []cursorConfig{cfg}
	}
	for _, cfg := range cfgs {
		if cursorConfigHasIdentity(cfg) {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func cursorConfigHasIdentity(cfg struct {
	AuthInfo struct {
		Email       string `json:"email"`
		DisplayName string `json:"displayName"`
		UserID      any    `json:"userId"`
		AuthID      string `json:"authId"`
	} `json:"authInfo"`
}) bool {
	if cfg.AuthInfo.UserID != nil {
		switch v := cfg.AuthInfo.UserID.(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return true
			}
		default:
			return true
		}
	}
	if strings.TrimSpace(cfg.AuthInfo.AuthID) != "" ||
		strings.TrimSpace(cfg.AuthInfo.Email) != "" ||
		strings.TrimSpace(cfg.AuthInfo.DisplayName) != "" {
		return true
	}
	return false
}
