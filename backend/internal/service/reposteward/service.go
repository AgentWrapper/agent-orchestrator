// Package reposteward continuously preserves recoverable Git snapshots for
// registered projects and their agent worktrees.
package reposteward

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const (
	DefaultInterval       = time.Minute
	defaultCommandTimeout = 25 * time.Second
	defaultSyncTimeout    = 90 * time.Second
)

type State string

const (
	StateProtected State = "protected"
	StateLocalOnly State = "local_only"
	StateAttention State = "attention"
	StateChecking  State = "checking"
)

type RemoteState string

const (
	RemoteSynced        RemoteState = "synced"
	RemotePending       RemoteState = "pending"
	RemoteNotConfigured RemoteState = "not_configured"
	RemoteNotGitHub     RemoteState = "not_github"
)

// RepositoryStatus is the latest checkpoint fact for one project checkout or
// agent worktree. Paths are intentionally omitted from the wire model: the UI
// only needs the friendly source name, branch, refs, and recovery health.
type RepositoryStatus struct {
	Name             string      `json:"name"`
	Branch           string      `json:"branch,omitempty"`
	Dirty            bool        `json:"dirty"`
	LocalRef         string      `json:"localRef,omitempty"`
	LocalSHA         string      `json:"localSha,omitempty"`
	RemoteRef        string      `json:"remoteRef,omitempty"`
	RemoteState      RemoteState `json:"remoteState" enum:"synced,pending,not_configured,not_github"`
	LastCheckpointAt time.Time   `json:"lastCheckpointAt,omitempty"`
	Error            string      `json:"error,omitempty"`
}

// Status is the project-level read model shown by the desktop repository
// steward card.
type Status struct {
	Agent           string             `json:"agent"`
	Enabled         bool               `json:"enabled"`
	State           State              `json:"state" enum:"protected,local_only,attention,checking"`
	IntervalSeconds int                `json:"intervalSeconds"`
	LastRunAt       time.Time          `json:"lastRunAt,omitempty"`
	NextRunAt       time.Time          `json:"nextRunAt,omitempty"`
	Repositories    []RepositoryStatus `json:"repositories"`
}

type Store interface {
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
	ListWorkspaceRepos(ctx context.Context, projectID string) ([]domain.WorkspaceRepoRecord, error)
	ListSessions(ctx context.Context, projectID domain.ProjectID) ([]domain.SessionRecord, error)
	ListSessionWorktrees(ctx context.Context, sessionID domain.SessionID) ([]domain.SessionWorktreeRecord, error)
}

type Runner interface {
	Git(ctx context.Context, dir string, env []string, args ...string) ([]byte, error)
}

type GitHubTokenSource interface {
	Token(ctx context.Context) (string, error)
}

type gitRunner struct{}

func (gitRunner) Git(ctx context.Context, dir string, env []string, args ...string) ([]byte, error) {
	cmd := aoprocess.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return out, errors.New(message)
	}
	return out, nil
}

type Deps struct {
	Store    Store
	Runner   Runner
	Interval time.Duration
	Clock    func() time.Time
	Logger   *slog.Logger
	GitHubToken GitHubTokenSource
}

type Manager struct {
	store    Store
	runner   Runner
	interval time.Duration
	clock    func() time.Time
	logger   *slog.Logger
	githubToken GitHubTokenSource

	runMu sync.Mutex
	mu    sync.RWMutex
	state map[domain.ProjectID]Status
}

func New(d Deps) *Manager {
	if d.Runner == nil {
		d.Runner = gitRunner{}
	}
	if d.Interval <= 0 {
		d.Interval = DefaultInterval
	}
	if d.Clock == nil {
		d.Clock = time.Now
	}
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	return &Manager{
		store: d.Store, runner: d.Runner, interval: d.Interval, clock: d.Clock,
		logger: d.Logger, githubToken: d.GitHubToken, state: make(map[domain.ProjectID]Status),
	}
}

