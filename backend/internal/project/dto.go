package project

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// Request/response shapes for Manager. They carry the data across the service
// boundary; the entities they reference (Project, Summary, Degraded) live in
// types.go in this same package. Named without a "Project" prefix because the
// package name already supplies it (project.AddInput, project.GetResult).

// GetResult is the discriminated union returned by Manager.Get. Exactly one of
// Project / Degraded is non-nil; Status mirrors the discriminator on the wire
// so consumers branch on it without nil-checking both fields.
type GetResult struct {
	Status   string    // "ok" | "degraded"
	Project  *Project  // populated when Status == "ok"
	Degraded *Degraded // populated when Status == "degraded"
}

// AddInput is the body shape for POST /api/v1/projects. Path is required;
// ProjectID and Name default to basename(path) at the manager. Pointer fields
// preserve the "field absent" vs "field present empty" distinction so the
// manager can decide what to default and what to reject.
type AddInput struct {
	Path      string  `json:"path"`
	ProjectID *string `json:"projectId,omitempty"`
	Name      *string `json:"name,omitempty"`
}

// UpdateConfigInput is the body shape for PATCH /api/v1/projects/{id}. Only
// behaviour fields are mutable; identity fields (projectId, path, repo,
// defaultBranch) are rejected by the handler with a 400 IDENTITY_FROZEN.
type UpdateConfigInput struct {
	Agent     *string                     `json:"agent,omitempty"`
	Runtime   *string                     `json:"runtime,omitempty"`
	Tracker   *TrackerConfig              `json:"tracker,omitempty"`
	SCM       *SCMConfig                  `json:"scm,omitempty"`
	Reactions *map[string]*ReactionConfig `json:"reactions,omitempty"`
}

// RemoveResult reports what DELETE /api/v1/projects/{id} actually did.
// RemovedStorageDir is false when the project was registry-only (no on-disk
// session/workspace directory existed).
type RemoveResult struct {
	ProjectID         domain.ProjectID `json:"projectId"`
	RemovedStorageDir bool             `json:"removedStorageDir"`
}

// ReloadResult is the response body of POST /api/v1/projects/reload — the
// manager invalidates its cached config and re-scans the registry; the counts
// help the dashboard show "loaded N projects, M degraded" feedback.
type ReloadResult struct {
	Reloaded      bool `json:"reloaded"`
	ProjectCount  int  `json:"projectCount"`
	DegradedCount int  `json:"degradedCount"`
}
