package controllers

import (
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestActivityDecisionPreservesOptionIndexes(t *testing.T) {
	longOption := strings.Repeat("x", 300)
	decision, ok := activityDecision(&SessionDecisionPayload{
		Kind:     domain.DecisionKindQuestion,
		Question: "Choose",
		Options:  []string{"Ship now", longOption, "  "},
	})
	if !ok {
		t.Fatal("activityDecision ok = false, want true")
	}
	if len(decision.Options) != 3 {
		t.Fatalf("options = %#v, want three labels preserving indexes", decision.Options)
	}
	if decision.Options[0] != "Ship now" || len(decision.Options[1]) > 256 || decision.Options[2] != "Option 3" {
		t.Fatalf("options = %#v, want original/truncated/placeholder labels", decision.Options)
	}
}
