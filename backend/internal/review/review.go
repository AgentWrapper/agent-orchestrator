// Package review holds the core code-review logic: triggering a reviewer over a
// worker's worktree, recording review runs, and accepting submitted results.
//
// It is independent of any transport. The daemon's HTTP service
// (internal/service/review) is a thin boundary over this engine today, and the
// same engine can back an in-process CLI trigger later without going through the
// API. Transport-specific concerns (DTOs, error→status mapping) stay in the
// service/controller layers; the orchestration and run-id generation live here.
package review

import (
	stdctx "context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ErrInvalid and ErrNotFound let the transport layer map failures to 422/404.
var (
	ErrInvalid  = errors.New("review: invalid input")
	ErrNotFound = errors.New("review: not found")
)

// Store is the persistence surface the engine needs. *sqlite.Store satisfies it
// in production; tests use a fake.
type Store interface {
	UpsertReview(ctx stdctx.Context, r domain.Review) error
	GetReviewBySession(ctx stdctx.Context, id domain.SessionID) (domain.Review, bool, error)
	InsertReviewRun(ctx stdctx.Context, r domain.ReviewRun) error
	UpdateReviewRunResult(ctx stdctx.Context, id string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string) (bool, error)
	SupersedeReviewRun(ctx stdctx.Context, id, body string) (bool, error)
	SupersedeStaleRunningReviewRuns(ctx stdctx.Context, sessionID domain.SessionID, targetSHA, body string) (int64, error)
	GetReviewRun(ctx stdctx.Context, id string) (domain.ReviewRun, bool, error)
	GetReviewRunBySessionAndSHA(ctx stdctx.Context, id domain.SessionID, targetSHA string) (domain.ReviewRun, bool, error)
	ListReviewRunsBySession(ctx stdctx.Context, id domain.SessionID) ([]domain.ReviewRun, error)
}

// Sessions resolves the worker session under review.
type Sessions interface {
	GetSession(ctx stdctx.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
}

// PRs resolves the PR a worker owns.
type PRs interface {
	ListPRsBySession(ctx stdctx.Context, id domain.SessionID) ([]domain.PullRequest, error)
}

// Projects resolves the per-project reviewer config.
type Projects interface {
	GetProject(ctx stdctx.Context, id string) (domain.ProjectRecord, bool, error)
}

// Deps wires the engine.
type Deps struct {
	Store    Store
	Sessions Sessions
	PRs      PRs
	Projects Projects
	Launcher Launcher

	// Clock and NewID are injectable for deterministic tests.
	Clock func() time.Time
	NewID func() string
}

// Engine is the core code-review engine.
type Engine struct {
	store    Store
	sessions Sessions
	prs      PRs
	projects Projects
	launcher Launcher
	clock    func() time.Time
	newID    func() string

	// triggerMu guards triggerLocks; triggerLocks holds one mutex per worker
	// session so concurrent Trigger calls for the same worker serialise (see
	// lockWorker). Distinct workers never contend.
	triggerMu    sync.Mutex
	triggerLocks map[domain.SessionID]*sync.Mutex
}

// New wires an Engine from its dependencies, defaulting the clock and id source.
func New(d Deps) *Engine {
	clock := d.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	newID := d.NewID
	if newID == nil {
		newID = uuid.NewString
	}
	return &Engine{
		store:        d.Store,
		sessions:     d.Sessions,
		prs:          d.PRs,
		projects:     d.Projects,
		launcher:     d.Launcher,
		clock:        clock,
		newID:        newID,
		triggerLocks: make(map[domain.SessionID]*sync.Mutex),
	}
}

// lockWorker serialises Trigger calls for a single worker session and returns
// the unlock func. Without it, two concurrent triggers for the same worker can
// both pass the per-commit idempotency check and each spawn a reviewer against
// the same deterministic handle, leaving two running runs for one commit (#242).
//
// The per-worker mutex is created on first use and kept for the lifetime of the
// engine; the entry is a single pointer, so the unbounded-by-session-count map
// is a negligible, bounded-in-practice cost.
func (e *Engine) lockWorker(id domain.SessionID) func() {
	e.triggerMu.Lock()
	mu, ok := e.triggerLocks[id]
	if !ok {
		mu = &sync.Mutex{}
		e.triggerLocks[id] = mu
	}
	e.triggerMu.Unlock()
	mu.Lock()
	return mu.Unlock
}

// TriggerResult is the outcome of a trigger: the (new or existing) run, the live
// reviewer pane's handle so the UI can attach its terminal, and whether a new
// pass was started (false when an existing run for the same commit was reused).
type TriggerResult struct {
	Run              domain.ReviewRun
	ReviewerHandleID string
	Created          bool
}

// SessionReviews is a worker's review state: the live reviewer handle plus its
// recorded passes, newest first.
type SessionReviews struct {
	ReviewerHandleID string
	Runs             []domain.ReviewRun
}

// Trigger starts (or reuses) a review of a worker's PR at its current head:
//   - if a non-failed run already exists for this commit, it is returned unchanged;
//   - otherwise, if a live reviewer pane exists, it is messaged to review the
//     new commit; if not, a fresh reviewer is spawned;
//   - the run is recorded before launch so startup failures leave a visible
//     failed pass instead of an empty gap.
func (e *Engine) Trigger(ctx stdctx.Context, workerID domain.SessionID) (TriggerResult, error) {
	if workerID == "" {
		return TriggerResult{}, fmt.Errorf("%w: worker session id is required", ErrInvalid)
	}

	// Serialise concurrent triggers for this worker so the idempotency check
	// below (and the reviewer spawn that follows it) can't be raced into a
	// double-spawn. Held across the spawn deliberately: the loser then re-reads
	// the freshly-recorded run and short-circuits to Created:false.
	unlock := e.lockWorker(workerID)
	defer unlock()

	worker, ok, err := e.sessions.GetSession(ctx, workerID)
	if err != nil {
		return TriggerResult{}, err
	}
	if !ok {
		return TriggerResult{}, fmt.Errorf("%w: worker session %q", ErrNotFound, workerID)
	}
	if worker.IsTerminated {
		return TriggerResult{}, fmt.Errorf("%w: worker session %q is terminated", ErrInvalid, workerID)
	}
	if worker.Metadata.WorkspacePath == "" {
		return TriggerResult{}, fmt.Errorf("%w: worker session %q has no workspace to review", ErrInvalid, workerID)
	}

	pr, err := e.workerPR(ctx, workerID)
	if err != nil {
		return TriggerResult{}, err
	}
	targetSHA := pr.HeadSHA

	review, hasReview, err := e.store.GetReviewBySession(ctx, workerID)
	if err != nil {
		return TriggerResult{}, err
	}

	// Idempotency: a pass for this commit is reusable while it is still running
	// or once it carries a verdict. The fallback branch below is defensive for
	// any non-running, non-failed row that somehow lacks a verdict; normal
	// Submit paths complete a run only with a valid verdict (#342).
	if existing, ok, err := e.store.GetReviewRunBySessionAndSHA(ctx, workerID, targetSHA); err != nil {
		return TriggerResult{}, err
	} else if ok && (existing.Status == domain.ReviewRunRunning || existing.Verdict != domain.VerdictNone) {
		return TriggerResult{Run: existing, ReviewerHandleID: review.ReviewerHandleID, Created: false}, nil
	} else if ok && existing.Status != domain.ReviewRunFailed {
		superseded, err := e.store.SupersedeReviewRun(ctx, existing.ID, "superseded by a new review trigger")
		if err != nil {
			return TriggerResult{}, err
		}
		if !superseded {
			if latest, ok, err := e.store.GetReviewRun(ctx, existing.ID); err != nil {
				return TriggerResult{}, err
			} else if ok {
				return TriggerResult{Run: latest, ReviewerHandleID: review.ReviewerHandleID, Created: false}, nil
			}
		}
	}
	staleRunning, err := e.store.SupersedeStaleRunningReviewRuns(ctx, workerID, targetSHA, "superseded by a review trigger for a newer commit")
	if err != nil {
		return TriggerResult{}, err
	}

	harness, err := e.reviewerHarness(ctx, worker)
	if err != nil {
		return TriggerResult{}, err
	}

	now := e.clock()
	runID := e.newID()
	spec := LaunchSpec{
		RunID:         runID,
		WorkerID:      workerID,
		Harness:       harness,
		WorkspacePath: worker.Metadata.WorkspacePath,
		PRURL:         pr.URL,
		TargetSHA:     targetSHA,
	}

	review, err = e.upsertReview(ctx, worker, harness, pr.URL, review.ReviewerHandleID, now)
	if err != nil {
		return TriggerResult{}, err
	}
	run := domain.ReviewRun{
		ID:        runID,
		ReviewID:  review.ID,
		SessionID: workerID,
		Harness:   harness,
		PRURL:     pr.URL,
		TargetSHA: targetSHA,
		Status:    domain.ReviewRunRunning,
		Verdict:   domain.VerdictNone,
		CreatedAt: now,
	}
	if err := e.store.InsertReviewRun(ctx, run); err != nil {
		if errors.Is(err, domain.ErrDuplicateReviewRun) {
			if existing, ok, getErr := e.store.GetReviewRunBySessionAndSHA(ctx, workerID, targetSHA); getErr != nil {
				return TriggerResult{}, getErr
			} else if ok {
				return TriggerResult{Run: existing, ReviewerHandleID: review.ReviewerHandleID, Created: false}, nil
			}
		}
		return TriggerResult{}, err
	}

	failRun := func(err error) error {
		if _, updateErr := e.store.UpdateReviewRunResult(ctx, run.ID, domain.ReviewRunFailed, domain.VerdictNone, err.Error(), ""); updateErr != nil {
			return updateErr
		}
		return err
	}

	// Reuse a live reviewer pane if there is one; otherwise spawn a fresh one.
	handleID := ""
	if hasReview && review.ReviewerHandleID != "" {
		alive, err := e.launcher.Alive(ctx, review.ReviewerHandleID)
		if err != nil {
			return TriggerResult{}, failRun(err)
		}
		if alive {
			if staleRunning > 0 {
				if err := e.launcher.Destroy(ctx, review.ReviewerHandleID); err != nil {
					return TriggerResult{}, failRun(fmt.Errorf("destroy reviewer: %w", err))
				}
			} else {
				if err := e.launcher.Notify(ctx, review.ReviewerHandleID, spec); err != nil {
					return TriggerResult{}, failRun(fmt.Errorf("notify reviewer: %w", err))
				}
				handleID = review.ReviewerHandleID
			}
		}
	}
	if handleID == "" {
		h, err := e.launcher.Spawn(ctx, spec)
		if err != nil {
			return TriggerResult{}, failRun(fmt.Errorf("launch reviewer: %w", err))
		}
		handleID = h
	}

	// The reviewer is running; now record the pass.
	review, err = e.upsertReview(ctx, worker, harness, pr.URL, handleID, now)
	if err != nil {
		return TriggerResult{}, err
	}
	run.ReviewID = review.ID
	return TriggerResult{Run: run, ReviewerHandleID: handleID, Created: true}, nil
}

// List returns a worker's review state: the live reviewer handle and its passes.
func (e *Engine) List(ctx stdctx.Context, workerID domain.SessionID) (SessionReviews, error) {
	if workerID == "" {
		return SessionReviews{}, fmt.Errorf("%w: worker session id is required", ErrInvalid)
	}
	runs, err := e.store.ListReviewRunsBySession(ctx, workerID)
	if err != nil {
		return SessionReviews{}, err
	}
	var handle string
	if review, ok, err := e.store.GetReviewBySession(ctx, workerID); err != nil {
		return SessionReviews{}, err
	} else if ok {
		handle = review.ReviewerHandleID
	}
	return SessionReviews{ReviewerHandleID: handle, Runs: runs}, nil
}

func (e *Engine) workerPR(ctx stdctx.Context, workerID domain.SessionID) (domain.PullRequest, error) {
	prs, err := e.prs.ListPRsBySession(ctx, workerID)
	if err != nil {
		return domain.PullRequest{}, err
	}
	if len(prs) == 0 {
		return domain.PullRequest{}, fmt.Errorf("%w: worker %q has no PR to review", ErrInvalid, workerID)
	}
	return prs[0], nil
}

// reviewerHarness resolves which harness reviews the worker's PR: a configured
// reviewer wins, otherwise the worker's own harness is reused (falling back to
// claude-code), per domain.ResolveReviewerHarness.
func (e *Engine) reviewerHarness(ctx stdctx.Context, worker domain.SessionRecord) (domain.ReviewerHarness, error) {
	var cfg domain.ProjectConfig
	if e.projects != nil {
		if proj, ok, err := e.projects.GetProject(ctx, string(worker.ProjectID)); err != nil {
			return "", err
		} else if ok {
			cfg = proj.Config
		}
	}
	return cfg.ResolveReviewerHarness(worker.Harness), nil
}

func (e *Engine) upsertReview(ctx stdctx.Context, worker domain.SessionRecord, harness domain.ReviewerHarness, prURL, handleID string, now time.Time) (domain.Review, error) {
	existing, ok, err := e.store.GetReviewBySession(ctx, worker.ID)
	if err != nil {
		return domain.Review{}, err
	}
	review := domain.Review{
		ID:               e.newID(),
		SessionID:        worker.ID,
		ProjectID:        worker.ProjectID,
		Harness:          harness,
		PRURL:            prURL,
		ReviewerHandleID: handleID,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if ok {
		// Reuse the existing row's identity and creation time; UpsertReview
		// refreshes harness/pr_url/reviewer_handle_id/updated_at.
		review.ID = existing.ID
		review.CreatedAt = existing.CreatedAt
	}
	if err := e.store.UpsertReview(ctx, review); err != nil {
		return domain.Review{}, err
	}
	return review, nil
}
