package domain

// AgentHarness identifies which agent CLI/runtime a session drives.
type AgentHarness string

// Supported agent harnesses.
const (
	HarnessClaudeCode AgentHarness = "claude-code"
	HarnessCodex      AgentHarness = "codex"
	HarnessCodexFugu  AgentHarness = "codex-fugu"
	HarnessAider      AgentHarness = "aider"
	HarnessOpenCode   AgentHarness = "opencode"
	HarnessGrok       AgentHarness = "grok"
	HarnessDroid      AgentHarness = "droid"
	HarnessAmp        AgentHarness = "amp"
	HarnessAgy        AgentHarness = "agy"
	HarnessCrush      AgentHarness = "crush"
	HarnessCursor     AgentHarness = "cursor"
	HarnessQwen       AgentHarness = "qwen"
	HarnessCopilot    AgentHarness = "copilot"
	HarnessGoose      AgentHarness = "goose"
	HarnessAuggie     AgentHarness = "auggie"
	HarnessContinue   AgentHarness = "continue"
	HarnessDevin      AgentHarness = "devin"
	HarnessCline      AgentHarness = "cline"
	HarnessKimi       AgentHarness = "kimi"
	HarnessKiro       AgentHarness = "kiro"
	HarnessKilocode   AgentHarness = "kilocode"
	HarnessVibe       AgentHarness = "vibe"
	HarnessPi         AgentHarness = "pi"
	HarnessAutohand   AgentHarness = "autohand"
)

// AllHarnesses lists every supported harness. It is the canonical set used to
// validate user-supplied harness names (e.g. per-project role overrides).
var AllHarnesses = []AgentHarness{
	HarnessClaudeCode, HarnessCodex, HarnessCodexFugu, HarnessAider, HarnessOpenCode, HarnessGrok,
	HarnessDroid, HarnessAmp, HarnessAgy, HarnessCrush, HarnessCursor, HarnessQwen,
	HarnessCopilot, HarnessGoose, HarnessAuggie, HarnessContinue, HarnessDevin,
	HarnessCline, HarnessKimi, HarnessKiro, HarnessKilocode, HarnessVibe, HarnessPi,
	HarnessAutohand,
}

// IsKnown reports whether h is one of the supported harnesses.
func (h AgentHarness) IsKnown() bool {
	for _, k := range AllHarnesses {
		if h == k {
			return true
		}
	}
	return false
}

// HookReportingHarness returns the harness token an adapter's hook callback
// reports as. Most adapters report themselves; Claude-compatible delegates
// install Claude Code hooks and therefore report as claude-code.
func HookReportingHarness(h AgentHarness) AgentHarness {
	switch h {
	case HarnessGrok, HarnessContinue, HarnessDevin:
		return HarnessClaudeCode
	default:
		return h
	}
}

// ModelProvider maps a harness to the vendor family whose models it accepts.
// Only harnesses whose model namespace AO knows are classified; every other
// harness returns ProviderUnknown and is left unguarded, so its configured
// model is passed through untouched. This is what lets model resolution reject
// a cross-provider model (e.g. a Claude model on a Codex harness) without
// constraining the many harnesses AO has not mapped.
func (h AgentHarness) ModelProvider() ModelProvider {
	switch h {
	case HarnessClaudeCode:
		return ProviderAnthropic
	case HarnessCodex:
		return ProviderOpenAI
	case HarnessCodexFugu:
		return ProviderFugu
	default:
		return ProviderUnknown
	}
}
