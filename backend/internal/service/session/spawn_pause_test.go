package session

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// TestSpawnRejectedWhenProjectPaused: a worker spawn on a paused project is
// refused with a typed PROJECT_PAUSED conflict and never reaches the manager.
func TestSpawnRejectedWhenProjectPaused(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Paused: true}
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	_, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	var e *apierr.Error
	if !errors.As(err, &e) || e.Kind != apierr.KindConflict || e.Code != "PROJECT_PAUSED" {
		t.Fatalf("err = %v, want apierr.Conflict PROJECT_PAUSED", err)
	}
	if e.Details["scope"] != "project" {
		t.Fatalf("scope = %v, want project", e.Details["scope"])
	}
	if fc.spawned {
		t.Fatal("manager.Spawn must NOT run for a paused project")
	}
}

// TestSpawnRejectedWhenFleetPaused: a worker spawn is refused when the whole
// fleet is paused even though the project's own bit is clear — the distinct
// global flag gates every project, including ones added after the pause.
func TestSpawnRejectedWhenFleetPaused(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	st.fleetPaused = true
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	_, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	var e *apierr.Error
	if !errors.As(err, &e) || e.Code != "PROJECT_PAUSED" || e.Details["scope"] != "fleet" {
		t.Fatalf("err = %v, want PROJECT_PAUSED fleet scope", err)
	}
	if fc.spawned {
		t.Fatal("manager.Spawn must NOT run while the fleet is paused")
	}
}

// TestSpawnForceOverridesPause: `ao spawn --force` (Force) bypasses the guard so
// a deliberate manual spawn still works on a paused project.
func TestSpawnForceOverridesPause(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Paused: true}
	st.fleetPaused = true
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	if _, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Force: true}); err != nil {
		t.Fatalf("forced spawn on paused project: %v", err)
	}
	if !fc.spawned {
		t.Fatal("Force must let the spawn through to the manager")
	}
}

// TestSpawnOrchestratorNotBlockedByPause: pause gates new work (workers), not
// the orchestrator lifecycle. An orchestrator spawn is allowed even when paused
// so the supervisor can keep a live orchestrator supervising the drain.
func TestSpawnOrchestratorNotBlockedByPause(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Paused: true}
	st.fleetPaused = true
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	if _, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator}); err != nil {
		t.Fatalf("orchestrator spawn on paused project: %v", err)
	}
	if !fc.spawned {
		t.Fatal("orchestrator spawn must not be blocked by pause")
	}
}

// TestSpawnPrimeNotBlockedByPause: prime is the fleet's meta tier — the tier
// through which the operator pauses and resumes projects — so neither a
// host-project pause nor a fleet-wide pause may block a prime spawn. Prime's
// only off-switch is the operator's activation config (#312).
func TestSpawnPrimeNotBlockedByPause(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Paused: true}
	st.fleetPaused = true
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	if _, err := svc.SpawnPrime(context.Background(), "mer", false); err != nil {
		t.Fatalf("prime spawn on paused project/fleet: %v", err)
	}
	if !fc.spawned {
		t.Fatal("prime spawn must not be blocked by pause")
	}
}