// Start launches the token-free repository steward. It checkpoints immediately
// and then once per interval until the daemon context is cancelled.
func (m *Manager) Start(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			m.runAll(ctx)
			timer := time.NewTimer(m.interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	return done
}

func (m *Manager) Status(ctx context.Context, projectID domain.ProjectID) (Status, error) {
	if err := m.requireProject(ctx, projectID); err != nil {
		return Status{}, err
	}
	m.mu.RLock()
	status, ok := m.state[projectID]
	m.mu.RUnlock()
	if ok {
		return cloneStatus(status), nil
	}
	return m.Checkpoint(ctx, projectID)
}

// Checkpoint captures a recoverable commit for the project's main checkout and
// every known agent worktree, then mirrors each recovery ref to GitHub when an
// origin exists. It never changes the checked-out branch or real index.
func (m *Manager) Checkpoint(ctx context.Context, projectID domain.ProjectID) (Status, error) {
	if !m.runMu.TryLock() {
		m.mu.RLock()
		status, ok := m.state[projectID]
		m.mu.RUnlock()
		if ok {
			return cloneStatus(status), nil
		}
		m.runMu.Lock()
	}
	defer m.runMu.Unlock()

	project, found, err := m.store.GetProject(ctx, string(projectID))
	if err != nil {
		return Status{}, apierr.Internal("REPOSITORY_STEWARD_FAILED", "Could not load project for repository steward")
	}
	if !found || !project.ArchivedAt.IsZero() {
		return Status{}, apierr.NotFound("PROJECT_NOT_FOUND", "Project not found")
	}

	now := m.clock().UTC()
	previous := m.previousByName(projectID)
	status := Status{
		Agent: "Repository steward", Enabled: true, State: StateChecking,
		IntervalSeconds: int(m.interval / time.Second), LastRunAt: now,
		NextRunAt: now.Add(m.interval), Repositories: []RepositoryStatus{},
	}
	m.setStatus(projectID, status)

	targets, targetErr := m.targets(ctx, project)
	if targetErr != nil {
		status.State = StateAttention
		status.Repositories = append(status.Repositories, RepositoryStatus{Name: "Project registry", RemoteState: RemotePending, Error: targetErr.Error()})
		m.setStatus(projectID, status)
		return cloneStatus(status), nil
	}

	for _, target := range targets {
		if target.optional && !directoryExists(target.path) {
			continue
		}
		repoStatus := m.checkpointRepository(ctx, projectID, target, previous[target.name], now)
		status.Repositories = append(status.Repositories, repoStatus)
		m.setStatus(projectID, status)
	}
	status.State = summarizeState(status.Repositories)
	status.NextRunAt = m.clock().UTC().Add(m.interval)
	m.setStatus(projectID, status)
	return cloneStatus(status), nil
}

func (m *Manager) runAll(ctx context.Context) {
	projects, err := m.store.ListProjects(ctx)
	if err != nil {
		m.logger.Warn("repository steward: list projects", "err", err)
		return
	}
	for _, project := range projects {
		if ctx.Err() != nil {
			return
		}
		if _, err := m.Checkpoint(ctx, domain.ProjectID(project.ID)); err != nil {
			m.logger.Warn("repository steward checkpoint", "project", project.ID, "err", err)
		}
	}
}

type target struct {
	name     string
	path     string
	ref      string
	optional bool
}

func (m *Manager) targets(ctx context.Context, project domain.ProjectRecord) ([]target, error) {
	projectSlug := refSlug(project.ID)
	items := []target{{name: "Main checkout", path: project.Path, ref: "refs/ao/recovery/" + projectSlug + "/main"}}

	if project.Kind.WithDefault() == domain.ProjectKindWorkspace {
		repos, err := m.store.ListWorkspaceRepos(ctx, project.ID)
		if err != nil {
			return nil, fmt.Errorf("list workspace repositories: %w", err)
		}
		for _, repo := range repos {
			items = append(items, target{
				name: "Workspace · " + repo.Name,
				path: filepath.Join(project.Path, repo.RelativePath),
				ref:  "refs/ao/recovery/" + projectSlug + "/workspace-" + refSlug(repo.Name),
			})
		}
	}

	sessions, err := m.store.ListSessions(ctx, domain.ProjectID(project.ID))
	if err != nil {
		return nil, fmt.Errorf("list agent sessions: %w", err)
	}
	for _, session := range sessions {
		label := session.DisplayName
		if label == "" {
			label = string(session.ID)
		}
		sessionSlug := refSlug(string(session.ID))
		if session.Metadata.WorkspacePath != "" {
			items = append(items, target{
				name:     "Agent · " + label,
				path:     session.Metadata.WorkspacePath,
				ref:      "refs/ao/recovery/" + projectSlug + "/agent-" + sessionSlug,
				optional: true,
			})
		}
		worktrees, worktreeErr := m.store.ListSessionWorktrees(ctx, session.ID)
		if worktreeErr != nil {
			return nil, fmt.Errorf("list worktrees for %s: %w", session.ID, worktreeErr)
		}
		for _, worktree := range worktrees {
			if worktree.WorktreePath == "" {
				continue
			}
			repoName := worktree.RepoName
			if repoName == domain.RootWorkspaceRepoName {
				repoName = "root"
			}
			items = append(items, target{
				name:     "Agent · " + label + " · " + repoName,
				path:     worktree.WorktreePath,
				ref:      "refs/ao/recovery/" + projectSlug + "/agent-" + sessionSlug + "-" + refSlug(repoName),
				optional: true,
			})
		}
	}

	seen := make(map[string]struct{}, len(items))
	unique := make([]target, 0, len(items))
	for _, item := range items {
		clean := filepath.Clean(item.path)
		key := strings.ToLower(clean)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		item.path = clean
		unique = append(unique, item)
	}
	return unique, nil
}

func (m *Manager) checkpointRepository(ctx context.Context, _ domain.ProjectID, item target, previous RepositoryStatus, now time.Time) RepositoryStatus {
	status := RepositoryStatus{Name: item.name, LocalRef: item.ref, RemoteState: RemoteNotConfigured}
	if info, err := os.Stat(item.path); err != nil || !info.IsDir() {
		status.Error = "Checkout is unavailable; it will be retried automatically"
		return status
	}

	commandCtx, cancel := context.WithTimeout(ctx, defaultCommandTimeout)
	defer cancel()
	branch, err := m.gitText(commandCtx, item.path, nil, "branch", "--show-current")
	if err == nil {
		status.Branch = branch
	}
	porcelain, err := m.runner.Git(commandCtx, item.path, nil, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		status.Error = "Could not inspect checkout: " + err.Error()
		return status
	}
	status.Dirty = len(porcelain) > 0

	localSHA, changed, err := m.snapshot(commandCtx, item, now, status.Branch)
	if err != nil {
		status.Error = "Local checkpoint failed: " + err.Error()
		return status
	}
	status.LocalSHA = localSHA
	status.LastCheckpointAt = now

	origin, originErr := m.gitText(commandCtx, item.path, nil, "remote", "get-url", "origin")
	if originErr != nil || origin == "" {
		status.RemoteState = RemoteNotConfigured
		return status
	}
	if !isGitHubRemote(origin) {
		status.RemoteState = RemoteNotGitHub
		return status
	}

	status.RemoteRef = strings.Replace(item.ref, "refs/ao/recovery/", "refs/heads/ao-recovery/", 1)
	if !changed && previous.LocalSHA == localSHA && previous.RemoteState == RemoteSynced {
		status.RemoteState = RemoteSynced
		return status
	}
	syncCtx, syncCancel := context.WithTimeout(ctx, defaultSyncTimeout)
	defer syncCancel()
	pushEnv := m.pushEnvironment(syncCtx)
	// Recovery refs are not development branches. Upload LFS objects directly,
	// then bypass ordinary pre-push hooks so a flaky formatter/test hook cannot
	// prevent the off-device safety copy. The direct LFS push preserves the
	// large objects that the standard Git LFS pre-push hook would upload.
	if _, lfsErr := m.runner.Git(syncCtx, item.path, pushEnv, "lfs", "version"); lfsErr == nil {
		if _, lfsErr = m.runner.Git(syncCtx, item.path, pushEnv, "lfs", "push", "origin", item.ref); lfsErr != nil {
			status.RemoteState = RemotePending
			status.Error = "GitHub LFS backup pending; local checkpoint is safe: " + conciseError(lfsErr)
			return status
		}
	}
	_, err = m.runner.Git(syncCtx, item.path, pushEnv, "-c", "core.hooksPath="+os.DevNull, "push", "origin", item.ref+":"+status.RemoteRef)
	if err != nil {
		status.RemoteState = RemotePending
		status.Error = "GitHub backup pending; local checkpoint is safe: " + conciseError(err)
		return status
	}
	status.RemoteState = RemoteSynced
	return status
}

func (m *Manager) snapshot(ctx context.Context, item target, now time.Time, branch string) (string, bool, error) {
	index, err := os.CreateTemp("", "ao-recovery-index-*")
	if err != nil {
		return "", false, err
	}
	indexPath := index.Name()
	if closeErr := index.Close(); closeErr != nil {
		return "", false, closeErr
	}
	if err := os.Remove(indexPath); err != nil {
		return "", false, err
	}
	defer func() { _ = os.Remove(indexPath) }()

	indexEnv := []string{"GIT_INDEX_FILE=" + indexPath}
	if _, err := m.runner.Git(ctx, item.path, indexEnv, "read-tree", "HEAD"); err != nil {
		if _, emptyErr := m.runner.Git(ctx, item.path, indexEnv, "read-tree", "--empty"); emptyErr != nil {
			return "", false, emptyErr
		}
	}
	if _, err := m.runner.Git(ctx, item.path, indexEnv, "add", "-A", "--", "."); err != nil {
		return "", false, err
	}
	tree, err := m.gitText(ctx, item.path, indexEnv, "write-tree")
	if err != nil {
		return "", false, err
	}

	parent, _ := m.gitText(ctx, item.path, nil, "rev-parse", "--verify", item.ref)
	if parent == "" {
		parent, _ = m.gitText(ctx, item.path, nil, "rev-parse", "--verify", "HEAD")
	}
	if parent != "" {
		parentTree, treeErr := m.gitText(ctx, item.path, nil, "rev-parse", parent+"^{tree}")
		if treeErr == nil && parentTree == tree {
			if _, err := m.runner.Git(ctx, item.path, nil, "update-ref", item.ref, parent); err != nil {
				return "", false, err
			}
			return parent, false, nil
		}
	}

	message := fmt.Sprintf("AO recovery checkpoint · %s · %s", item.name, now.Format(time.RFC3339))
	if branch != "" {
		message += " · " + branch
	}
	args := []string{"commit-tree", tree, "-m", message}
	if parent != "" {
		args = append(args, "-p", parent)
	}
	identityEnv := append(indexEnv,
		"GIT_AUTHOR_NAME=AO Repository Steward", "GIT_AUTHOR_EMAIL=ao-recovery@local",
		"GIT_COMMITTER_NAME=AO Repository Steward", "GIT_COMMITTER_EMAIL=ao-recovery@local",
	)
	commit, err := m.gitText(ctx, item.path, identityEnv, args...)
	if err != nil {
		return "", false, err
	}
	if _, err := m.runner.Git(ctx, item.path, nil, "update-ref", item.ref, commit); err != nil {
		return "", false, err
	}
	return commit, true, nil
}

func (m *Manager) gitText(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	out, err := m.runner.Git(ctx, dir, env, args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func (m *Manager) pushEnvironment(ctx context.Context) []string {
	env := []string{"GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=Never", "GH_PROMPT_DISABLED=1"}
	if m.githubToken == nil {
		return env
	}
	token, err := m.githubToken.Token(ctx)
	if err != nil || strings.TrimSpace(token) == "" {
		return env
	}
	auth := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + strings.TrimSpace(token)))
	return append(env,
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=http.https://github.com/.extraheader",
		"GIT_CONFIG_VALUE_0=AUTHORIZATION: basic "+auth,
	)
}

func (m *Manager) requireProject(ctx context.Context, projectID domain.ProjectID) error {
	if strings.TrimSpace(string(projectID)) == "" {
		return apierr.Invalid("PROJECT_ID_REQUIRED", "Project id is required", nil)
	}
	project, found, err := m.store.GetProject(ctx, string(projectID))
	if err != nil {
		return apierr.Internal("REPOSITORY_STEWARD_FAILED", "Could not load project for repository steward")
	}
	if !found || !project.ArchivedAt.IsZero() {
		return apierr.NotFound("PROJECT_NOT_FOUND", "Project not found")
	}
	return nil
}

func (m *Manager) setStatus(projectID domain.ProjectID, status Status) {
	m.mu.Lock()
	m.state[projectID] = cloneStatus(status)
	m.mu.Unlock()
}

func (m *Manager) previousByName(projectID domain.ProjectID) map[string]RepositoryStatus {
	m.mu.RLock()
	status := m.state[projectID]
	m.mu.RUnlock()
	out := make(map[string]RepositoryStatus, len(status.Repositories))
	for _, repo := range status.Repositories {
		out[repo.Name] = repo
	}
	return out
}

func cloneStatus(status Status) Status {
	status.Repositories = append([]RepositoryStatus(nil), status.Repositories...)
	return status
}

func summarizeState(repos []RepositoryStatus) State {
	hasGitHub := false
	for _, repo := range repos {
		if repo.Error != "" || repo.RemoteState == RemotePending {
			return StateAttention
		}
		if repo.RemoteState == RemoteSynced {
			hasGitHub = true
		}
	}
	if hasGitHub {
		return StateProtected
	}
	return StateLocalOnly
}

var invalidRefChars = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func refSlug(value string) string {
	value = strings.Trim(invalidRefChars.ReplaceAllString(strings.TrimSpace(value), "-"), "-.")
	if value == "" {
		return "unnamed"
	}
	return value
}

func isGitHubRemote(origin string) bool {
	origin = strings.ToLower(origin)
	return strings.Contains(origin, "github.com/") || strings.Contains(origin, "github.com:")
}

func directoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func conciseError(err error) string {
	message := strings.Join(strings.Fields(err.Error()), " ")
	const limit = 280
	if len(message) > limit {
		return message[:limit-3] + "..."
	}
	return message
}
