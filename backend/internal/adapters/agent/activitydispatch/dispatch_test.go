package activitydispatch

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Every deriver key must be a known harness name: SupportsHarness equates the
// two, so a token that drifts from its harness constant would silently report
// the harness as hook-less.
func TestDeriverTokensAreKnownHarnesses(t *testing.T) {
	for token := range Derivers {
		if !domain.AgentHarness(token).IsKnown() {
			t.Errorf("deriver token %q is not a known AgentHarness", token)
		}
	}
}

func TestSupportsHarness(t *testing.T) {
	for _, h := range []domain.AgentHarness{domain.HarnessCodex, domain.HarnessClaudeCode, domain.HarnessOpenCode, domain.HarnessKimi, domain.HarnessPi} {
		if !SupportsHarness(h) {
			t.Errorf("SupportsHarness(%q) = false, want true", h)
		}
	}
	// Harnesses whose adapters install no hooks must read as unsupported so
	// their silence never derives no_signal.
	for _, h := range []domain.AgentHarness{domain.HarnessAmp, domain.HarnessAider, domain.HarnessCrush, domain.AgentHarness("")} {
		if SupportsHarness(h) {
			t.Errorf("SupportsHarness(%q) = true, want false", h)
		}
	}
}

func TestDerivePi(t *testing.T) {
	tests := []struct {
		event  string
		want   domain.ActivityState
		wantOK bool
	}{
		{event: "session-start", want: "", wantOK: false},
		{event: "user-prompt-submit", want: domain.ActivityActive, wantOK: true},
		{event: "stop", want: domain.ActivityIdle, wantOK: true},
		{event: "session-end", want: domain.ActivityExited, wantOK: true},
	}
	for _, tt := range tests {
		got, ok := Derive("pi", tt.event, []byte(`{}`))
		if got != tt.want || ok != tt.wantOK {
			t.Fatalf("Derive(pi, %q) = (%q, %v), want (%q, %v)", tt.event, got, ok, tt.want, tt.wantOK)
		}
	}
}
