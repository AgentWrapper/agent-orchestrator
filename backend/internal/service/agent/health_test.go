package agent

import (
	"context"
	"testing"

	agentregistry "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestHarnessHealthProbesRequestedHarnesses(t *testing.T) {
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		harnessAuthAgent("codex", "Codex", ports.AgentAuthStatusAuthorized, nil),
		harnessAuthAgent("claude-code", "Claude Code", ports.AgentAuthStatusUnauthorized, nil),
		harnessAgent("missing", "Missing", ports.ErrAgentBinaryNotFound),
	})

	got, err := svc.HarnessHealth(context.Background(), []string{"claude-code", "codex", "missing", "not-registered"})
	if err != nil {
		t.Fatalf("HarnessHealth: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("got %d probes, want 4 (order preserved)", len(got))
	}
	// Order preserved.
	if got[0].ID != "claude-code" || got[1].ID != "codex" || got[2].ID != "missing" || got[3].ID != "not-registered" {
		t.Fatalf("order not preserved: %#v", got)
	}
	if !got[1].Installed || got[1].AuthStatus != ports.AgentAuthStatusAuthorized {
		t.Errorf("codex = %#v, want installed+authorized", got[1])
	}
	if !got[0].Installed || got[0].AuthStatus != ports.AgentAuthStatusUnauthorized {
		t.Errorf("claude-code = %#v, want installed+unauthorized", got[0])
	}
	if got[2].Installed {
		t.Errorf("missing = %#v, want not installed", got[2])
	}
	if got[3].Installed || got[3].Label != "not-registered" {
		t.Errorf("unregistered = %#v, want not installed with id label", got[3])
	}
}

func TestHarnessHealthEmptyIDs(t *testing.T) {
	svc := NewWithAgents([]agentregistry.HarnessAgent{harnessAgent("codex", "Codex", nil)})
	got, err := svc.HarnessHealth(context.Background(), nil)
	if err != nil {
		t.Fatalf("HarnessHealth: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %d, want 0", len(got))
	}
}
