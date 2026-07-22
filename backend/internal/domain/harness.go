package domain

// AgentHarness identifies which agent CLI/runtime a session drives.
type AgentHarness string

// Supported agent harnesses.
const (
	HarnessClaudeCode AgentHarness = "claude-code"
	HarnessCodex      AgentHarness = "codex"
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
	// HarnessFake is a deterministic, LLM-free harness used by e2e tests to
	// drive the session lifecycle on a scripted timeline (no network, no tokens).
	HarnessFake AgentHarness = "fake"
)

// AllHarnesses lists every supported harness. It is the canonical set used to
// validate user-supplied harness names (e.g. per-project role overrides).
var AllHarnesses = []AgentHarness{
	HarnessClaudeCode, HarnessCodex, HarnessAider, HarnessOpenCode, HarnessGrok,
	HarnessDroid, HarnessAmp, HarnessAgy, HarnessCrush, HarnessCursor, HarnessQwen,
	HarnessCopilot, HarnessGoose, HarnessAuggie, HarnessContinue, HarnessDevin,
	HarnessCline, HarnessKimi, HarnessKiro, HarnessKilocode, HarnessVibe, HarnessPi,
	HarnessAutohand, HarnessFake,
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
