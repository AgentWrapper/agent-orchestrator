package usage

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCapabilityForSupportedHarnesses(t *testing.T) {
	tests := []struct {
		harness       domain.AgentHarness
		parserVersion string
	}{
		{
			harness:       domain.HarnessClaudeCode,
			parserVersion: ClaudeJSONLParserVersion,
		},
		{
			harness:       domain.HarnessCodex,
			parserVersion: CodexRolloutParserVersion,
		},
	}

	for _, tt := range tests {
		t.Run(string(tt.harness), func(t *testing.T) {
			c := CapabilityFor(tt.harness)
			if !c.Supported || c.ParserVersion != tt.parserVersion {
				t.Fatalf("capability = %+v", c)
			}
		})
	}
}

func TestCapabilityForUnsupportedHarnesses(t *testing.T) {
	for _, h := range domain.AllHarnesses {
		if h == domain.HarnessClaudeCode || h == domain.HarnessCodex {
			continue
		}
		c := CapabilityFor(h)
		if c.Supported {
			t.Fatalf("%s unexpectedly supported", h)
		}
		if c.ParserVersion != "" {
			t.Fatalf("%s parser version = %q, want empty", h, c.ParserVersion)
		}
	}
}
