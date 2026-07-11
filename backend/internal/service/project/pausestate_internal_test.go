package project

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// fleetPauseErrStore embeds Store but forces GetFleetPaused to fail, so the
// degraded read-model path can be exercised. The embedded Store is nil:
// GetFleetPaused errors before any other store method is reached.
type fleetPauseErrStore struct{ Store }

func (fleetPauseErrStore) GetFleetPaused(context.Context) (bool, error) {
	return false, errors.New("fleet flag unavailable")
}

// TestWithPauseStateReflectsProjectPauseBitWhenFleetLoadFails: a project whose
// own pause bit is set must never read as "running" just because the fleet flag
// failed to load — the project's own bit is authoritative on its own.
func TestWithPauseStateReflectsProjectPauseBitWhenFleetLoadFails(t *testing.T) {
	svc := &Service{store: fleetPauseErrStore{}}

	paused := svc.withPauseState(context.Background(), domain.ProjectRecord{ID: "mer", Paused: true}, Project{})
	if paused.PauseState != PauseStatePaused {
		t.Fatalf("paused project with failed fleet load: PauseState = %q, want %q", paused.PauseState, PauseStatePaused)
	}

	// An unpaused project degrades to running — the best that can be known
	// without the fleet flag.
	running := svc.withPauseState(context.Background(), domain.ProjectRecord{ID: "mer", Paused: false}, Project{})
	if running.PauseState != PauseStateRunning {
		t.Fatalf("unpaused project with failed fleet load: PauseState = %q, want %q", running.PauseState, PauseStateRunning)
	}
}
