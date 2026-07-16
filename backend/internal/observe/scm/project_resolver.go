package scm

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const defaultRateLimitBackoff = 5 * time.Minute

// ResolvedProvider is one project connection's normalized SCM adapter.
// ConnectionID is the isolation key for batches, provider revisions, and
// rate-limit backoff.
type ResolvedProvider struct {
	Provider     Provider
	ConnectionID string
}

// ProjectProviderResolver resolves the current provider connection from the
// project's persisted configuration on every poll.
type ProjectProviderResolver interface {
	ResolveSCM(ctx context.Context, project domain.ProjectRecord) (ResolvedProvider, error)
}

type providerLane struct {
	provider           Provider
	store              *projectScopedStore
	observer           *Observer
	backoffUntil       time.Time
	lastReconciliation time.Time
}

type resolvedGroup struct {
	provider   Provider
	projectIDs map[domain.ProjectID]struct{}
}

// NewWithResolver constructs a project-scoped observer. Existing callers that
// already own one Provider continue to use New unchanged.
func NewWithResolver(resolver ProjectProviderResolver, store Store, lifecycle Lifecycle, cfg Config) *Observer {
	o := New(nil, store, lifecycle, cfg)
	o.resolver = resolver
	o.lanes = make(map[string]*providerLane)
	return o
}

func (o *Observer) pollResolved(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	sessions, err := o.store.ListAllSessions(ctx)
	if err != nil {
		return err
	}

	projects := make(map[domain.ProjectID]domain.ProjectRecord)
	for _, session := range sessions {
		if session.IsTerminated || strings.TrimSpace(session.Metadata.Branch) == "" {
			continue
		}
		if _, loaded := projects[session.ProjectID]; loaded {
			continue
		}
		project, found, err := o.store.GetProject(ctx, string(session.ProjectID))
		if err != nil {
			return err
		}
		if !found || !project.ArchivedAt.IsZero() {
			continue
		}
		projects[session.ProjectID] = project
	}

	groups := make(map[string]*resolvedGroup)
	for projectID, project := range projects {
		resolved, err := o.resolver.ResolveSCM(ctx, project)
		if err != nil {
			o.logger.Warn("scm observer: project provider resolution failed", "project", project.ID, "err", err)
			continue
		}
		if resolved.Provider == nil {
			o.logger.Warn("scm observer: project provider resolution returned no SCM adapter", "project", project.ID)
			continue
		}
		connectionID := strings.TrimSpace(resolved.ConnectionID)
		if connectionID == "" {
			connectionID = project.Config.SCM.WithDefaults().ConnectionID
		}
		if connectionID == "" {
			connectionID = string(projectID)
		}
		scope := string(project.Config.SCM.WithDefaults().Provider) + ":" + connectionID
		group := groups[scope]
		if group == nil {
			group = &resolvedGroup{provider: resolved.Provider, projectIDs: make(map[domain.ProjectID]struct{})}
			groups[scope] = group
		}
		group.projectIDs[projectID] = struct{}{}
	}

	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	now := o.clock().UTC()
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return err
		}
		group := groups[key]
		lane := o.lane(key, group.provider)
		lane.store.setProjects(group.projectIDs)
		if now.Before(lane.backoffUntil) {
			o.logger.Debug("scm observer: connection in rate-limit backoff", "connection", key, "until", lane.backoffUntil)
			continue
		}
		full := lane.lastReconciliation.IsZero() || now.Sub(lane.lastReconciliation) >= o.fullReconcileInterval
		if full {
			lane.observer.Cache = newCache(lane.observer.Cache.max)
		}
		recorder := &rateLimitRecorder{Provider: group.provider, now: now}
		lane.observer.provider = recorder
		if err := lane.observer.pollProvider(ctx); err != nil {
			if errors.Is(err, context.Canceled) {
				return err
			}
			o.logger.Error("scm observer: connection poll failed", "connection", key, "err", err)
		}
		if delay, limited := recorder.backoff(); limited {
			lane.backoffUntil = now.Add(delay)
			continue
		}
		lane.backoffUntil = time.Time{}
		if full {
			lane.lastReconciliation = now
		}
	}
	return nil
}

