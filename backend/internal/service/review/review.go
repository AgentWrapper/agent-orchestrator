// Package review is the daemon's HTTP-facing code-review service boundary. The
// core orchestration lives in internal/review; this layer is the thin contract
// the API controller depends on and delegates to the engine, so the same engine
// can also back a future in-process CLI trigger.
package review

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	"github.com/aoagents/agent-orchestrator/backend/internal/testgate"
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
	testGate  TestGate
	clock     func() time.Time
	logger    *slog.Logger
	bgCtx     context.Context
	asyncGate bool
}

var _ Manager = (*Service)(nil)

// Store is the review_run persistence surface owned by the service submit path.
type Store interface {
	GetReviewRun(ctx context.Context, id string) (domain.ReviewRun, bool, error)
	UpdateReviewRunResult(ctx context.Context, id string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string) (bool, error)
	MarkReviewRunDelivered(ctx context.Context, id string, deliveredAt time.Time) (bool, error)
	ListPRsBySession(ctx context.Context, id domain.SessionID) ([]domain.PullRequest, error)
	ReplaceReviewFindings(ctx context.Context, reviewRunID string, findings []testgate.ReviewFinding, createdAt time.Time) error
	GetFusedVerdict(ctx context.Context, sessionID domain.SessionID, prURL, targetSHA string) (testgate.FusedVerdict, bool, error)
}

// Reducer is the lifecycle reaction boundary used after a review result has
// been persisted.
type Reducer interface {
	ApplyReviewResult(ctx context.Context, workerID domain.SessionID, result lifecycle.ReviewResult) (lifecycle.ReviewDeliveryOutcome, error)
	ApplyReviewBatch(ctx context.Context, workerID domain.SessionID, batchID string, results []lifecycle.ReviewResult) (lifecycle.ReviewDeliveryOutcome, error)
}

// TestGate is the runtime verification boundary that fuses reviewer findings
// with pod evidence.
type TestGate interface {
	StartBaseline(ctx context.Context, run domain.ReviewRun)
	RunAfterReviewSubmit(ctx context.Context, run domain.ReviewRun) (testgate.FusedVerdict, bool, error)
}

// Option customizes the review service.
type Option func(*Service)

// WithLifecycleReducer wires post-submit review delivery through lifecycle.
func WithLifecycleReducer(r Reducer) Option {
	return func(s *Service) { s.lifecycle = r }
}

// WithTestGate wires review results through runtime verification.
func WithTestGate(g TestGate) Option {
	return func(s *Service) { s.testGate = g }
}

// WithAsyncTestGate lets submit return after persistence while runtime
// verification and worker delivery continue on the service background context.
func WithAsyncTestGate() Option {
	return func(s *Service) { s.asyncGate = true }
}

// WithBackgroundContext owns asynchronous review work. When unset, async work
// is detached from the caller's cancellation with context.WithoutCancel.
func WithBackgroundContext(ctx context.Context) Option {
	return func(s *Service) { s.bgCtx = ctx }
}

