// Package devimport copies the native rewrite project registry between AO data
// directories. It is intentionally narrower than legacy import: only active
// project rows and workspace child repo registry are copied.
package devimport

import (
	"context"
	"fmt"
	"sort"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Store is the storage slice required by the dev project importer.
type Store interface {
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
	ListWorkspaceRepos(ctx context.Context, projectID string) ([]domain.WorkspaceRepoRecord, error)
	UpsertWorkspaceProject(ctx context.Context, row domain.ProjectRecord, repos []domain.WorkspaceRepoRecord) error
}

// Options configure a project registry copy.
type Options struct {
	SourceDataDir string
	TargetDataDir string
	DryRun        bool
}

// Conflict describes an active target project that prevented a source project
// from being copied.
type Conflict struct {
	ProjectID  string `json:"projectId"`
	Path       string `json:"path"`
	Reason     string `json:"reason"`
	TargetID   string `json:"targetId,omitempty"`
	TargetPath string `json:"targetPath,omitempty"`
}

// Report is the structured outcome of one copy run.
type Report struct {
	SourceDataDir string     `json:"sourceDataDir"`
	TargetDataDir string     `json:"targetDataDir"`
	DryRun        bool       `json:"dryRun"`
	Inserted      int        `json:"inserted"`
	Updated       int        `json:"updated"`
	Skipped       int        `json:"skipped"`
	Conflicts     []Conflict `json:"conflicts,omitempty"`
}

// Run copies active source projects into target. It never archives or deletes
// target projects, and dry-run mode performs all conflict checks without writes.
func Run(ctx context.Context, source, target Store, opts Options) (Report, error) {
	rep := Report{
		SourceDataDir: opts.SourceDataDir,
		TargetDataDir: opts.TargetDataDir,
		DryRun:        opts.DryRun,
	}

	sourceProjects, err := source.ListProjects(ctx)
	if err != nil {
		return rep, fmt.Errorf("list source projects: %w", err)
	}
	targetProjects, err := target.ListProjects(ctx)
	if err != nil {
		return rep, fmt.Errorf("list target projects: %w", err)
	}

	sort.Slice(sourceProjects, func(i, j int) bool {
		return sourceProjects[i].ID < sourceProjects[j].ID
	})

	targetByID := make(map[string]domain.ProjectRecord, len(targetProjects))
	targetByPath := make(map[string]domain.ProjectRecord, len(targetProjects))
	for _, p := range targetProjects {
		targetByID[p.ID] = p
		targetByPath[p.Path] = p
	}

	for _, src := range sourceProjects {
		existingByID, idExists := targetByID[src.ID]
		existingByPath, pathExists := targetByPath[src.Path]

		switch {
		case idExists && existingByID.Path != src.Path:
			rep.addConflict(Conflict{
				ProjectID:  src.ID,
				Path:       src.Path,
				Reason:     "same id with different active path",
				TargetID:   existingByID.ID,
				TargetPath: existingByID.Path,
			})
			continue
		case pathExists && existingByPath.ID != src.ID:
			rep.addConflict(Conflict{
				ProjectID:  src.ID,
				Path:       src.Path,
				Reason:     "same path with different active id",
				TargetID:   existingByPath.ID,
				TargetPath: existingByPath.Path,
			})
			continue
		}

		repos, err := source.ListWorkspaceRepos(ctx, src.ID)
		if err != nil {
			return rep, fmt.Errorf("list source workspace repos for %s: %w", src.ID, err)
		}
		repos = cloneWorkspaceRepos(repos)
		for i := range repos {
			repos[i].ProjectID = domain.ProjectID(src.ID)
		}

		if idExists && pathExists {
			if !opts.DryRun {
				if err := target.UpsertWorkspaceProject(ctx, src, repos); err != nil {
					return rep, fmt.Errorf("update target project %s: %w", src.ID, err)
				}
			}
			rep.Updated++
			continue
		}

		if !opts.DryRun {
			if err := target.UpsertWorkspaceProject(ctx, src, repos); err != nil {
				return rep, fmt.Errorf("insert target project %s: %w", src.ID, err)
			}
		}
		targetByID[src.ID] = src
		targetByPath[src.Path] = src
		rep.Inserted++
	}

	return rep, nil
}

func (r *Report) addConflict(c Conflict) {
	r.Skipped++
	r.Conflicts = append(r.Conflicts, c)
}

func cloneWorkspaceRepos(in []domain.WorkspaceRepoRecord) []domain.WorkspaceRepoRecord {
	out := make([]domain.WorkspaceRepoRecord, len(in))
	copy(out, in)
	return out
}
