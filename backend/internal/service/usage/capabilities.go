package usage

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// Parser version constants identify the normalizer contract for each usage source.
const (
	ClaudeJSONLParserVersion  = "claude-jsonl/v1"
	CodexRolloutParserVersion = "codex-rollout/v1"
)

// Capability is the parser contract used while registering a source.
type Capability struct {
	Supported     bool
	ParserVersion string
}

var capabilities = map[domain.AgentHarness]Capability{
	domain.HarnessClaudeCode: {
		Supported:     true,
		ParserVersion: ClaudeJSONLParserVersion,
	},
	domain.HarnessCodex: {
		Supported:     true,
		ParserVersion: CodexRolloutParserVersion,
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