func (o *Observer) lane(key string, provider Provider) *providerLane {
	if lane := o.lanes[key]; lane != nil {
		if !sameProvider(lane.provider, provider) {
			lane.provider = provider
			lane.observer.provider = provider
			lane.observer.credentialsChecked = false
			lane.observer.disabled = false
			lane.observer.Cache = newCache(lane.observer.Cache.max)
			lane.lastReconciliation = time.Time{}
			lane.backoffUntil = time.Time{}
		}
		return lane
	}
	scoped := &projectScopedStore{Store: o.store}
	laneObserver := New(provider, scoped, o.lifecycle, Config{
		Tick: o.tick, ReviewInterval: o.reviewInterval, Clock: o.clock,
		Logger: o.logger, CacheMax: o.Cache.max, FullReconcileInterval: o.fullReconcileInterval,
	})
	lane := &providerLane{provider: provider, store: scoped, observer: laneObserver}
	o.lanes[key] = lane
	return lane
}

func sameProvider(left, right Provider) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	leftValue, rightValue := reflect.ValueOf(left), reflect.ValueOf(right)
	if leftValue.Type() != rightValue.Type() || !leftValue.Type().Comparable() {
		return false
	}
	return leftValue.Interface() == rightValue.Interface()
}

type projectScopedStore struct {
	Store
	mu       sync.RWMutex
	projects map[domain.ProjectID]struct{}
}

func (s *projectScopedStore) setProjects(projects map[domain.ProjectID]struct{}) {
	copyOf := make(map[domain.ProjectID]struct{}, len(projects))
	for id := range projects {
		copyOf[id] = struct{}{}
	}
	s.mu.Lock()
	s.projects = copyOf
	s.mu.Unlock()
}

func (s *projectScopedStore) ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error) {
	sessions, err := s.Store.ListAllSessions(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	filtered := make([]domain.SessionRecord, 0, len(sessions))
	for _, session := range sessions {
		if _, ok := s.projects[session.ProjectID]; ok {
			filtered = append(filtered, session)
		}
	}
	return filtered, nil
}

// rateLimitRecorder observes provider errors without coupling the neutral
// observer to either provider adapter's concrete error type.
type rateLimitRecorder struct {
	Provider
	now time.Time
	mu  sync.Mutex
	err error
}

func (p *rateLimitRecorder) record(err error) {
	var rateLimit ports.SCMRateLimitError
	if err == nil || !errors.As(err, &rateLimit) {
		return
	}
	p.mu.Lock()
	if p.err == nil {
		p.err = err
	}
	p.mu.Unlock()
}

func (p *rateLimitRecorder) SCMCredentialsAvailable(ctx context.Context) (bool, error) {
	checker, ok := p.Provider.(credentialChecker)
	if !ok {
		return true, nil
	}
	available, err := checker.SCMCredentialsAvailable(ctx)
	p.record(err)
	return available, err
}

func (p *rateLimitRecorder) RepoPRListGuard(ctx context.Context, repo ports.SCMRepo, revision string) (ports.SCMGuardResult, error) {
	result, err := p.Provider.RepoPRListGuard(ctx, repo, revision)
	p.record(err)
	return result, err
}

func (p *rateLimitRecorder) ListOpenPRsByRepo(ctx context.Context, repo ports.SCMRepo) ([]ports.SCMPRObservation, error) {
	result, err := p.Provider.ListOpenPRsByRepo(ctx, repo)
	p.record(err)
	return result, err
}

func (p *rateLimitRecorder) CommitChecksGuard(ctx context.Context, repo ports.SCMRepo, sha, revision string) (ports.SCMGuardResult, error) {
	result, err := p.Provider.CommitChecksGuard(ctx, repo, sha, revision)
	p.record(err)
	return result, err
}

func (p *rateLimitRecorder) FetchPullRequests(ctx context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	result, err := p.Provider.FetchPullRequests(ctx, refs)
	p.record(err)
	return result, err
}

func (p *rateLimitRecorder) FetchFailedCheckLogTail(ctx context.Context, repo ports.SCMRepo, check ports.SCMCheckObservation) (string, error) {
	result, err := p.Provider.FetchFailedCheckLogTail(ctx, repo, check)
	p.record(err)
	return result, err
}

func (p *rateLimitRecorder) FetchReviewThreads(ctx context.Context, ref ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	result, err := p.Provider.FetchReviewThreads(ctx, ref)
	p.record(err)
	return result, err
}

func (p *rateLimitRecorder) backoff() (time.Duration, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err == nil {
		return 0, false
	}
	var rateLimit ports.SCMRateLimitError
	if errors.As(p.err, &rateLimit) {
		if delay := rateLimit.RateLimitDelay(p.now); delay > 0 {
			return delay, true
		}
	}
	return defaultRateLimitBackoff, true
}
