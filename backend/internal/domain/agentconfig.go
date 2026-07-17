package domain

import (
	"fmt"
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

// AgentConfig is the typed per-project agent configuration. It replaces the
// former free-form map so the fields are validated and the API/UI render a
// real form rather than arbitrary JSON. An empty value (IsZero) means unset.
type AgentConfig struct {
	// Model overrides the agent's default model (e.g. claude-opus-4-5).
	Model string `json:"model,omitempty"`
	// ReasoningEffort pins the agent's reasoning level for the session.
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	// FastMode pins whether the provider's fast service tier is enabled.
	FastMode bool `json:"fastMode,omitempty"`
	// ReviewModel pins a distinct reviewer model. Empty means same-model review.
	ReviewModel string `json:"reviewModel,omitempty"`
	// AllowNativeSubagents controls native in-process collaboration workers.
	AllowNativeSubagents bool `json:"allowNativeSubagents,omitempty"`
	// Permissions sets the agent's starting permission mode. Empty is treated
	// like the adapter's default mode.
	Permissions PermissionMode `json:"permissions,omitempty"`
}

// IsZero reports whether the config carries no settings, so storage can persist
// SQL NULL and resolution can skip an empty config.
func (c AgentConfig) IsZero() bool {
	return c == AgentConfig{}
}

// Validate rejects values outside the typed vocabulary so a bad config is
// refused when it is set (CLI/API) rather than silently dropped at spawn.
func (c AgentConfig) Validate() error {
	if strings.TrimSpace(c.ReasoningEffort) != c.ReasoningEffort || strings.ContainsAny(c.ReasoningEffort, "\r\n") {
		return fmt.Errorf("invalid reasoning effort %q", c.ReasoningEffort)
	}
	switch c.Permissions {
	case "", PermissionModeDefault, PermissionModeAcceptEdits, PermissionModeAuto, PermissionModeBypassPermissions:
		return nil
	default:
		return fmt.Errorf("invalid permissions %q: want one of default, accept-edits, auto, bypass-permissions", c.Permissions)
	}
}