// WithLogger overrides the service logger for tests.
func WithLogger(logger *slog.Logger) Option {
	return func(s *Service) { s.logger = logger }
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
		logger: slog.Default(),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Trigger starts (or reuses) a review pass for a worker's PR.
func (s *Service) Trigger(ctx context.Context, workerID domain.SessionID) (reviewcore.TriggerResult, error) {
	res, err := s.engine.Trigger(ctx, workerID)
	if err != nil {
		return reviewcore.TriggerResult{}, err
	}
	if s.testGate != nil {
		for _, run := range res.CreatedRuns {
			s.testGate.StartBaseline(s.testGateContext(ctx), run)
		}
	}
	return res, nil
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
	Findings       []testgate.ReviewFinding
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
	fusedByRun := make(map[string]testgate.FusedVerdict, len(reviews))
	for _, review := range reviews {
		run, err := s.submitOne(ctx, workerID, review)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	if s.testGate != nil && s.asyncGate {
		s.runSubmittedTestGateAsync(ctx, workerID, runs)
		return runs, nil
	}
	if s.testGate != nil {
		var err error
		fusedByRun, err = s.runSubmittedTestGate(ctx, runs)
		if err != nil {
			return nil, err
		}
	}
	if s.lifecycle == nil {
		return runs, nil
	}
	delivered, err := s.deliverSubmitted(ctx, workerID, runs, fusedByRun)
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

func (s *Service) runSubmittedTestGateAsync(ctx context.Context, workerID domain.SessionID, runs []domain.ReviewRun) {
	bg := s.testGateContext(ctx)
	runs = append([]domain.ReviewRun(nil), runs...)
	go func() {
		fusedByRun, err := s.runSubmittedTestGate(bg, runs)
		if err != nil {
			s.logger.Warn("review test gate failed after submit", "workerID", workerID, "err", err)
			return
		}
		if s.lifecycle == nil {
			return
		}
		if _, err := s.deliverSubmitted(bg, workerID, runs, fusedByRun); err != nil {
			s.logger.Warn("review delivery failed after test gate", "workerID", workerID, "err", err)
		}
	}()
}

func (s *Service) runSubmittedTestGate(ctx context.Context, runs []domain.ReviewRun) (map[string]testgate.FusedVerdict, error) {
	fusedByRun := make(map[string]testgate.FusedVerdict, len(runs))
	for _, run := range runs {
		fused, ok, err := s.testGate.RunAfterReviewSubmit(ctx, run)
		if err != nil {
			return nil, err
		}
		if ok {
			fusedByRun[run.ID] = fused
		}
	}
	return fusedByRun, nil
}

func (s *Service) testGateContext(ctx context.Context) context.Context {
	if s.bgCtx != nil {
		return s.bgCtx
	}
	return context.WithoutCancel(ctx)
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
	var findings []testgate.ReviewFinding
	if review.Findings != nil {
		var err error
		findings, err = normalizeFindings(run.ID, review.Findings)
		if err != nil {
			return domain.ReviewRun{}, err
		}
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
	if review.Findings != nil {
		if err := s.store.ReplaceReviewFindings(ctx, run.ID, findings, s.clock()); err != nil {
			return domain.ReviewRun{}, err
		}
	}
	return run, nil
}

type deliveryCandidate struct {
	run    domain.ReviewRun
	result lifecycle.ReviewResult
}

func (s *Service) deliverSubmitted(ctx context.Context, workerID domain.SessionID, runs []domain.ReviewRun, fusedByRun map[string]testgate.FusedVerdict) ([]domain.ReviewRun, error) {
	deliverable, err := s.deliverableRuns(ctx, workerID, runs, fusedByRun)
	if err != nil {
		return nil, err
	}
	if len(deliverable) == 0 {
		return nil, nil
	}
	results := make([]lifecycle.ReviewResult, 0, len(deliverable))
	for _, candidate := range deliverable {
		results = append(results, candidate.result)
	}
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
	for _, candidate := range deliverable {
		run := candidate.run
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

func (s *Service) deliverableRuns(ctx context.Context, workerID domain.SessionID, runs []domain.ReviewRun, fusedByRun map[string]testgate.FusedVerdict) ([]deliveryCandidate, error) {
	currentHeads, err := s.currentHeadsByPR(ctx, workerID)
	if err != nil {
		return nil, err
	}
	deliverable := make([]deliveryCandidate, 0, len(runs))
	for _, run := range runs {
		resultRun := run
		if fused, ok := fusedByRun[run.ID]; ok {
			switch fused.Outcome {
			case testgate.FusedOutcomeApproved:
				if run.Verdict != domain.VerdictChangesRequested || hasRuntimeRefutation(fused) {
					continue
				}
			case testgate.FusedOutcomeChangesRequested:
				resultRun.Body = fusedDeliveryBody(run.Body, fused)
				if suppressGithubReviewID(fused) {
					resultRun.GithubReviewID = ""
				}
			case testgate.FusedOutcomeAppFailed:
				resultRun.Verdict = domain.VerdictChangesRequested
				resultRun.Body = fusedDeliveryBody(run.Body, fused)
				resultRun.GithubReviewID = ""
			}
		}
		if run.Status != domain.ReviewRunComplete || resultRun.Verdict != domain.VerdictChangesRequested || run.DeliveredAt != nil {
			continue
		}
		if run.BatchID != "" && currentHeads[run.PRURL] != run.TargetSHA {
			continue
		}
		deliverable = append(deliverable, deliveryCandidate{run: run, result: reviewResult(workerID, resultRun)})
	}
	return deliverable, nil
}

func reviewResults(workerID domain.SessionID, runs []domain.ReviewRun) []lifecycle.ReviewResult {
	results := make([]lifecycle.ReviewResult, 0, len(runs))
	for _, run := range runs {
		results = append(results, reviewResult(workerID, run))
	}
	return results
}

func reviewResult(workerID domain.SessionID, run domain.ReviewRun) lifecycle.ReviewResult {
	return lifecycle.ReviewResult{
		RunID:          run.ID,
		BatchID:        run.BatchID,
		WorkerID:       workerID,
		PRURL:          run.PRURL,
		TargetSHA:      run.TargetSHA,
		Verdict:        run.Verdict,
		Body:           run.Body,
		GithubReviewID: run.GithubReviewID,
		DeliveredAt:    run.DeliveredAt,
	}
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
	res, err := s.engine.List(ctx, workerID)
	if err != nil {
		return reviewcore.SessionReviews{}, err
	}
	if s.store == nil {
		return res, nil
	}
	for i := range res.Reviews {
		verdict, ok, err := s.store.GetFusedVerdict(ctx, workerID, res.Reviews[i].PRURL, res.Reviews[i].TargetSHA)
		if err != nil {
			return reviewcore.SessionReviews{}, err
		}
		if ok {
			res.Reviews[i].FusedVerdict = &verdict
		}
	}
	return res, nil
}

func normalizeFindings(runID string, findings []testgate.ReviewFinding) ([]testgate.ReviewFinding, error) {
	out := make([]testgate.ReviewFinding, 0, len(findings))
	for i, finding := range findings {
		if !finding.Severity.Valid() {
			return nil, fmt.Errorf("%w: finding %d severity must be low, medium, high, or critical", ErrInvalid, i+1)
		}
		finding.ID = normalizeFindingID(runID, finding.ID, i)
		finding.RunID = runID
		if strings.TrimSpace(finding.Title) == "" {
			finding.Title = firstNonEmpty(finding.Claim, finding.FailureScenario, fmt.Sprintf("Finding %d", i+1))
		}
		out = append(out, finding)
	}
	return out, nil
}

func normalizeFindingID(runID, id string, index int) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Sprintf("%s:finding:%d", runID, index+1)
	}
	prefix := runID + ":"
	if strings.HasPrefix(id, prefix) {
		return id
	}
	return prefix + id
}

func fusedDeliveryBody(reviewBody string, fused testgate.FusedVerdict) string {
	var b strings.Builder
	if fused.Outcome == testgate.FusedOutcomeNeutral && strings.TrimSpace(reviewBody) != "" {
		b.WriteString(reviewBody)
		b.WriteString("\n\n")
	}
	b.WriteString("AO test gate:")
	if fused.Summary != "" {
		b.WriteString("\n")
		b.WriteString(fused.Summary)
	}
	for _, finding := range fused.Findings {
		if !finding.Blocking {
			continue
		}
		title := firstNonEmpty(finding.Title, finding.Claim, "Runtime finding")
		b.WriteString("\n- ")
		if location := findingLocation(finding); location != "" {
			b.WriteString(location)
			b.WriteString(" ")
		}
		b.WriteString(title)
		if finding.Summary != "" {
			b.WriteString(": ")
			b.WriteString(finding.Summary)
		}
	}
	return b.String()
}

func findingLocation(finding testgate.FusedFinding) string {
	if strings.TrimSpace(finding.File) == "" {
		return ""
	}
	if finding.Line > 0 {
		return fmt.Sprintf("%s:%d", finding.File, finding.Line)
	}
	return finding.File
}

func hasRuntimeRefutation(fused testgate.FusedVerdict) bool {
	for _, finding := range fused.Findings {
		if finding.Source == testgate.EvidenceSourceTestInfra && finding.RuntimeOutcome == testgate.EvidenceOutcomeRefuted && !finding.Blocking {
			return true
		}
	}
	return false
}

func suppressGithubReviewID(fused testgate.FusedVerdict) bool {
	return fused.Outcome == testgate.FusedOutcomeAppFailed || hasRuntimeRefutation(fused)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
