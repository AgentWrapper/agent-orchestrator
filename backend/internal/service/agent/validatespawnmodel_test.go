package agent

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	agentregistry "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func spawnModelSvc(harness domain.AgentHarness, probe *modelProbeAgent) *Service {
	return NewWithAgents([]agentregistry.HarnessAgent{
		{
			Harness:  harness,
			Manifest: adapters.Manifest{ID: string(harness), Name: string(harness)},
			Agent:    probe,
		},
	})
}

// primePinVerdict runs one real availability probe so the per-pin verdict cache
// holds the pin's verdict, the way the daily model-health revalidation would.
func primePinVerdict(t *testing.T, svc *Service, harness domain.AgentHarness, model string) {
	t.Helper()
	if _, err := svc.ModelAvailability(context.Background(), ModelAvailabilityRequest{
		Force: true,
		Pins:  []ModelPin{{Harness: harness, Model: model}},
	}); err != nil {
		t.Fatalf("prime pin verdict: %v", err)
	}
}

// A cached definitive provider rejection is the ONLY case that blocks a spawn.
func TestValidateSpawnModel_DefinitiveRejectionBlocks(t *testing.T) {
	probe := &modelProbeAgent{err: errors.New("400 model not available")}
	svc := spawnModelSvc(domain.HarnessCodex, probe)
	primePinVerdict(t, svc, domain.HarnessCodex, "gpt-5.5-codex")

	err := svc.ValidateSpawnModel(context.Background(), domain.HarnessCodex, "gpt-5.5-codex")
	if err == nil {
		t.Fatal("ValidateSpawnModel err = nil, want a definitive rejection")
	}
	if ports.ProbeUnavailable(err) {
		t.Fatalf("definitive rejection must not be a probe-unavailable error, got %v", err)
	}
}

// A cached unknown verdict (probe machinery failed) fails open as ProbeUnavailable.
func TestValidateSpawnModel_ProbeUnavailableFailsOpen(t *testing.T) {
	probe := &modelProbeAgent{err: &ports.ProbeUnavailableError{Reason: "codex exec usage error"}}
	svc := spawnModelSvc(domain.HarnessCodex, probe)
	primePinVerdict(t, svc, domain.HarnessCodex, "gpt-5.5-codex")

	err := svc.ValidateSpawnModel(context.Background(), domain.HarnessCodex, "gpt-5.5-codex")
	if err == nil || !ports.ProbeUnavailable(err) {
		t.Fatalf("unknown verdict must be reported as probe-unavailable (fail open), got %v", err)
	}
}

// A cached reachable verdict proceeds with no error.
func TestValidateSpawnModel_ReachableProceeds(t *testing.T) {
	probe := &modelProbeAgent{}
	svc := spawnModelSvc(domain.HarnessCodex, probe)
	primePinVerdict(t, svc, domain.HarnessCodex, "gpt-5.5-codex")

	if err := svc.ValidateSpawnModel(context.Background(), domain.HarnessCodex, "gpt-5.5-codex"); err != nil {
		t.Fatalf("reachable model must proceed, got %v", err)
	}
}

// An empty model is a no-op (unpinned spawn).
func TestValidateSpawnModel_EmptyModelSkips(t *testing.T) {
	svc := spawnModelSvc(domain.HarnessCodex, &modelProbeAgent{err: errors.New("should not be consulted")})
	if err := svc.ValidateSpawnModel(context.Background(), domain.HarnessCodex, "   "); err != nil {
		t.Fatalf("empty model must skip validation, got %v", err)
	}
}

// ValidateSpawnModel is CACHE-ONLY: with no recorded verdict it fails open and
// NEVER runs a provider probe — it is called under the spawn mutex, where a
// fresh probe would serialize every spawn in the daemon.
func TestValidateSpawnModel_CacheMissFailsOpenWithoutProbing(t *testing.T) {
	probe := &modelProbeAgent{err: errors.New("400 model not available")}
	svc := spawnModelSvc(domain.HarnessCodex, probe)

	err := svc.ValidateSpawnModel(context.Background(), domain.HarnessCodex, "gpt-5.5-codex")
	if err == nil || !ports.ProbeUnavailable(err) {
		t.Fatalf("cache miss must fail open as probe-unavailable, got %v", err)
	}
	probe.mu.Lock()
	probed := len(probe.models)
	probe.mu.Unlock()
	if probed != 0 {
		t.Fatalf("ValidateSpawnModel ran %d provider probe(s), want 0 (cache-only)", probed)
	}
}

// A stale cached verdict (older than the freshness window) fails open rather
// than blocking a spawn on ancient state.
func TestValidateSpawnModel_StaleVerdictFailsOpen(t *testing.T) {
	probe := &modelProbeAgent{err: errors.New("400 model not available")}
	svc := spawnModelSvc(domain.HarnessCodex, probe)
	svc.recordPinVerdict(domain.HarnessCodex, "gpt-5.5-codex", pinVerdict{
		status:    ModelStatusUnreachable,
		reason:    "400 model not available",
		checkedAt: time.Now().Add(-spawnPinVerdictTTL - time.Minute),
	})

	err := svc.ValidateSpawnModel(context.Background(), domain.HarnessCodex, "gpt-5.5-codex")
	if err == nil || !ports.ProbeUnavailable(err) {
		t.Fatalf("stale verdict must fail open as probe-unavailable, got %v", err)
	}
}

