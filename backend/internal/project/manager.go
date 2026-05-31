package project

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type manager struct {
	store Store
}

var _ Manager = (*manager)(nil)

func NewManager(store Store) Manager {
	if store == nil {
		store = NewMemoryStore()
	}
	return &manager{store: store}
}

func NewMemoryManager() Manager {
	return NewManager(NewMemoryStore())
}

func (m *manager) List(ctx context.Context) ([]Summary, error) {
	projects, err := m.store.List(ctx)
	if err != nil {
		return nil, internal("PROJECTS_LIST_FAILED", "Failed to load projects")
	}
	out := make([]Summary, 0, len(projects))
	for _, row := range projects {
		out = append(out, Summary{
			ID:            domain.ProjectID(row.ID),
			Name:          displayName(row),
			SessionPrefix: sessionPrefix(row.ID),
		})
	}
	return out, nil
}

func (m *manager) Get(ctx context.Context, id domain.ProjectID) (GetResult, error) {
	if err := validateProjectID(id); err != nil {
		return GetResult{}, err
	}
	row, ok, err := m.store.Get(ctx, string(id))
	if err != nil {
		return GetResult{}, internal("PROJECT_LOAD_FAILED", "Failed to load project")
	}
	if !ok {
		return GetResult{}, notFound("PROJECT_NOT_FOUND", "Unknown project")
	}
	p := projectFromRow(row)
	return GetResult{Status: "ok", Project: &p}, nil
}

func (m *manager) Add(ctx context.Context, in AddInput) (Project, error) {
	path, err := normalizePath(in.Path)
	if err != nil {
		return Project{}, err
	}
	if !isGitRepo(path) {
		return Project{}, badRequest("NOT_A_GIT_REPO", "Repository path must point to a git repository", nil)
	}

	id := defaultProjectID(path)
	if in.ProjectID != nil {
		id = domain.ProjectID(strings.TrimSpace(*in.ProjectID))
	}
	if err := validateProjectID(id); err != nil {
		return Project{}, err
	}

	name := string(id)
	if in.Name != nil {
		name = strings.TrimSpace(*in.Name)
	}
	if name == "" {
		name = string(id)
	}

	if existing, ok, err := m.store.FindByPath(ctx, path); err != nil {
		return Project{}, internal("PROJECT_LOAD_FAILED", "Failed to load project")
	} else if ok {
		return Project{}, conflict("PATH_ALREADY_REGISTERED", "A project at this path is already registered", map[string]any{
			"existingProjectId":  existing.ID,
			"suggestedProjectId": string(m.suggestID(ctx, id)),
		})
	}
	if existing, ok, err := m.store.Get(ctx, string(id)); err != nil {
		return Project{}, internal("PROJECT_LOAD_FAILED", "Failed to load project")
	} else if ok && existing.Path != path {
		return Project{}, conflict("ID_ALREADY_REGISTERED", "A project with this id is already registered for a different path", map[string]any{
			"existingProjectId":  existing.ID,
			"suggestedProjectId": string(m.suggestID(ctx, id)),
		})
	}

	row := ProjectRow{
		ID:           string(id),
		Path:         path,
		DisplayName:  name,
		RegisteredAt: time.Now(),
	}
	if err := m.store.Upsert(ctx, row); err != nil {
		return Project{}, err
	}
	return projectFromRow(row), nil
}

func (m *manager) UpdateConfig(ctx context.Context, id domain.ProjectID, _ UpdateConfigInput) (Project, error) {
	if err := validateProjectID(id); err != nil {
		return Project{}, err
	}
	_, ok, err := m.store.Get(ctx, string(id))
	if err != nil {
		return Project{}, internal("PROJECT_LOAD_FAILED", "Failed to load project")
	}
	if !ok {
		return Project{}, notFound("PROJECT_NOT_FOUND", "Unknown project")
	}

	return Project{}, notImplemented("PROJECT_CONFIG_NOT_IMPLEMENTED", "Project config patching is not available until config persistence is wired")
}

