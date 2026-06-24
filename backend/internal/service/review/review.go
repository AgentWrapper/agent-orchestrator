// Package review is the daemon's HTTP-facing code-review service boundary. The
// core orchestration lives in internal/review; this layer is the thin contract
// the API controller depends on and delegates to the engine, so the same engine
// can also back a future in-process CLI trigger.
package review

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
)

// ErrInvalid and ErrNotFound re-export the engine sentinels so the HTTP
// controller maps service failures to 422/404 without importing the core.
var (
	ErrInvalid             = reviewcore.ErrInvalid
	ErrNotFound            = reviewcore.ErrNotFound
	ErrAgentBinaryNotFound = ports.ErrAgentBinaryNotFound
)

// Manager is the reviews surface the HTTP controller depends on.
type Manager interface {
	Trigger(ctx context.Context, workerID domain.SessionID) (reviewcore.TriggerResult, error)
	Submit(ctx context.Context, workerID domain.SessionID, runID string, verdict domain.ReviewVerdict, body, githubReviewID string) (domain.ReviewRun, error)
	List(ctx context.Context, workerID domain.SessionID) (reviewcore.SessionReviews, error)
}

// Service is the API-facing review service. It delegates to the core engine.
type Service struct {
	engine    *reviewcore.Engine
	store     Store
	lifecycle Reducer
	clock     func() time.Time

	drainMu    sync.Mutex
	drainLocks map[string]*sync.Mutex
}

var _ Manager = (*Service)(nil)

// Store is the review_run persistence surface owned by the service submit path.
type Store interface {
	GetReviewRun(ctx context.Context, id string) (domain.ReviewRun, bool, error)
	UpdateReviewRunResult(ctx context.Context, id string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string) (bool, error)
	MarkReviewRunDelivered(ctx context.Context, id string, deliveredAt time.Time) (bool, error)
	ListReviewRunsByBatch(ctx context.Context, id domain.SessionID, batchID string) ([]domain.ReviewRun, error)
	ListPRsBySession(ctx context.Context, id domain.SessionID) ([]domain.PullRequest, error)
}

// Reducer is the lifecycle reaction boundary used after a review result has
// been persisted.
type Reducer interface {
	ApplyReviewResult(ctx context.Context, workerID domain.SessionID, result lifecycle.ReviewResult) (lifecycle.ReviewDeliveryOutcome, error)
	ApplyReviewBatch(ctx context.Context, workerID domain.SessionID, batchID string, results []lifecycle.ReviewResult) (lifecycle.ReviewDeliveryOutcome, error)
}

// Option customizes the review service.
type Option func(*Service)

// WithLifecycleReducer wires post-submit review delivery through lifecycle.
func WithLifecycleReducer(r Reducer) Option {
	return func(s *Service) { s.lifecycle = r }
}

// WithClock overrides the service clock for tests.
func WithClock(clock func() time.Time) Option {
	return func(s *Service) { s.clock = clock }
}

