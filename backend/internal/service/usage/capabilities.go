package usage

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

const (
	ClaudeJSONLParserVersion  = "claude-jsonl/v1"
	CodexRolloutParserVersion = "codex-rollout/v1"
)

// VersionPolicy describes how a parser decides whether a native artifact is
// supported. V1 is primarily feature-detected instead of hard-coding broad CLI
// version gates.
type VersionPolicy string

const (
	VersionPolicyFeatureDetected VersionPolicy = "feature_detected"
	VersionPolicyUnsupported     VersionPolicy = "unsupported"
)

// FieldCapabilities documents which normalized fields a harness can provide.
type FieldCapabilities struct {
	Tokens          domain.UsageCoverage
	ReasoningTokens domain.UsageCoverage
	Cost            domain.UsageCoverage
}

// Capability is the static product contract for one harness's usage support.
type Capability struct {
	Harness           domain.AgentHarness
	Supported         bool
	ParserVersion     string
	SourceKinds       []domain.UsageSourceKind
	Fields            FieldCapabilities
	IncludesSubagents bool
	TokenConfidence   domain.TokenConfidence
	CostConfidence    domain.CostConfidence
	VersionPolicy     VersionPolicy
}

var capabilities = map[domain.AgentHarness]Capability{
	domain.HarnessClaudeCode: {
		Harness:       domain.HarnessClaudeCode,
		Supported:     true,
		ParserVersion: ClaudeJSONLParserVersion,
		SourceKinds: []domain.UsageSourceKind{
			domain.UsageSourceClaudeMain,
			domain.UsageSourceClaudeSubagent,
		},
		Fields: FieldCapabilities{
			Tokens:          domain.UsageCoverageComplete,
			ReasoningTokens: domain.UsageCoverageUnavailable,
			Cost:            domain.UsageCoveragePartial,
		},
		IncludesSubagents: true,
		TokenConfidence:   domain.TokenConfidenceParsed,
		CostConfidence:    domain.CostConfidenceEstimate,
		VersionPolicy:     VersionPolicyFeatureDetected,
	},
	domain.HarnessCodex: {
		Harness:       domain.HarnessCodex,
		Supported:     true,
		ParserVersion: CodexRolloutParserVersion,
		SourceKinds: []domain.UsageSourceKind{
			domain.UsageSourceCodexRollout,
		},
		Fields: FieldCapabilities{
			Tokens:          domain.UsageCoverageComplete,
			ReasoningTokens: domain.UsageCoverageComplete,
			Cost:            domain.UsageCoveragePartial,
		},
		IncludesSubagents: true,
		TokenConfidence:   domain.TokenConfidenceParsed,
		CostConfidence:    domain.CostConfidenceEstimate,
		VersionPolicy:     VersionPolicyFeatureDetected,
	},
}

// CapabilityFor returns the static usage capability for a harness. Unknown or
// unsupported harnesses return a stable unsupported capability.
func CapabilityFor(h domain.AgentHarness) Capability {
	if c, ok := capabilities[h]; ok {
		return cloneCapability(c)
	}
	return Capability{
		Harness:         h,
		Supported:       false,
		Fields:          FieldCapabilities{Tokens: domain.UsageCoverageUnavailable, ReasoningTokens: domain.UsageCoverageUnavailable, Cost: domain.UsageCoverageUnavailable},
		TokenConfidence: domain.TokenConfidenceNone,
		CostConfidence:  domain.CostConfidenceNone,
		VersionPolicy:   VersionPolicyUnsupported,
	}
}

// SupportedHarness reports whether the harness has a certified usage pipeline.
func SupportedHarness(h domain.AgentHarness) bool {
	return CapabilityFor(h).Supported
}

func cloneCapability(c Capability) Capability {
	if c.SourceKinds != nil {
		c.SourceKinds = append([]domain.UsageSourceKind(nil), c.SourceKinds...)
	}
	return c
}
