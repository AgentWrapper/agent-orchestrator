package usage

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// Capability identifies whether a harness has a certified usage parser.
type Capability struct {
	Supported bool
}

var capabilities = map[domain.AgentHarness]Capability{
	domain.HarnessClaudeCode: {
		Supported: true,
	},
	domain.HarnessCodex: {
		Supported: true,
	},
}

// CapabilityFor returns the parser capability for a harness.
func CapabilityFor(h domain.AgentHarness) Capability {
	if c, ok := capabilities[h]; ok {
		return c
	}
	return Capability{}
}

// SupportedHarness reports whether the harness has a certified usage pipeline.
func SupportedHarness(h domain.AgentHarness) bool {
	return CapabilityFor(h).Supported
}
