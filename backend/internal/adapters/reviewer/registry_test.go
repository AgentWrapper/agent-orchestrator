package reviewer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/review"
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
		if _, ok := a.(ports.ReviewerRestorer); !ok {
			t.Errorf("reviewer harness %q does not implement restore", h)
		}
		canceller, ok := a.(ports.ReviewerCanceller)
		if !ok {
			t.Errorf("reviewer harness %q does not implement cancellation", h)
		} else if spec, err := canceller.ReviewCancel(context.Background()); err != nil {
			t.Errorf("reviewer harness %q cancel spec: %v", h, err)
		} else if h == domain.ReviewerKiro || h == domain.ReviewerPi || h == domain.ReviewerQwen || h == domain.ReviewerContinue || h == domain.ReviewerVibe {
			if spec.Mode != ports.ReviewCancelEscape || spec.Interrupts > 1 {
				t.Errorf("TUI reviewer %q cancel spec = %+v, want one Escape", h, spec)
			}
		} else if h == domain.ReviewerAgy || h == domain.ReviewerGoose || h == domain.ReviewerDevin || h == domain.ReviewerDroid || h == domain.ReviewerKimi {
			if spec.Mode != ports.ReviewCancelInterrupt || spec.Interrupts != 1 {
				t.Errorf("TUI reviewer %q cancel spec = %+v, want one interrupt", h, spec)
			}
		} else if spec.Mode != ports.ReviewCancelInterrupt || spec.Interrupts != 2 {
			t.Errorf("reviewer harness %q cancel spec = %+v, want two interrupts", h, spec)
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

func TestQwenRegistryAdapterPassesLauncherPreflightWithoutRequestData(t *testing.T) {
	binDir := t.TempDir()
	qwenPath := filepath.Join(binDir, "qwen")
	if err := os.WriteFile(qwenPath, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	resolver, err := NewResolver()
	if err != nil {
		t.Fatal(err)
	}
	launcher := review.NewLauncher(resolver, nil, "")
	if err := launcher.Preflight(context.Background(), domain.ReviewerQwen, t.TempDir()); err != nil {
		t.Fatalf("Qwen preflight: %v", err)
	}
}
