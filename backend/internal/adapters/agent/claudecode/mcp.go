package claudecode

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const claudeMCPConfigFileName = "ao-mcp.json"

type resolvedClaudeMCPConfig struct {
	mode       domain.MCPMode
	configPath string
	servers    map[string]domain.MCPServerConfig
	writeFile  bool
}

func appendClaudeMCPFlags(cmd *[]string, cfg ports.LaunchConfig) error {
	resolved, err := resolveClaudeMCPConfig(cfg)
	if err != nil {
		return err
	}
	if resolved.mode == domain.MCPModeInherit {
		return nil
	}
	*cmd = append(*cmd, "--mcp-config", resolved.configPath, "--strict-mcp-config")
	return nil
}

func ensureClaudeMCPConfig(cfg ports.LaunchConfig) error {
	if err := cfg.Config.Validate(); err != nil {
		return fmt.Errorf("claude-code: %w", err)
	}
	resolved, err := resolveClaudeMCPConfig(cfg)
	if err != nil {
		return err
	}
	if !resolved.writeFile {
		return nil
	}
	payload := struct {
		MCPServers map[string]domain.MCPServerConfig `json:"mcpServers"`
	}{
		MCPServers: resolved.servers,
	}
	if payload.MCPServers == nil {
		payload.MCPServers = map[string]domain.MCPServerConfig{}
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("claude-code: encode MCP config: %w", err)
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(resolved.configPath), 0o750); err != nil {
		return fmt.Errorf("claude-code: create MCP config dir: %w", err)
	}
	if err := hookutil.AtomicWriteFile(resolved.configPath, data, 0o600); err != nil {
		return fmt.Errorf("claude-code: write MCP config: %w", err)
	}
	if err := ensureClaudeSettingsGitignore(filepath.Dir(resolved.configPath)); err != nil {
		return fmt.Errorf("claude-code: gitignore MCP config: %w", err)
	}
	return nil
}

func resolveClaudeMCPConfig(cfg ports.LaunchConfig) (resolvedClaudeMCPConfig, error) {
	mcp := cfg.Config.MCP
	mode := mcp.Mode
	if mode == "" {
		switch {
		case strings.TrimSpace(mcp.ConfigFile) != "" || len(mcp.Servers) > 0:
			mode = domain.MCPModeCustom
		case cfg.Kind == domain.KindWorker:
			mode = domain.MCPModeNone
		default:
			mode = domain.MCPModeInherit
		}
	}

	resolved := resolvedClaudeMCPConfig{mode: mode}
	switch mode {
	case domain.MCPModeInherit:
		return resolved, nil
	case domain.MCPModeNone:
		path, err := claudeManagedMCPConfigPath(cfg.WorkspacePath)
		if err != nil {
			return resolvedClaudeMCPConfig{}, err
		}
		resolved.configPath = path
		resolved.servers = map[string]domain.MCPServerConfig{}
		resolved.writeFile = true
		return resolved, nil
	case domain.MCPModeCustom:
		if configFile := strings.TrimSpace(mcp.ConfigFile); configFile != "" {
			workspace, err := requireWorkspacePath(cfg.WorkspacePath)
			if err != nil {
				return resolvedClaudeMCPConfig{}, err
			}
			resolved.configPath = filepath.Clean(filepath.Join(workspace, filepath.FromSlash(configFile)))
			return resolved, nil
		}
		path, err := claudeManagedMCPConfigPath(cfg.WorkspacePath)
		if err != nil {
			return resolvedClaudeMCPConfig{}, err
		}
		resolved.configPath = path
		resolved.servers = mcp.Servers
		resolved.writeFile = true
		return resolved, nil
	default:
		return resolvedClaudeMCPConfig{}, fmt.Errorf("claude-code: unsupported MCP mode %q", mode)
	}
}

func claudeManagedMCPConfigPath(workspacePath string) (string, error) {
	workspace, err := requireWorkspacePath(workspacePath)
	if err != nil {
		return "", err
	}
	return filepath.Join(workspace, claudeSettingsDirName, claudeMCPConfigFileName), nil
}

func requireWorkspacePath(workspacePath string) (string, error) {
	trimmed := strings.TrimSpace(workspacePath)
	if trimmed == "" {
		return "", fmt.Errorf("claude-code: workspace path is required for MCP config")
	}
	return trimmed, nil
}

func ensureClaudeSettingsGitignore(settingsDir string) error {
	return hookutil.EnsureWorkspaceGitignore(settingsDir, claudeSettingsFileName, claudeMCPConfigFileName)
}
