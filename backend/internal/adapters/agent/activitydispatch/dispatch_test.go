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
	for _, h := range []domain.AgentHarness{domain.HarnessCodex, domain.HarnessClaudeCode, domain.HarnessGrok, domain.HarnessOpenCode, domain.HarnessKimi} {
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

// Kimi installs the tool-use trio (issue #2814): mid-turn tool traffic must
// derive active so a working session does not read Idle after its first Stop.
func TestKimiDerivesMidTurnToolActivity(t *testing.T) {
	tests := []struct {
		name    string
		event   string
		payload string
		want    domain.ActivityState
	}{
		{"pre tool use", "pre-tool-use", `{"tool_name":"Read","tool_call_id":"tool_1"}`, domain.ActivityActive},
		{"post tool use", "post-tool-use", `{"tool_name":"Read","tool_call_id":"tool_1"}`, domain.ActivityActive},
		{"post tool use failure", "post-tool-use-failure", `{"tool_name":"Bash","tool_call_id":"tool_2"}`, domain.ActivityActive},
		{"stop", "stop", `{}`, domain.ActivityIdle},
		{"permission request", "permission-request", `{}`, domain.ActivityWaitingInput},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := Derive("kimi", tt.event, []byte(tt.payload))
			if !ok {
				t.Fatalf("Derive(kimi, %q) ok=false, want true", tt.event)
			}
			if got != tt.want {
				t.Fatalf("Derive(kimi, %q) = %q, want %q", tt.event, got, tt.want)
			}
		})
	}
}

func TestGrokDerivesClaudeCompatibleActivity(t *testing.T) {
	tests := []struct {
		name    string
		event   string
		payload string
		want    domain.ActivityState
	}{
		{"permission request", "permission-request", `{}`, domain.ActivityBlocked},
		{"idle notification", "notification", `{"notification_type":"idle_prompt"}`, domain.ActivityIdle},
		{"session end", "session-end", `{}`, domain.ActivityExited},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := Derive("grok", tt.event, []byte(tt.payload))
			if !ok {
				t.Fatalf("Derive(grok, %q) ok=false, want true", tt.event)
			}
			if got != tt.want {
				t.Fatalf("Derive(grok, %q) = %q, want %q", tt.event, got, tt.want)
			}
		})
	}
}
