// Package coordinatorwake periodically wakes opted-in idle coordinators while
// their project still has live workers.
package coordinatorwake

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe"
)

const (
	defaultTick     = 30 * time.Second
	defaultCooldown = 30 * time.Second

	// WakeMessage is intentionally fixed and contains no provider or worker text.
	WakeMessage = "[AO coordinator wake]\nRun `ao status`, inspect active workers and pull/merge requests, and continue coordination. Do not create duplicate workers."
)

// Store is the read-only durable state needed by the wake runner.
type Store interface {
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
}

// Sender delivers one instruction through the normal session send path.
type Sender interface {
	Send(ctx context.Context, id domain.SessionID, message string) error
}

// Config controls polling and the in-memory per-project cooldown.
type Config struct {
	Tick     time.Duration
	Cooldown time.Duration
	Clock    func() time.Time
	Logger   *slog.Logger
}

// Runner owns the small amount of process-local wake state.
type Runner struct {
	store    Store
	sender   Sender
	tick     time.Duration
	cooldown time.Duration
	clock    func() time.Time
	logger   *slog.Logger

	mu       sync.Mutex
	lastSent map[domain.ProjectID]time.Time
}

// New constructs a coordinator wake runner. Projects remain disabled unless
// their project config explicitly sets coordinator.autoWake.
func New(store Store, sender Sender, cfg Config) *Runner {
	if cfg.Tick <= 0 {
		cfg.Tick = defaultTick
	}
	if cfg.Cooldown <= 0 {
		cfg.Cooldown = defaultCooldown
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Runner{
		store: store, sender: sender, tick: cfg.Tick, cooldown: cfg.Cooldown,
		clock: cfg.Clock, logger: cfg.Logger, lastSent: make(map[domain.ProjectID]time.Time),
	}
}

// Start polls immediately and then on the configured interval until ctx ends.
func (r *Runner) Start(ctx context.Context) <-chan struct{} {
	return observe.StartPollLoop(ctx, r.tick, r.Poll, r.logger, "coordinator wake")
}

// Poll sends at most one wake per eligible project.
func (r *Runner) Poll(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	projects, err := r.store.ListProjects(ctx)
	if err != nil {
		return fmt.Errorf("list projects: %w", err)
	}
	sessions, err := r.store.ListAllSessions(ctx)
	if err != nil {
		return fmt.Errorf("list sessions: %w", err)
	}

	hasWorker := make(map[domain.ProjectID]bool)
	latestOrchestrator := make(map[domain.ProjectID]domain.SessionRecord)
	for _, session := range sessions {
		if session.IsTerminated {
			continue
		}
		switch session.Kind {
		case domain.KindWorker:
			if session.Activity.State != domain.ActivityExited {
				hasWorker[session.ProjectID] = true
			}
		case domain.KindOrchestrator:
			current, ok := latestOrchestrator[session.ProjectID]
			if !ok || newer(session, current) {
				latestOrchestrator[session.ProjectID] = session
			}
		}
	}

	now := r.clock().UTC()
	var sendErrors []error
	for _, project := range projects {
		if err := ctx.Err(); err != nil {
			return err
		}
		projectID := domain.ProjectID(project.ID)
		if !project.Config.Coordinator.AutoWake || !hasWorker[projectID] || r.coolingDown(projectID, now) {
			continue
		}
		orchestrator, ok := latestOrchestrator[projectID]
		if !ok || (orchestrator.Activity.State != domain.ActivityIdle && orchestrator.Activity.State != domain.ActivityWaitingInput) {
			continue
		}
		if err := r.sender.Send(ctx, orchestrator.ID, WakeMessage); err != nil {
			sendErrors = append(sendErrors, fmt.Errorf("wake project %s coordinator %s: %w", project.ID, orchestrator.ID, err))
			continue
		}
		r.mu.Lock()
		r.lastSent[projectID] = now
		r.mu.Unlock()
	}
	return errors.Join(sendErrors...)
}

func (r *Runner) coolingDown(projectID domain.ProjectID, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	last, ok := r.lastSent[projectID]
	return ok && now.Sub(last) < r.cooldown
}

func newer(candidate, current domain.SessionRecord) bool {
	if !candidate.CreatedAt.Equal(current.CreatedAt) {
		return candidate.CreatedAt.After(current.CreatedAt)
	}
	if !candidate.UpdatedAt.Equal(current.UpdatedAt) {
		return candidate.UpdatedAt.After(current.UpdatedAt)
	}
	return candidate.ID > current.ID
}