// A direct config-save validation (ValidateModel) also records the pin verdict,
// so a spawn immediately after a config write consumes a current opinion.
func TestValidateSpawnModel_ConfigSaveProbeFeedsCache(t *testing.T) {
	probe := &modelProbeAgent{err: errors.New("400 model not available")}
	svc := spawnModelSvc(domain.HarnessCodex, probe)
	if err := svc.ValidateModel(context.Background(), domain.HarnessCodex, "gpt-5.5-codex"); err == nil {
		t.Fatal("ValidateModel should surface the provider rejection")
	}

	err := svc.ValidateSpawnModel(context.Background(), domain.HarnessCodex, "gpt-5.5-codex")
	if err == nil || ports.ProbeUnavailable(err) {
		t.Fatalf("spawn gate should consume the config-save rejection verdict, got %v", err)
	}
}

// The verdict cache prunes expired entries on write and never grows past its
// cap, so config churn cannot leak memory for the daemon's lifetime.
func TestRecordPinVerdict_PrunesExpiredAndBoundsSize(t *testing.T) {
	svc := spawnModelSvc(domain.HarnessCodex, &modelProbeAgent{})

	// An expired entry is removed by the next write.
	svc.recordPinVerdict(domain.HarnessCodex, "ancient-model", pinVerdict{
		status:    ModelStatusUnreachable,
		checkedAt: time.Now().Add(-spawnPinVerdictTTL - time.Minute),
	})
	svc.recordPinVerdict(domain.HarnessCodex, "fresh-model", pinVerdict{status: ModelStatusReachable})
	svc.modelMu.Lock()
	_, ancientAlive := svc.pinVerdicts[modelPinKey(domain.HarnessCodex, "ancient-model")]
	svc.modelMu.Unlock()
	if ancientAlive {
		t.Fatal("expired pin verdict must be pruned on write")
	}

	// Churning far past the cap keeps the map bounded.
	for i := range maxPinVerdicts * 2 {
		svc.recordPinVerdict(domain.HarnessCodex, fmt.Sprintf("model-%d", i), pinVerdict{
			status:    ModelStatusReachable,
			checkedAt: time.Now().Add(time.Duration(i) * time.Millisecond),
		})
	}
	svc.modelMu.Lock()
	size := len(svc.pinVerdicts)
	svc.modelMu.Unlock()
	if size > maxPinVerdicts {
		t.Fatalf("pin verdict cache size = %d, want <= %d", size, maxPinVerdicts)
	}
}

// Cap eviction must not sacrifice an actively-configured definitive rejection —
// the one verdict that is currently blocking bad launches — while cheaper
// candidates (likely-unconfigured stale pins, fresh non-blocking verdicts)
// exist. Losing the rejection would silently degrade the spawn gate to
// fail-open for that pin.
func TestRecordPinVerdict_EvictionSparesConfiguredRejections(t *testing.T) {
	svc := spawnModelSvc(domain.HarnessCodex, &modelProbeAgent{})

	// A fresh definitive rejection: the daily revalidation keeps refreshing it,
	// so it reads as an actively-configured pin.
	svc.recordPinVerdict(domain.HarnessCodex, "blocked-model", pinVerdict{
		status: ModelStatusUnreachable, reason: "400 model not available",
	})
	// Fill to the cap with entries a revalidation cycle old (likely
	// unconfigured), then push past it with fresh reachable churn.
	stale := time.Now().Add(-likelyUnconfiguredPinAge - time.Hour)
	for i := range maxPinVerdicts - 1 {
		svc.recordPinVerdict(domain.HarnessCodex, fmt.Sprintf("old-model-%d", i), pinVerdict{
			status: ModelStatusReachable, checkedAt: stale,
		})
	}
	for i := range 50 {
		svc.recordPinVerdict(domain.HarnessCodex, fmt.Sprintf("churn-model-%d", i), pinVerdict{status: ModelStatusReachable})
	}

	if err := svc.ValidateSpawnModel(context.Background(), domain.HarnessCodex, "blocked-model"); err == nil || ports.ProbeUnavailable(err) {
		t.Fatalf("the configured definitive rejection must survive eviction, got %v", err)
	}
	svc.modelMu.Lock()
	size := len(svc.pinVerdicts)
	svc.modelMu.Unlock()
	if size > maxPinVerdicts {
		t.Fatalf("pin verdict cache size = %d, want <= %d", size, maxPinVerdicts)
	}
}

// A harness with no model validator records a no-capability unknown verdict and
// still fails open at spawn time.
func TestValidateSpawnModel_NoCapabilityVerdictFailsOpen(t *testing.T) {
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		{
			Harness:  domain.HarnessClaudeCode,
			Manifest: adapters.Manifest{ID: string(domain.HarnessClaudeCode), Name: "Claude"},
			Agent:    fakeAgent{},
		},
	})
	primePinVerdict(t, svc, domain.HarnessClaudeCode, "claude-custom")

	err := svc.ValidateSpawnModel(context.Background(), domain.HarnessClaudeCode, "claude-custom")
	if err == nil || !ports.ProbeUnavailable(err) {
		t.Fatalf("a no-capability verdict must fail open as probe-unavailable, got %v", err)
	}
}
