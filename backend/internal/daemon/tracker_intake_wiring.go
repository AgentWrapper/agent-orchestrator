package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	trackergithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/github"
	trackerjira "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/jira"
	trackerlinear "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/linear"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	trackerintake "github.com/aoagents/agent-orchestrator/backend/internal/observe/trackerintake"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// startTrackerIntake wires the opt-in issue-intake loop. Each provider's
// adapter is constructed lazily on first use so daemon startup and projects
// that don't use a given provider do not pay an auth or network cost.
func startTrackerIntake(ctx context.Context, store *sqlite.Store, sessions *sessionsvc.Service, logger *slog.Logger) <-chan struct{} {
	resolver := newMultiTrackerResolver(logger)
	observer := trackerintake.New(resolver, store, sessions, trackerintake.Config{Logger: logger})
	return observer.Start(ctx)
}

// multiTrackerResolver routes per project's configured provider to a lazy
// adapter. It implements trackerintake.TrackerResolver.
type multiTrackerResolver struct {
	logger *slog.Logger

	githubOnce sync.Once
	github     *lazyGitHubTracker

	linearOnce sync.Once
	linear     *lazyLinearTracker

	jiraOnce sync.Once
	jira     *lazyJiraTracker
}

func newMultiTrackerResolver(logger *slog.Logger) *multiTrackerResolver {
	return &multiTrackerResolver{logger: logger}
}

// Tracker returns the lazy adapter for the configured provider, constructing
// it on first request.
func (r *multiTrackerResolver) Tracker(provider domain.TrackerProvider) (ports.Tracker, error) {
	switch provider {
	case "", domain.TrackerProviderGitHub:
		r.githubOnce.Do(func() { r.github = newLazyGitHubTracker(r.logger) })
		return r.github, nil
	case domain.TrackerProviderLinear:
		r.linearOnce.Do(func() { r.linear = newLazyLinearTracker(r.logger) })
		return r.linear, nil
	case domain.TrackerProviderJira:
		r.jiraOnce.Do(func() { r.jira = newLazyJiraTracker(r.logger) })
		return r.jira, nil
	default:
		return nil, fmt.Errorf("tracker intake: unknown provider %q", provider)
	}
}

// ---------------------------------------------------------------------------
// GitHub lazy adapter (token sourced from env or gh CLI fallback)
// ---------------------------------------------------------------------------

type lazyGitHubTracker struct {
	logger  *slog.Logger
	tokens  *trackerTokenSource
	mu      sync.Mutex
	tracker ports.Tracker
}

func newLazyGitHubTracker(logger *slog.Logger) *lazyGitHubTracker {
	return &lazyGitHubTracker{logger: logger, tokens: &trackerTokenSource{}}
}

func (t *lazyGitHubTracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	tracker, err := t.resolve()
	if err != nil {
		return domain.Issue{}, err
	}
	return tracker.Get(ctx, id)
}

func (t *lazyGitHubTracker) List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	tracker, err := t.resolve()
	if err != nil {
		return nil, err
	}
	return tracker.List(ctx, repo, filter)
}

func (t *lazyGitHubTracker) Preflight(ctx context.Context) error {
	tracker, err := t.resolve()
	if err != nil {
		return err
	}
	return tracker.Preflight(ctx)
}

func (t *lazyGitHubTracker) resolve() (ports.Tracker, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tracker != nil {
		return t.tracker, nil
	}
	tracker, err := trackergithub.New(trackergithub.Options{Token: t.tokens})
	if err != nil {
		if errors.Is(err, trackergithub.ErrNoToken) {
			t.logger.Warn("tracker intake disabled: no usable GitHub token", "err", err)
		}
		return nil, err
	}
	t.tracker = tracker
	return tracker, nil
}

const (
	trackerTokenCacheTTL       = 5 * time.Minute
	trackerTokenCommandTimeout = 5 * time.Second
)

// trackerTokenSource mirrors the SCM credential precedence while returning the
// tracker adapter's own ErrNoToken sentinel.
type trackerTokenSource struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

