package project

import (
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Summary is the row shape returned by GET /api/v1/projects.
type Summary struct {
	ID            domain.ProjectID   `json:"id"`
	Name          string             `json:"name"`
	Path          string             `json:"path"`
	Kind          domain.ProjectKind `json:"kind"`
	SessionPrefix string             `json:"sessionPrefix"`
	ResolveError  string             `json:"resolveError,omitempty"`
}

// Project is the full read-model returned by GET /api/v1/projects/{id}.
type Project struct {
	ID             domain.ProjectID      `json:"id"`
	Name           string                `json:"name"`
	Kind           domain.ProjectKind    `json:"kind"`
	Path           string                `json:"path"`
	Repo           string                `json:"repo"`
	DefaultBranch  string                `json:"defaultBranch"`
	Agent          string                `json:"agent,omitempty"`
	Config         *domain.ProjectConfig `json:"config,omitempty"`
	WorkspaceRepos []WorkspaceRepo       `json:"workspaceRepos,omitempty"`
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

// Collision is the wire read-model for one cross-session edit collision detected
// by the convergence observer: two live sessions in the project are changing
// overlapping code before either has opened a PR. Severity is "hot" when their
// changed line ranges intersect (a near-certain future merge conflict) or "soft"
// when they only share files.
type Collision struct {
	SessionA    domain.SessionID `json:"sessionA"`
	SessionB    domain.SessionID `json:"sessionB"`
	Severity    string           `json:"severity" enum:"soft,hot"`
	Files       []CollisionFile  `json:"files"`
	FirstSeenAt time.Time        `json:"firstSeenAt"`
	UpdatedAt   time.Time        `json:"updatedAt"`
}

// CollisionFile is one file both sessions changed, with the overlapping line
// ranges (present only for hot collisions).
type CollisionFile struct {
	Path   string           `json:"path"`
	Ranges []CollisionRange `json:"ranges,omitempty"`
}

// CollisionRange is an inclusive [Start, End] span of overlapping lines.
type CollisionRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}
