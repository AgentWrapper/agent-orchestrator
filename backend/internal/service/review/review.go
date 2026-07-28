// Package review is the daemon's HTTP-facing code-review service boundary. The
// core orchestration lives in internal/review; this layer is the thin contract
// the API controller depends on and delegates to the engine, so the same engine
// can also back a future in-process CLI trigger.
package review

import (
	"context"
	"fmt"
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
	Cancel(ctx context.Context, workerID domain.SessionID) (reviewcore.CancelResult, error)
	Submit(ctx context.Context, workerID domain.SessionID, runID string, verdict domain.ReviewVerdict, body, githubReviewID string) (domain.ReviewRun, error)
	SubmitMany(ctx context.Context, workerID domain.SessionID, reviews []SubmittedReview) ([]domain.ReviewRun, error)
	List(ctx context.Context, workerID domain.SessionID) (reviewcore.SessionReviews, error)
}

// Service is the API-facing review service. It delegates to the core engine.
type Service struct {
	engine    *reviewcore.Engine
	store     Store
	lifecycle Reducer
	clock     func() time.Time
}

var _ Manager = (*Service)(nil)

// Store is the review_run persistence surface owned by the service submit path.
type Store interface {
	GetReviewRun(ctx context.Context, id string) (domain.ReviewRun, bool, error)
	UpdateReviewRunResult(ctx context.Context, id string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string) (bool, error)
	MarkReviewRunDelivered(ctx context.Context, id string, deliveredAt time.Time) (bool, error)
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
		engine: engine,
		store:  store,
		clock:  func() time.Time { return time.Now().UTC() },
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

// Cancel stops the live reviewer pane and marks running review passes as failed.
func (s *Service) Cancel(ctx context.Context, workerID domain.SessionID) (reviewcore.CancelResult, error) {
	return s.engine.Cancel(ctx, workerID)
}

// SubmittedReview is one review result supplied by the reviewer CLI.
type SubmittedReview struct {
	RunID          string
	Verdict        domain.ReviewVerdict
	Body           string
	GithubReviewID string
}

// Submit records a reviewer's result for a specific worker review pass.
func (s *Service) Submit(ctx context.Context, workerID domain.SessionID, runID string, verdict domain.ReviewVerdict, body, githubReviewID string) (domain.ReviewRun, error) {
	runs, err := s.SubmitMany(ctx, workerID, []SubmittedReview{{
		RunID:          runID,
		Verdict:        verdict,
		Body:           body,
		GithubReviewID: githubReviewID,
	}})
	if err != nil {
		return domain.ReviewRun{}, err
	}
	if len(runs) == 0 {
		return domain.ReviewRun{}, fmt.Errorf("%w: no review result submitted", ErrInvalid)
	}
	return runs[0], nil
}

// SubmitMany records one reviewer CLI submission containing results for one or
// more PR-scoped runs. Delivery is scoped to the runs in this submission, so a
// missing/stuck result for another PR in the same trigger cannot block feedback.
func (s *Service) SubmitMany(ctx context.Context, workerID domain.SessionID, reviews []SubmittedReview) ([]domain.ReviewRun, error) {
	if workerID == "" {
		return nil, fmt.Errorf("%w: worker session id is required", ErrInvalid)
	}
	if len(reviews) == 0 {
		return nil, fmt.Errorf("%w: at least one review result is required", ErrInvalid)
	}
	if s.store == nil {
		return nil, fmt.Errorf("review service store is not configured")
	}
	runs := make([]domain.ReviewRun, 0, len(reviews))
	for _, review := range reviews {
		run, err := s.submitOne(ctx, workerID, review)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	if s.lifecycle == nil {
		return runs, nil
	}
	delivered, err := s.deliverSubmitted(ctx, workerID, runs)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]domain.ReviewRun, len(delivered))
	for _, run := range delivered {
		byID[run.ID] = run
	}
	for i, run := range runs {
		if deliveredRun, ok := byID[run.ID]; ok {
			runs[i] = deliveredRun
		}
	}
	return runs, nil
}

func (s *Service) submitOne(ctx context.Context, workerID domain.SessionID, review SubmittedReview) (domain.ReviewRun, error) {
	runID := review.RunID
	verdict := review.Verdict
	body := review.Body
	githubReviewID := review.GithubReviewID
	if runID == "" {
		return domain.ReviewRun{}, fmt.Errorf("%w: review run id is required", ErrInvalid)
	}
	if !verdict.Valid() {
		return domain.ReviewRun{}, fmt.Errorf("%w: verdict must be %q or %q", ErrInvalid, domain.VerdictApproved, domain.VerdictChangesRequested)
	}
	if verdict == domain.VerdictChangesRequested && body == "" {
		return domain.ReviewRun{}, fmt.Errorf("%w: a changes_requested review requires a body", ErrInvalid)
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
	return run, nil
}

func (s *Service) deliverSubmitted(ctx context.Context, workerID domain.SessionID, runs []domain.ReviewRun) ([]domain.ReviewRun, error) {
	deliverable, err := s.deliverableRuns(ctx, workerID, runs)
	if err != nil {
		return nil, err
	}
	if len(deliverable) == 0 {
		return nil, nil
	}
	results := reviewResults(workerID, deliverable)
	var outcome lifecycle.ReviewDeliveryOutcome
	if len(results) == 1 && results[0].BatchID == "" {
		outcome, err = s.lifecycle.ApplyReviewResult(ctx, workerID, results[0])
	} else {
		outcome, err = s.lifecycle.ApplyReviewBatch(ctx, workerID, results[0].BatchID, results)
	}
	if err != nil {
		return nil, err
	}
	if outcome != lifecycle.ReviewDeliverySent {
		return nil, nil
	}
	deliveredAt := s.clock()
	delivered := make([]domain.ReviewRun, 0, len(deliverable))
	for _, run := range deliverable {
		updated, err := s.store.MarkReviewRunDelivered(ctx, run.ID, deliveredAt)
		if err != nil {
			return nil, err
		}
		if updated {
			run.Status = domain.ReviewRunDelivered
			run.DeliveredAt = &deliveredAt
			delivered = append(delivered, run)
		}
	}
	return delivered, nil
}

func (s *Service) deliverableRuns(ctx context.Context, workerID domain.SessionID, runs []domain.ReviewRun) ([]domain.ReviewRun, error) {
	currentHeads, err := s.currentHeadsByPR(ctx, workerID)
	if err != nil {
		return nil, err
	}
	deliverable := make([]domain.ReviewRun, 0, len(runs))
	for _, run := range runs {
		if run.Status != domain.ReviewRunComplete || run.Verdict != domain.VerdictChangesRequested || run.DeliveredAt != nil {
			continue
		}
		if run.BatchID != "" && currentHeads[run.PRURL] != run.TargetSHA {
			continue
		}
		deliverable = append(deliverable, run)
	}
	return deliverable, nil
}

func reviewResults(workerID domain.SessionID, runs []domain.ReviewRun) []lifecycle.ReviewResult {
	results := make([]lifecycle.ReviewResult, 0, len(runs))
	for _, run := range runs {
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
	return results
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

// List returns a worker's review state.
func (s *Service) List(ctx context.Context, workerID domain.SessionID) (reviewcore.SessionReviews, error) {
	return s.engine.List(ctx, workerID)
}
