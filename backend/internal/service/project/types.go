package project

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// PauseState is the observable fleet-pause lifecycle of a project: running, or
// paused with in-flight workers still finishing (draining), or fully paused
// with nothing left running.
type PauseState string

const (
	// PauseStateRunning means neither the project nor the fleet is paused.
	PauseStateRunning PauseState = "running"
	// PauseStateDraining means paused (project- or fleet-wide) but ≥1 worker is
	// still finishing; the drain sweeper terminates them as they go idle.
	PauseStateDraining PauseState = "draining"
	// PauseStatePaused means paused with no live workers remaining.
	PauseStatePaused PauseState = "paused"
)

// computePauseState derives the observable state from the effective paused bit
// (the project's own flag OR the daemon-global flag) and the count of live
// workers still running for the project.
func computePauseState(projectPaused, fleetPaused bool, liveWorkers int) (PauseState, int) {
	if !projectPaused && !fleetPaused {
		return PauseStateRunning, 0
	}
	if liveWorkers > 0 {
		return PauseStateDraining, liveWorkers
	}
	return PauseStatePaused, 0
}

// Summary is the row shape returned by GET /api/v1/projects.
type Summary struct {
	ID                domain.ProjectID     `json:"id"`
	Name              string               `json:"name"`
	Path              string               `json:"path"`
	Kind              domain.ProjectKind   `json:"kind"`
	ProjectPrefix     string               `json:"projectPrefix"`
	SessionPrefix     string               `json:"sessionPrefix"`
	OrchestratorAgent domain.AgentHarness  `json:"orchestratorAgent,omitempty"`
	Config            domain.ProjectConfig `json:"-"`
	ResolveError      string               `json:"resolveError,omitempty"`
	// Paused is the project's own pause bit (what the per-project toggle flips).
	// It is independent of the daemon-global flag: a project can read
	// Paused=false yet still show PauseState=paused because the fleet is paused.
	Paused bool `json:"paused"`
	// PauseState is the effective observable state (running|draining|paused),
	// accounting for both the project bit and the daemon-global flag.
	PauseState PauseState `json:"pauseState"`
	// DrainingWorkers is the count of live workers still finishing while
	// draining; zero unless PauseState is draining.
	DrainingWorkers int `json:"drainingWorkers,omitempty"`
}

// Project is the full read-model returned by GET /api/v1/projects/{id}.
type Project struct {
	ID              domain.ProjectID      `json:"id"`
	Name            string                `json:"name"`
	Kind            domain.ProjectKind    `json:"kind"`
	Path            string                `json:"path"`
	Repo            string                `json:"repo"`
	DefaultBranch   string                `json:"defaultBranch"`
	Agent           string                `json:"agent,omitempty"`
	Config          *domain.ProjectConfig `json:"config,omitempty"`
	WorkspaceRepos  []WorkspaceRepo       `json:"workspaceRepos,omitempty"`
	Paused          bool                  `json:"paused"`
	PauseState      PauseState            `json:"pauseState"`
	DrainingWorkers int                   `json:"drainingWorkers,omitempty"`
}

// Degraded is returned in place of Project when project config failed to load.
type Degraded struct {
	ID           domain.ProjectID   `json:"id"`
	Name         string             `json:"name"`
	Kind         domain.ProjectKind `json:"kind"`
	Path         string             `json:"path"`
	ResolveError string             `json:"resolveError"`
}

// WorkspaceRepo is the project-detail read shape for a registered child repo.
type WorkspaceRepo struct {
	Name         string `json:"name"`
	RelativePath string `json:"relativePath"`
	Repo         string `json:"repo"`
}
