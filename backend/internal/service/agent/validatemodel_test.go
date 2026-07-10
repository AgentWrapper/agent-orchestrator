package agent

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// TestValidateModelExpiredContextIsProbeUnavailable: an already-cancelled context
// means no probe ran, so the result carries no information about the model. It
// must not reach callers as a "model unreachable" verdict (#182).
func TestValidateModelExpiredContextIsProbeUnavailable(t *testing.T) {
	svc := New()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := svc.ValidateModel(ctx, domain.HarnessCodex, "gpt-5.5")
	if err == nil {
		t.Fatal("ValidateModel err = nil, want cancelled context")
	}
	if !ports.ProbeUnavailable(err) {
		t.Fatalf("cancelled context must classify as ProbeUnavailable, got %v", err)
	}
}

// TestValidateModelUnsupportedHarnessStillHardBlocks: fail-open must stay narrow.
// An unknown harness is a genuine config error, not a probe fault.
func TestValidateModelUnsupportedHarnessStillHardBlocks(t *testing.T) {
	svc := New()

	err := svc.ValidateModel(context.Background(), domain.AgentHarness("nope"), "some-model")
	if err == nil {
		t.Fatal("ValidateModel err = nil, want unsupported agent")
	}
	if ports.ProbeUnavailable(err) {
		t.Fatalf("unsupported harness must NOT fail open, got %v", err)
	}
}

// TestValidateModelEmptyModelSkipsProbe: an unpinned bucket needs no probe.
func TestValidateModelEmptyModelSkipsProbe(t *testing.T) {
	svc := New()

	if err := svc.ValidateModel(context.Background(), domain.HarnessCodex, "   "); err != nil {
		t.Fatalf("empty model must skip the probe, got %v", err)
	}
}

// TestValidateModelEmptyModelSkipsProbeEvenWhenContextDone pins the ordering: an
// unpinned bucket is a no-op, so a cancelled context must not turn it into an error.
func TestValidateModelEmptyModelSkipsProbeEvenWhenContextDone(t *testing.T) {
	svc := New()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := svc.ValidateModel(ctx, domain.HarnessCodex, ""); err != nil {
		t.Fatalf("empty model must be a no-op regardless of context state, got %v", err)
	}
}
