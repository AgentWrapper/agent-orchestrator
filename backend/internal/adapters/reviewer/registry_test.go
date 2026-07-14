package reviewer

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// TestRegistryMatchesDomainVocabulary enforces that the shipped reviewer
// adapters and domain.AllReviewerHarnesses stay in sync: every registered
// adapter is a known reviewer harness, and every known harness has an adapter.
func TestRegistryMatchesDomainVocabulary(t *testing.T) {
	registered := map[domain.ReviewerHarness]bool{}
	for _, a := range Constructors() {
		h := a.Harness()
		if !h.IsKnown() {
			t.Errorf("adapter harness %q is not in domain.AllReviewerHarnesses", h)
		}
		if registered[h] {
			t.Errorf("reviewer harness %q registered twice", h)
		}
		canceller, ok := a.(ports.ReviewerCanceller)
		if !ok {
			t.Errorf("reviewer harness %q does not implement cancellation", h)
		} else if spec, err := canceller.ReviewCancel(context.Background()); err != nil {
			t.Errorf("reviewer harness %q cancel spec: %v", h, err)
		} else if spec.Mode != ports.ReviewCancelInterrupt {
			t.Errorf("reviewer harness %q cancel mode = %q, want %q", h, spec.Mode, ports.ReviewCancelInterrupt)
		} else if spec.Interrupts != 2 {
			t.Errorf("reviewer harness %q cancel interrupts = %d, want 2", h, spec.Interrupts)
		}
		registered[h] = true
	}
	for _, h := range domain.AllReviewerHarnesses {
		if !registered[h] {
			t.Errorf("reviewer harness %q has no registered adapter", h)
		}
	}
}

func TestNewResolverResolvesShippedReviewers(t *testing.T) {
	resolver, err := NewResolver()
	if err != nil {
		t.Fatalf("NewResolver: %v", err)
	}
	for _, h := range domain.AllReviewerHarnesses {
		if _, ok := resolver.Reviewer(h); !ok {
			t.Errorf("resolver missing reviewer %q", h)
		}
	}
	if _, ok := resolver.Reviewer("nope"); ok {
		t.Error("resolver returned an adapter for an unknown harness")
	}
}
