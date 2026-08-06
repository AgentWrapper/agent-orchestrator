// Package autoreview decides when the daemon may automatically review a
// worker's current pull-request heads.
package autoreview

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
)

const (
	// DefaultIdleThreshold is how long a worker must remain idle before an
	// automatic review may start.
	DefaultIdleThreshold = time.Minute
	// DefaultSweepInterval is the cadence for reevaluating live sessions.
	DefaultSweepInterval = 30 * time.Second
)

// Store provides the durable session, project, PR, and review facts used by
// the coordinator.
type Store interface {
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	ListAllSessions(context.Context) ([]domain.SessionRecord, error)
	GetProject(context.Context, string) (domain.ProjectRecord, bool, error)
	ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error)
	ListReviewRunsBySession(context.Context, domain.SessionID) ([]domain.ReviewRun, error)
}

// Trigger starts a source-tagged automatic review through the normal review
// engine.
type Trigger interface {
	TriggerAuto(context.Context, domain.SessionID, domain.ReviewerHarness) (reviewcore.TriggerResult, error)
}

// Result describes whether an evaluation started a review and why it skipped
// or triggered.
type Result struct {
	Triggered bool
	Reason    string
}

// Coordinator evaluates auto-review policy and owns the periodic sweep.
type Coordinator struct {
	store         Store
	reviews       Trigger
	clock         func() time.Time
	idleThreshold time.Duration
	sweepInterval time.Duration
	logger        *slog.Logger
}

// Config customizes coordinator timing and logging.
type Config struct {
	Clock         func() time.Time
	IdleThreshold time.Duration
	SweepInterval time.Duration
	Logger        *slog.Logger
}

// New constructs an auto-review coordinator.
func New(store Store, reviews Trigger, cfg Config) *Coordinator {
	c := &Coordinator{store: store, reviews: reviews, clock: cfg.Clock, idleThreshold: cfg.IdleThreshold, sweepInterval: cfg.SweepInterval, logger: cfg.Logger}
	if c.clock == nil {
		c.clock = time.Now
	}
	if c.idleThreshold <= 0 {
		c.idleThreshold = DefaultIdleThreshold
	}
	if c.sweepInterval <= 0 {
		c.sweepInterval = DefaultSweepInterval
	}
	if c.logger == nil {
		c.logger = slog.Default()
	}
	return c
}

// EvaluateSession evaluates one worker against the current project, activity,
// PR, and review-run facts.
func (c *Coordinator) EvaluateSession(ctx context.Context, id domain.SessionID) (Result, error) {
	session, ok, err := c.store.GetSession(ctx, id)
	if err != nil || !ok {
		if err == nil {
			return Result{Reason: "session_not_found"}, nil
		}
		return Result{}, err
	}
	project, ok, err := c.store.GetProject(ctx, string(session.ProjectID))
	if err != nil || !ok {
		if err == nil {
			return Result{Reason: "project_not_found"}, nil
		}
		return Result{}, err
	}
	if reason := sessionGate(session, project.Config, c.clock(), c.idleThreshold); reason != "" {
		return Result{Reason: reason}, nil
	}
	prs, err := c.store.ListPRsBySession(ctx, id)
	if err != nil {
		return Result{}, err
	}
	runs, err := c.store.ListReviewRunsBySession(ctx, id)
	if err != nil {
		return Result{}, err
	}
	harness := session.ReviewerHarness
	if harness == "" {
		harness = project.Config.ResolveReviewerHarness(session.Harness)
	}
	harnessRuns := make([]domain.ReviewRun, 0, len(runs))
	for _, run := range runs {
		if run.Harness == harness || run.Harness == "" {
			harnessRuns = append(harnessRuns, run)
		}
	}
	states := reviewcore.Plan(prs, harnessRuns)
	eligible := false
	for _, state := range states {
		if state.Status == reviewcore.ReviewStateNeedsReview && !changesRequestedForHead(runs, state.PRURL, state.TargetSHA) {
			eligible = true
			break
		}
	}
	if !eligible {
		return Result{Reason: "no_review_due"}, nil
	}
	result, err := c.reviews.TriggerAuto(ctx, id, harness)
	if err != nil {
		return Result{}, fmt.Errorf("trigger auto review for %s: %w", id, err)
	}
	return Result{Triggered: result.Created, Reason: "triggered"}, nil
}

func changesRequestedForHead(runs []domain.ReviewRun, prURL, targetSHA string) bool {
	for _, run := range runs {
		if run.PRURL == prURL && run.TargetSHA == targetSHA && run.Verdict == domain.VerdictChangesRequested {
			return true
		}
	}
	return false
}

func sessionGate(session domain.SessionRecord, config domain.ProjectConfig, now time.Time, threshold time.Duration) string {
	if !config.AutoReview.Enabled {
		return "disabled"
	}
	if session.Kind != domain.KindWorker {
		return "not_worker"
	}
	if session.IsTerminated {
		return "terminated"
	}
	if session.Activity.State != domain.ActivityIdle {
		return "not_idle"
	}
	if session.Activity.LastActivityAt.IsZero() || now.Sub(session.Activity.LastActivityAt) < threshold {
		return "idle_threshold"
	}
	return ""
}

// Sweep evaluates every known session, isolating per-session failures.
func (c *Coordinator) Sweep(ctx context.Context) error {
	sessions, err := c.store.ListAllSessions(ctx)
	if err != nil {
		return err
	}
	for _, session := range sessions {
		if _, err := c.EvaluateSession(ctx, session.ID); err != nil {
			c.logger.Error("auto-review: evaluate session failed", "session_id", session.ID, "err", err)
		}
	}
	return nil
}

// Start runs periodic auto-review sweeps until ctx is cancelled.
func (c *Coordinator) Start(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(c.sweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := c.Sweep(ctx); err != nil {
					c.logger.Error("auto-review: sweep failed", "err", err)
				}
			}
		}
	}()
	return done
}
