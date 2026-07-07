package domain

import "fmt"

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

// Effort sets an agent's reasoning-effort level. Providers expose overlapping
// but distinct vocabularies (Codex: minimal|low|medium|high; Claude Code:
// low|medium|high|xhigh|max), so the union is accepted here and each adapter
// maps or forwards the value its CLI understands.
type Effort string

// The reasoning-effort levels AO accepts (the union across providers).
const (
	EffortMinimal Effort = "minimal"
	EffortLow     Effort = "low"
	EffortMedium  Effort = "medium"
	EffortHigh    Effort = "high"
	EffortXHigh   Effort = "xhigh"
	EffortMax     Effort = "max"
)

// Valid reports whether e is empty (unset) or one of the known effort levels.
func (e Effort) Valid() bool {
	switch e {
	case "", EffortMinimal, EffortLow, EffortMedium, EffortHigh, EffortXHigh, EffortMax:
		return true
	default:
		return false
	}
}

// DefaultClaudeCodeModel is the model AO pins for a claude-code spawn that
// resolves to no explicit model at any level (project/role/per-harness/
// per-spawn). Without it, the claude-code adapter emits no `--model` flag and
// the CLI inherits the account's default model — which in this deployment is
// Fable, the most expensive model. A *default* must never land on the priciest
// model, so model resolution substitutes this instead. This constant is the
// single place the claude-code default is decided; change it here to change the
// default. An explicit selection (including an explicit "fable") is honored
// untouched — the substitution only fills the empty, unintended default.
const DefaultClaudeCodeModel = "opus"

// DefaultModelForHarness returns the model AO substitutes when a spawn of the
// given harness resolves to no explicit model. Only claude-code has a
// substitute today (see DefaultClaudeCodeModel), because only its account
// default is known to be an undesirable/expensive fallback; every other harness
// returns "" and keeps its own runtime/account default unchanged.
func DefaultModelForHarness(h AgentHarness) string {
	if h == HarnessClaudeCode {
		return DefaultClaudeCodeModel
	}
	return ""
}

// HarnessModel is the model + reasoning effort AO applies when a spawn resolves
// to a specific harness. It is the per-harness half of AgentConfig: because a
// model name is provider-specific, one scalar Model cannot be correct for every
// harness a project's worker mix might launch. Keyed by harness in
// AgentConfig.ModelByHarness, it lets resolution pick the provider-correct model
// for the harness actually chosen instead of leaking one model onto all of them.
type HarnessModel struct {
	Model  string `json:"model,omitempty"`
	Effort Effort `json:"effort,omitempty"`
}

// IsZero reports whether the per-harness entry carries no settings.
func (h HarnessModel) IsZero() bool { return h == HarnessModel{} }

// AgentConfig is the typed per-project agent configuration. It replaces the
// former free-form map so the fields are validated and the API/UI render a
// real form rather than arbitrary JSON. An empty value (IsZero) means unset.
type AgentConfig struct {
	// Model overrides the agent's default model (e.g. claude-opus-4-5). It is a
	// scalar fallback: because a model name is provider-specific, it only applies
	// to a resolved harness whose provider is compatible (see ModelByHarness).
	Model string `json:"model,omitempty"`
	// Effort is the default reasoning-effort level. Like Model it is a scalar
	// fallback; a per-harness ModelByHarness entry overrides it for that harness.
	Effort Effort `json:"effort,omitempty"`
	// Permissions sets the agent's starting permission mode. Empty is treated
	// like the adapter's default mode.
	Permissions PermissionMode `json:"permissions,omitempty"`
	// ModelByHarness pins the model (and effort) per resolved harness, so any
	// harness a spawn selects gets its provider-correct model without a manual
	// per-spawn override and without a cross-provider leak. A harness with no
	// entry falls back to the scalar Model when that model is provider-compatible
	// with the harness.
	ModelByHarness map[AgentHarness]HarnessModel `json:"modelByHarness,omitempty"`
}

// IsZero reports whether the config carries no settings, so storage can persist
// SQL NULL and resolution can skip an empty config. An empty (non-nil)
// ModelByHarness map carries no settings and counts as zero, which a
// reflect.DeepEqual against AgentConfig{} would miss.
func (c AgentConfig) IsZero() bool {
	return c.Model == "" && c.Effort == "" && c.Permissions == "" && len(c.ModelByHarness) == 0
}

// Validate rejects values outside the typed vocabulary so a bad config is
// refused when it is set (CLI/API) rather than silently dropped at spawn.
func (c AgentConfig) Validate() error {
	switch c.Permissions {
	case "", PermissionModeDefault, PermissionModeAcceptEdits, PermissionModeAuto, PermissionModeBypassPermissions:
	default:
		return fmt.Errorf("invalid permissions %q: want one of default, accept-edits, auto, bypass-permissions", c.Permissions)
	}
	if !c.Effort.Valid() {
		return fmt.Errorf("invalid effort %q: want one of minimal, low, medium, high, xhigh, max", c.Effort)
	}
	for harness, hm := range c.ModelByHarness {
		if !harness.IsKnown() {
			return fmt.Errorf("modelByHarness: unknown harness %q", harness)
		}
		if !hm.Effort.Valid() {
			return fmt.Errorf("modelByHarness[%s]: invalid effort %q", harness, hm.Effort)
		}
		// A model configured for a known-provider harness must belong to that
		// provider — this is the loud, early half of the cross-provider guard:
		// reject the misconfiguration when it is set rather than hang a spawn.
		if hp := harness.ModelProvider(); !ClassifyModelProvider(hm.Model).CompatibleWith(hp) {
			return fmt.Errorf("modelByHarness[%s]: model %q is not a %s model", harness, hm.Model, hp)
		}
	}
	return nil
}
