package domain

import (
	"fmt"
	"reflect"
	"strings"
)

// PermissionMode controls how much review an agent requires before acting. It
// lives in domain (not ports) so the typed AgentConfig can carry it; ports
// re-exports it as a type alias so agent adapters keep referring to
// ports.PermissionMode unchanged.
type PermissionMode string

// The permission modes adapters map onto their agent's native approval flags.
const (
	// PermissionModeDefault is special: adapters choose their own baseline
	// behavior for it. Most defer to the agent's own config; some managed
	// adapters may map it to a safer non-interactive default.
	PermissionModeDefault           PermissionMode = "default"
	PermissionModeAcceptEdits       PermissionMode = "accept-edits"
	PermissionModeAuto              PermissionMode = "auto"
	PermissionModeBypassPermissions PermissionMode = "bypass-permissions"
)

// MCPMode controls how an adapter should source Model Context Protocol servers.
// Empty means "use the adapter's role-specific default"; Claude Code maps that
// to no MCP servers for workers and inherited user config for orchestrators.
type MCPMode string

const (
	// MCPModeInherit lets the adapter load its normal MCP configuration.
	MCPModeInherit MCPMode = "inherit"
	// MCPModeNone disables MCP servers for the session.
	MCPModeNone MCPMode = "none"
	// MCPModeCustom loads an explicit MCP config file or inline server map.
	MCPModeCustom MCPMode = "custom"
)

// MCPServerConfig is one native MCP server definition. Its inner shape is
// agent-specific (Claude Code accepts command/args/env, HTTP URLs, and other
// transport options), so AO validates the server names and stores the object
// without trying to own each adapter's schema.
type MCPServerConfig map[string]any

// MCPConfig is the typed per-agent MCP selection. A custom config can either
// reference a repo-relative config file or inline a map of server definitions.
type MCPConfig struct {
	Mode       MCPMode                    `json:"mode,omitempty"`
	ConfigFile string                     `json:"configFile,omitempty"`
	Servers    map[string]MCPServerConfig `json:"servers,omitempty"`
}

// AgentConfig is the typed per-project agent configuration. It replaces the
// former free-form map so the fields are validated and the API/UI render a
// real form rather than arbitrary JSON. An empty value (IsZero) means unset.
type AgentConfig struct {
	// Model overrides the agent's default model (e.g. claude-opus-4-5).
	Model string `json:"model,omitempty"`
	// Permissions sets the agent's starting permission mode. Empty is treated
	// like the adapter's default mode.
	Permissions PermissionMode `json:"permissions,omitempty"`
	// MCP controls which Model Context Protocol servers the agent can see.
	// Empty means the adapter decides its role-specific default.
	MCP MCPConfig `json:"mcp,omitempty"`
}

// IsZero reports whether the MCP config carries no settings.
func (c MCPConfig) IsZero() bool {
	return reflect.DeepEqual(c, MCPConfig{})
}

// IsZero reports whether the config carries no settings, so storage can persist
// SQL NULL and resolution can skip an empty config.
func (c AgentConfig) IsZero() bool {
	return reflect.DeepEqual(c, AgentConfig{})
}

// Validate rejects values outside the typed vocabulary so a bad config is
// refused when it is set (CLI/API) rather than silently dropped at spawn.
func (c AgentConfig) Validate() error {
	switch c.Permissions {
	case "", PermissionModeDefault, PermissionModeAcceptEdits, PermissionModeAuto, PermissionModeBypassPermissions:
	default:
		return fmt.Errorf("invalid permissions %q: want one of default, accept-edits, auto, bypass-permissions", c.Permissions)
	}
	if err := c.MCP.Validate(); err != nil {
		return fmt.Errorf("mcp: %w", err)
	}
	return nil
}

// Validate rejects invalid MCP modes and source combinations.
func (c MCPConfig) Validate() error {
	switch c.Mode {
	case "", MCPModeInherit, MCPModeNone, MCPModeCustom:
	default:
		return fmt.Errorf("invalid mode %q: want one of inherit, none, custom", c.Mode)
	}

	hasConfigFile := strings.TrimSpace(c.ConfigFile) != ""
	hasServers := len(c.Servers) > 0
	if hasConfigFile {
		if err := validateRepoRelative(c.ConfigFile); err != nil {
			return fmt.Errorf("configFile: %w", err)
		}
	}
	if hasConfigFile && hasServers {
		return fmt.Errorf("configFile and servers are mutually exclusive")
	}
	for name, server := range c.Servers {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("servers: server names must not be blank")
		}
		if server == nil {
			return fmt.Errorf("servers.%s: config object is required", name)
		}
	}

	switch c.Mode {
	case MCPModeInherit, MCPModeNone:
		if hasConfigFile || hasServers {
			return fmt.Errorf("mode %q cannot include configFile or servers", c.Mode)
		}
	case MCPModeCustom:
		if !hasConfigFile && !hasServers {
			return fmt.Errorf("mode custom requires configFile or servers")
		}
	case "":
		// A source implies custom mode even when mode is omitted.
	}
	return nil
}
