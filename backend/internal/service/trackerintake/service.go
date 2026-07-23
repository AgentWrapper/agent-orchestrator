// Package trackerintake exposes GitHub issue-intake configuration data to the
// daemon API while keeping provider access outside the Electron frontend.
package trackerintake

import (
	"context"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	intakescope "github.com/aoagents/agent-orchestrator/backend/internal/trackerintake"
)

const defaultLabelCacheTTL = 5 * time.Minute

// Tracker is the provider surface needed by tracker intake configuration.
type Tracker interface {
	AuthenticatedUser(ctx context.Context) (domain.TrackerUser, error)
	List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error)
	ListLabels(ctx context.Context, repo domain.TrackerRepo) ([]domain.TrackerLabel, error)
}

// ProjectStore resolves the repository attached to a configured project.
type ProjectStore interface {
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
}

// Manager is the controller-facing tracker intake contract.
type Manager interface {
	Identity(ctx context.Context) (domain.TrackerUser, error)
	Labels(ctx context.Context, projectID domain.ProjectID, refresh bool) ([]domain.TrackerLabel, error)
	Preview(ctx context.Context, projectID domain.ProjectID, labels []string) (Preview, error)
}

// Preview is the live count of open issues matching the proposed filters.
type Preview struct {
	Count int `json:"count"`
}

// Service serves tracker intake configuration data from one GitHub adapter.
type Service struct {
	tracker  Tracker
	store    ProjectStore
	clock    func() time.Time
	cacheTTL time.Duration
	cacheMu  sync.Mutex
	labels   map[string]labelCacheEntry
}

type labelCacheEntry struct {
	labels    []domain.TrackerLabel
	expiresAt time.Time
}

// Deps contains tracker intake service dependencies.
type Deps struct {
	Tracker  Tracker
	Store    ProjectStore
	Clock    func() time.Time
	CacheTTL time.Duration
}

// New constructs a tracker intake service.
func New(tracker Tracker) *Service {
	return NewWithDeps(Deps{Tracker: tracker})
}

// NewWithDeps constructs a tracker intake service with cache controls.
func NewWithDeps(deps Deps) *Service {
	s := &Service{
		tracker:  deps.Tracker,
		store:    deps.Store,
		clock:    deps.Clock,
		cacheTTL: deps.CacheTTL,
		labels:   map[string]labelCacheEntry{},
	}
	if s.clock == nil {
		s.clock = time.Now
	}
	if s.cacheTTL <= 0 {
		s.cacheTTL = defaultLabelCacheTTL
	}
	return s
}

// Labels returns the repository label catalog, cached for five minutes unless
// refresh explicitly asks GitHub to revalidate it now.
func (s *Service) Labels(ctx context.Context, projectID domain.ProjectID, refresh bool) ([]domain.TrackerLabel, error) {
	if s == nil || s.tracker == nil || s.store == nil {
		return nil, apierr.Internal("GITHUB_LABELS_UNAVAILABLE", "GitHub labels are unavailable")
	}
	repo, err := s.repository(ctx, projectID)
	if err != nil {
		return nil, err
	}

	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	now := s.clock().UTC()
	if cached, exists := s.labels[repo.Native]; exists && !refresh && now.Before(cached.expiresAt) {
		return cloneLabels(cached.labels), nil
	}
	labels, err := s.tracker.ListLabels(ctx, repo)
	if err != nil {
		return nil, apierr.Internal("GITHUB_LABELS_FAILED", "Failed to load GitHub repository labels")
	}
	s.labels[repo.Native] = labelCacheEntry{labels: cloneLabels(labels), expiresAt: now.Add(s.cacheTTL)}
	return cloneLabels(labels), nil
}

// Preview counts open issues matching the authenticated user and proposed
// label selection without persisting config or spawning sessions.
func (s *Service) Preview(ctx context.Context, projectID domain.ProjectID, labels []string) (Preview, error) {
	if s == nil || s.tracker == nil || s.store == nil {
		return Preview{}, apierr.Internal("GITHUB_PREVIEW_UNAVAILABLE", "GitHub issue preview is unavailable")
	}
	if err := (domain.TrackerIntakeConfig{Enabled: true, Labels: labels}).Validate(); err != nil {
		return Preview{}, apierr.Invalid("INVALID_TRACKER_INTAKE_FILTER", err.Error(), nil)
	}
	repo, err := s.repository(ctx, projectID)
	if err != nil {
		return Preview{}, err
	}
	user, err := s.Identity(ctx)
	if err != nil {
		return Preview{}, err
	}
	issues, err := s.tracker.List(ctx, repo, domain.ListFilter{State: domain.ListOpen, Assignee: user.Login})
	if err != nil {
		return Preview{}, apierr.Internal("GITHUB_PREVIEW_FAILED", "Failed to preview matching GitHub issues")
	}
	count := 0
	for _, issue := range issues {
		if issue.State == domain.IssueOpen && intakescope.MatchesAssignee(issue.Assignees, user.Login) && intakescope.MatchesAnyLabel(issue.Labels, labels) {
			count++
		}
	}
	return Preview{Count: count}, nil
}

func (s *Service) repository(ctx context.Context, projectID domain.ProjectID) (domain.TrackerRepo, error) {
	project, ok, err := s.store.GetProject(ctx, string(projectID))
	if err != nil {
		return domain.TrackerRepo{}, apierr.Internal("PROJECT_LOAD_FAILED", "Failed to load project")
	}
	if !ok || !project.ArchivedAt.IsZero() {
		return domain.TrackerRepo{}, apierr.NotFound("PROJECT_NOT_FOUND", "Unknown project")
	}
	repo, ok := intakescope.Repository(project, project.Config.TrackerIntake.WithDefaults())
	if !ok {
		return domain.TrackerRepo{}, apierr.Invalid("GITHUB_REPOSITORY_UNAVAILABLE", "Project has no GitHub repository for issue intake", nil)
	}
	return repo, nil
}

func cloneLabels(labels []domain.TrackerLabel) []domain.TrackerLabel {
	out := make([]domain.TrackerLabel, len(labels))
	copy(out, labels)
	return out
}

// Identity returns the authenticated GitHub login used for assignee filtering.
func (s *Service) Identity(ctx context.Context) (domain.TrackerUser, error) {
	if s == nil || s.tracker == nil {
		return domain.TrackerUser{}, apierr.Internal("GITHUB_IDENTITY_UNAVAILABLE", "GitHub identity is unavailable")
	}
	user, err := s.tracker.AuthenticatedUser(ctx)
	if err != nil {
		return domain.TrackerUser{}, apierr.Internal("GITHUB_IDENTITY_FAILED", "Failed to resolve authenticated GitHub user")
	}
	return user, nil
}

var _ Manager = (*Service)(nil)