func (m *manager) Remove(ctx context.Context, id domain.ProjectID) (RemoveResult, error) {
	if err := validateProjectID(id); err != nil {
		return RemoveResult{}, err
	}
	ok, err := m.store.Archive(ctx, string(id), time.Now())
	if err != nil {
		return RemoveResult{}, internal("PROJECT_REMOVE_FAILED", "Failed to remove project")
	}
	if !ok {
		return RemoveResult{}, notFound("PROJECT_NOT_FOUND", "Unknown project")
	}
	return RemoveResult{ProjectID: id, RemovedStorageDir: false}, nil
}

func (m *manager) Repair(ctx context.Context, id domain.ProjectID) (Project, error) {
	if err := validateProjectID(id); err != nil {
		return Project{}, err
	}
	if _, ok, err := m.store.Get(ctx, string(id)); err != nil {
		return Project{}, internal("PROJECT_LOAD_FAILED", "Failed to load project")
	} else if !ok {
		return Project{}, notFound("PROJECT_NOT_FOUND", "Unknown project")
	}
	return Project{}, badRequest("REPAIR_NOT_AVAILABLE", "Automatic repair is not available for this degraded config", nil)
}

func (m *manager) Reload(ctx context.Context) (ReloadResult, error) {
	projects, err := m.store.List(ctx)
	if err != nil {
		return ReloadResult{}, internal("RELOAD_FAILED", "Failed to reload projects")
	}
	return ReloadResult{Reloaded: true, ProjectCount: len(projects), DegradedCount: 0}, nil
}

func (m *manager) suggestID(ctx context.Context, base domain.ProjectID) domain.ProjectID {
	for i := 1; ; i++ {
		candidate := domain.ProjectID(string(base) + strconv.Itoa(i))
		if _, ok, _ := m.store.Get(ctx, string(candidate)); !ok {
			return candidate
		}
	}
}

func projectFromRow(row ProjectRow) Project {
	return Project{
		ID:            domain.ProjectID(row.ID),
		Name:          displayName(row),
		Path:          row.Path,
		Repo:          row.RepoOriginURL,
		DefaultBranch: "main",
	}
}

func displayName(row ProjectRow) string {
	if strings.TrimSpace(row.DisplayName) != "" {
		return row.DisplayName
	}
	return row.ID
}

func normalizePath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", badRequest("PATH_REQUIRED", "Repository path is required", nil)
	}
	if strings.HasPrefix(raw, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", badRequest("INVALID_PATH", "Repository path could not be expanded", nil)
		}
		if raw == "~" {
			raw = home
		} else if strings.HasPrefix(raw, "~/") || strings.HasPrefix(raw, `~\`) {
			raw = filepath.Join(home, raw[2:])
		}
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", badRequest("INVALID_PATH", "Repository path is invalid", nil)
	}
	return filepath.Clean(abs), nil
}

func isGitRepo(path string) bool {
	cmd := exec.Command("git", "-C", path, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	top := filepath.Clean(strings.TrimSpace(string(out)))
	path = filepath.Clean(path)
	top, err = filepath.EvalSymlinks(top)
	if err != nil {
		return false
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}

	if strings.EqualFold(top, path) {
		return true
	}
	return top == path
}

func defaultProjectID(path string) domain.ProjectID {
	id := strings.ToLower(filepath.Base(path))
	id = strings.TrimSpace(id)
	id = strings.ReplaceAll(id, " ", "-")
	return domain.ProjectID(id)
}

var projectIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func validateProjectID(id domain.ProjectID) error {
	raw := string(id)
	if raw == "" || raw == "." || raw == ".." || strings.ContainsAny(raw, `/\`) || !projectIDPattern.MatchString(raw) {
		return badRequest("INVALID_PROJECT_ID", "Project id failed storage-path validation", nil)
	}
	return nil
}

func sessionPrefix(id string) string {
	if id == "" {
		return "ao"
	}
	if len(id) <= 12 {
		return id
	}
	return id[:12]
}
