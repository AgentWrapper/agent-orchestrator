package usage

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCapabilityForSupportedHarnesses(t *testing.T) {
	tests := []struct {
		harness       domain.AgentHarness
		parserVersion string
		sourceKinds   []domain.UsageSourceKind
		reasoning     domain.UsageCoverage
	}{
		{
			harness:       domain.HarnessClaudeCode,
			parserVersion: ClaudeJSONLParserVersion,
			sourceKinds:   []domain.UsageSourceKind{domain.UsageSourceClaudeMain, domain.UsageSourceClaudeSubagent},
			reasoning:     domain.UsageCoverageUnavailable,
		},
		{
			harness:       domain.HarnessCodex,
			parserVersion: CodexRolloutParserVersion,
			sourceKinds:   []domain.UsageSourceKind{domain.UsageSourceCodexRollout},
			reasoning:     domain.UsageCoverageComplete,
		},
	}

	for _, tt := range tests {
		t.Run(string(tt.harness), func(t *testing.T) {
			c := CapabilityFor(tt.harness)
			if !c.Supported || c.Harness != tt.harness || c.ParserVersion != tt.parserVersion {
				t.Fatalf("capability = %+v", c)
			}
			if c.TokenConfidence != domain.TokenConfidenceParsed || c.CostConfidence != domain.CostConfidenceEstimate {
				t.Fatalf("confidence = %s/%s, want parsed_jsonl/api_pricing_estimate", c.TokenConfidence, c.CostConfidence)
			}
			if c.Fields.Tokens != domain.UsageCoverageComplete || c.Fields.ReasoningTokens != tt.reasoning {
				t.Fatalf("fields = %+v", c.Fields)
			}
			if len(c.SourceKinds) != len(tt.sourceKinds) {
				t.Fatalf("source kinds = %v, want %v", c.SourceKinds, tt.sourceKinds)
			}
			for i, want := range tt.sourceKinds {
				if c.SourceKinds[i] != want {
					t.Fatalf("source kinds = %v, want %v", c.SourceKinds, tt.sourceKinds)
				}
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
		if c.TokenConfidence != domain.TokenConfidenceNone || c.CostConfidence != domain.CostConfidenceNone {
			t.Fatalf("%s confidence = %s/%s, want unavailable/unavailable", h, c.TokenConfidence, c.CostConfidence)
		}
		if c.Fields.Tokens != domain.UsageCoverageUnavailable ||
			c.Fields.ReasoningTokens != domain.UsageCoverageUnavailable ||
			c.Fields.Cost != domain.UsageCoverageUnavailable {
			t.Fatalf("%s fields = %+v, want unavailable", h, c.Fields)
		}
	}
}

func TestCapabilityForReturnsCopy(t *testing.T) {
	c := CapabilityFor(domain.HarnessClaudeCode)
	c.SourceKinds[0] = domain.UsageSourceCodexRollout

	again := CapabilityFor(domain.HarnessClaudeCode)
	if again.SourceKinds[0] != domain.UsageSourceClaudeMain {
		t.Fatalf("CapabilityFor returned mutable shared source kinds: %v", again.SourceKinds)
	}
}
