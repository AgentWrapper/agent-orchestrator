package usage

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestSupportedHarness(t *testing.T) {
	tests := []struct {
		harness   domain.AgentHarness
		supported bool
	}{
		{harness: domain.HarnessClaudeCode, supported: true},
		{harness: domain.HarnessCodex, supported: true},
	}
	for _, harness := range domain.AllHarnesses {
		if harness != domain.HarnessClaudeCode && harness != domain.HarnessCodex {
			tests = append(tests, struct {
				harness   domain.AgentHarness
				supported bool
			}{harness: harness})
		}
	}

	for _, tt := range tests {
		t.Run(string(tt.harness), func(t *testing.T) {
			if got := SupportedHarness(tt.harness); got != tt.supported {
				t.Fatalf("SupportedHarness(%q) = %t, want %t", tt.harness, got, tt.supported)
			}
		})
	}
}