func (s *trackerTokenSource) Token(ctx context.Context) (string, error) {
	env := trackergithub.EnvTokenSource{EnvVars: []string{"AO_GITHUB_TOKEN"}}
	if tok, err := env.Token(ctx); err == nil {
		return tok, nil
	} else if !errors.Is(err, trackergithub.ErrNoToken) {
		return "", err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if s.token != "" && now.Before(s.expiresAt) {
		return s.token, nil
	}
	cmdCtx, cancel := context.WithTimeout(ctx, trackerTokenCommandTimeout)
	defer cancel()
	out, err := aoprocess.CommandContext(cmdCtx, "gh", "auth", "token").Output()
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(out))
	if token == "" {
		return "", trackergithub.ErrNoToken
	}
	s.token = token
	s.expiresAt = now.Add(trackerTokenCacheTTL)
	return token, nil
}

// ---------------------------------------------------------------------------
// Linear lazy adapter (env-only token)
// ---------------------------------------------------------------------------

type lazyLinearTracker struct {
	logger  *slog.Logger
	mu      sync.Mutex
	tracker ports.Tracker
}

func newLazyLinearTracker(logger *slog.Logger) *lazyLinearTracker {
	return &lazyLinearTracker{logger: logger}
}

func (t *lazyLinearTracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	tracker, err := t.resolve()
	if err != nil {
		return domain.Issue{}, err
	}
	return tracker.Get(ctx, id)
}

func (t *lazyLinearTracker) List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	tracker, err := t.resolve()
	if err != nil {
		return nil, err
	}
	return tracker.List(ctx, repo, filter)
}

func (t *lazyLinearTracker) Preflight(ctx context.Context) error {
	tracker, err := t.resolve()
	if err != nil {
		return err
	}
	return tracker.Preflight(ctx)
}

func (t *lazyLinearTracker) resolve() (ports.Tracker, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tracker != nil {
		return t.tracker, nil
	}
	tokens := trackerlinear.EnvTokenSource{EnvVars: []string{"AO_LINEAR_TOKEN"}}
	tracker, err := trackerlinear.New(trackerlinear.Options{Token: tokens})
	if err != nil {
		if errors.Is(err, trackerlinear.ErrNoToken) {
			t.logger.Warn("tracker intake disabled: no usable Linear token", "err", err)
		}
		return nil, err
	}
	t.tracker = tracker
	return tracker, nil
}

// ---------------------------------------------------------------------------
// Jira lazy adapter (env-only email + token)
// ---------------------------------------------------------------------------

type lazyJiraTracker struct {
	logger  *slog.Logger
	mu      sync.Mutex
	tracker ports.Tracker
}

func newLazyJiraTracker(logger *slog.Logger) *lazyJiraTracker {
	return &lazyJiraTracker{logger: logger}
}

func (t *lazyJiraTracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	tracker, err := t.resolve()
	if err != nil {
		return domain.Issue{}, err
	}
	return tracker.Get(ctx, id)
}

func (t *lazyJiraTracker) List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	tracker, err := t.resolve()
	if err != nil {
		return nil, err
	}
	return tracker.List(ctx, repo, filter)
}

func (t *lazyJiraTracker) Preflight(ctx context.Context) error {
	tracker, err := t.resolve()
	if err != nil {
		return err
	}
	return tracker.Preflight(ctx)
}

func (t *lazyJiraTracker) resolve() (ports.Tracker, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tracker != nil {
		return t.tracker, nil
	}
	creds := trackerjira.EnvCredentials{
		EmailVars: []string{"AO_JIRA_EMAIL"},
		TokenVars: []string{"AO_JIRA_TOKEN"},
	}
	tracker, err := trackerjira.New(trackerjira.Options{Credentials: creds})
	if err != nil {
		if errors.Is(err, trackerjira.ErrNoCredentials) {
			t.logger.Warn("tracker intake disabled: no usable Jira credentials", "err", err)
		}
		return nil, err
	}
	t.tracker = tracker
	return tracker, nil
}