// New wraps a core review engine as the API-facing service.
func New(engine *reviewcore.Engine, store Store, opts ...Option) *Service {
	s := &Service{
		engine:     engine,
		store:      store,
		clock:      func() time.Time { return time.Now().UTC() },
		drainLocks: make(map[string]*sync.Mutex),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Trigger starts (or reuses) a review pass for a worker's PR.
func (s *Service) Trigger(ctx context.Context, workerID domain.SessionID) (reviewcore.TriggerResult, error) {
	return s.engine.Trigger(ctx, workerID)
}

// Submit records a reviewer's result for a specific worker review pass.
func (s *Service) Submit(ctx context.Context, workerID domain.SessionID, runID string, verdict domain.ReviewVerdict, body, githubReviewID string) (domain.ReviewRun, error) {
	if workerID == "" {
		return domain.ReviewRun{}, fmt.Errorf("%w: worker session id is required", ErrInvalid)
	}
	if runID == "" {
		return domain.ReviewRun{}, fmt.Errorf("%w: review run id is required", ErrInvalid)
	}
	if !verdict.Valid() {
		return domain.ReviewRun{}, fmt.Errorf("%w: verdict must be %q or %q", ErrInvalid, domain.VerdictApproved, domain.VerdictChangesRequested)
	}
	if verdict == domain.VerdictChangesRequested && body == "" {
		return domain.ReviewRun{}, fmt.Errorf("%w: a changes_requested review requires a body", ErrInvalid)
	}
	if s.store == nil {
		return domain.ReviewRun{}, fmt.Errorf("review service store is not configured")
	}
	run, ok, err := s.store.GetReviewRun(ctx, runID)
	if err != nil {
		return domain.ReviewRun{}, err
	}
	if !ok {
		return domain.ReviewRun{}, fmt.Errorf("%w: review run %q", ErrNotFound, runID)
	}
	if run.SessionID != workerID {
		return domain.ReviewRun{}, fmt.Errorf("%w: review run %q does not belong to worker %q", ErrInvalid, runID, workerID)
	}

	switch run.Status {
	case domain.ReviewRunRunning:
		updated, err := s.store.UpdateReviewRunResult(ctx, run.ID, domain.ReviewRunComplete, verdict, body, githubReviewID)
		if err != nil {
			return domain.ReviewRun{}, err
		}
		if !updated {
			return domain.ReviewRun{}, fmt.Errorf("%w: review run %q is not running", ErrInvalid, runID)
		}
		run.Status = domain.ReviewRunComplete
		run.Verdict = verdict
		run.Body = body
		run.GithubReviewID = githubReviewID
	case domain.ReviewRunComplete:
		if run.Verdict != verdict {
			return domain.ReviewRun{}, fmt.Errorf("%w: review run %q already recorded verdict %q", ErrInvalid, runID, run.Verdict)
		}
		if body != "" && body != run.Body {
			return domain.ReviewRun{}, fmt.Errorf("%w: review run %q already recorded a different body", ErrInvalid, runID)
		}
		if githubReviewID != "" && githubReviewID != run.GithubReviewID {
			return domain.ReviewRun{}, fmt.Errorf("%w: review run %q already recorded GitHub review id %q", ErrInvalid, runID, run.GithubReviewID)
		}
	case domain.ReviewRunDelivered:
		return run, nil
	default:
		return domain.ReviewRun{}, fmt.Errorf("%w: review run %q is not running", ErrInvalid, runID)
	}

	if s.lifecycle == nil {
		return run, nil
	}
	if run.BatchID != "" {
		return s.drainBatch(ctx, workerID, run)
	}
	outcome, err := s.lifecycle.ApplyReviewResult(ctx, workerID, lifecycle.ReviewResult{
		RunID:          run.ID,
		BatchID:        run.BatchID,
		WorkerID:       workerID,
		PRURL:          run.PRURL,
		TargetSHA:      run.TargetSHA,
		Verdict:        run.Verdict,
		Body:           run.Body,
		GithubReviewID: run.GithubReviewID,
		DeliveredAt:    run.DeliveredAt,
	})
	if err != nil {
		return domain.ReviewRun{}, err
	}
	if outcome == lifecycle.ReviewDeliverySent {
		deliveredAt := s.clock()
		updated, err := s.store.MarkReviewRunDelivered(ctx, run.ID, deliveredAt)
		if err != nil {
			return domain.ReviewRun{}, err
		}
		if updated {
			run.Status = domain.ReviewRunDelivered
			run.DeliveredAt = &deliveredAt
		}
	}
	return run, nil
}

func (s *Service) drainBatch(ctx context.Context, workerID domain.SessionID, submitted domain.ReviewRun) (domain.ReviewRun, error) {
	unlock := s.lockBatchDrain(workerID, submitted.BatchID)
	defer unlock()

	runs, err := s.store.ListReviewRunsByBatch(ctx, workerID, submitted.BatchID)
	if err != nil {
		return domain.ReviewRun{}, err
	}
	for _, run := range runs {
		if run.Status == domain.ReviewRunRunning {
			return submitted, nil
		}
	}
	currentHeads, err := s.currentHeadsByPR(ctx, workerID)
	if err != nil {
		return domain.ReviewRun{}, err
	}
	deliverable := make([]domain.ReviewRun, 0, len(runs))
	for _, run := range runs {
		if run.Status != domain.ReviewRunComplete || run.Verdict != domain.VerdictChangesRequested || run.DeliveredAt != nil {
			continue
		}
		if currentHeads[run.PRURL] != run.TargetSHA {
			continue
		}
		deliverable = append(deliverable, run)
	}
	if len(deliverable) == 0 {
		return submitted, nil
	}
	results := make([]lifecycle.ReviewResult, 0, len(deliverable))
	for _, run := range deliverable {
		results = append(results, lifecycle.ReviewResult{
			RunID:          run.ID,
			BatchID:        run.BatchID,
			WorkerID:       workerID,
			PRURL:          run.PRURL,
			TargetSHA:      run.TargetSHA,
			Verdict:        run.Verdict,
			Body:           run.Body,
			GithubReviewID: run.GithubReviewID,
			DeliveredAt:    run.DeliveredAt,
		})
	}
	outcome, err := s.lifecycle.ApplyReviewBatch(ctx, workerID, submitted.BatchID, results)
	if err != nil {
		return domain.ReviewRun{}, err
	}
	if outcome != lifecycle.ReviewDeliverySent {
		return submitted, nil
	}
	deliveredAt := s.clock()
	for _, run := range deliverable {
		updated, err := s.store.MarkReviewRunDelivered(ctx, run.ID, deliveredAt)
		if err != nil {
			return domain.ReviewRun{}, err
		}
		if updated && run.ID == submitted.ID {
			submitted.Status = domain.ReviewRunDelivered
			submitted.DeliveredAt = &deliveredAt
		}
	}
	return submitted, nil
}

func (s *Service) currentHeadsByPR(ctx context.Context, workerID domain.SessionID) (map[string]string, error) {
	prs, err := s.store.ListPRsBySession(ctx, workerID)
	if err != nil {
		return nil, err
	}
	current := make(map[string]string, len(prs))
	for _, pr := range prs {
		current[pr.URL] = pr.HeadSHA
	}
	return current, nil
}

func (s *Service) lockBatchDrain(workerID domain.SessionID, batchID string) func() {
	key := string(workerID) + "\x00" + batchID
	s.drainMu.Lock()
	mu, ok := s.drainLocks[key]
	if !ok {
		mu = &sync.Mutex{}
		s.drainLocks[key] = mu
	}
	s.drainMu.Unlock()
	mu.Lock()
	return mu.Unlock
}

// List returns a worker's review state.
func (s *Service) List(ctx context.Context, workerID domain.SessionID) (reviewcore.SessionReviews, error) {
	return s.engine.List(ctx, workerID)
}
