package project

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// SetProjectPaused flips a project's independent pause bit. It writes only the
// paused column (never config), so a pause/resume cycle leaves config
// byte-identical. When hard is set on a pause, the project's live workers are
// terminated immediately (orchestrators are left running). Returns the updated
// read-model with the drain-aware state.
func (m *Service) SetProjectPaused(ctx context.Context, id domain.ProjectID, paused, hard bool) (Project, error) {
	if err := validateProjectID(id); err != nil {
		return Project{}, err
	}
	row, ok, err := m.store.GetProject(ctx, string(id))
	if err != nil {
		return Project{}, apierr.Internal("PROJECT_LOAD_FAILED", "Failed to load project")
	}
	if !ok || !row.ArchivedAt.IsZero() {
		return Project{}, apierr.NotFound("PROJECT_NOT_FOUND", "Unknown project")
	}
	if _, err := m.store.SetProjectPaused(ctx, string(id), paused); err != nil {
		return Project{}, apierr.Internal("PROJECT_PAUSE_FAILED", "Failed to update project pause state")
	}
	row.Paused = paused
	if paused && hard && m.sessions != nil {
		if _, err := m.sessions.HardDrain(ctx, id, false); err != nil {
			return Project{}, apierr.Internal("PROJECT_HARD_PAUSE_FAILED", "Paused, but failed to terminate workers")
		}
	}
	return m.withPauseState(ctx, row, m.projectFromRow(row)), nil
}

// FleetPaused reports the daemon-global fleet-pause flag.
func (m *Service) FleetPaused(ctx context.Context) (bool, error) {
	paused, err := m.store.GetFleetPaused(ctx)
	if err != nil {
		return false, apierr.Internal("FLEET_PAUSE_LOAD_FAILED", "Failed to load fleet pause state")
	}
	return paused, nil
}

// SetFleetPaused flips the daemon-global fleet-pause flag. A distinct global
// flag (not a fan-out over current projects) means a project registered while
// the fleet is paused is still gated. When hard is set on a pause, every
// project's workers and orchestrators are terminated immediately.
func (m *Service) SetFleetPaused(ctx context.Context, paused, hard bool) error {
	if err := m.store.SetFleetPaused(ctx, paused); err != nil {
		return apierr.Internal("FLEET_PAUSE_FAILED", "Failed to update fleet pause state")
	}
	if !paused || !hard || m.sessions == nil {
		return nil
	}
	projects, err := m.store.ListProjects(ctx)
	if err != nil {
		return apierr.Internal("FLEET_HARD_PAUSE_FAILED", "Paused, but failed to load projects to terminate")
	}
	// Best-effort across the whole fleet: one project's HardDrain failure must
	// not leave every later project's workers running during an emergency stop.
	// Attempt every project, then report failure if any project could not be
	// fully terminated.
	failed := 0
	for _, row := range projects {
		if _, err := m.sessions.HardDrain(ctx, domain.ProjectID(row.ID), true); err != nil {
			failed++
		}
	}
	if failed > 0 {
		return apierr.Internal("FLEET_HARD_PAUSE_FAILED", "Paused, but failed to terminate sessions in some projects")
	}
	return nil
}
