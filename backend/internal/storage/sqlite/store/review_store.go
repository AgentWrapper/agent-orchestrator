package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// UpsertReview inserts the per-worker review row, or reuses the existing one
// (session_id is unique) by refreshing its harness/pr_url/updated_at.
func (s *Store) UpsertReview(ctx context.Context, r domain.Review) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.UpsertReview(ctx, gen.UpsertReviewParams{
		ID:               r.ID,
		SessionID:        r.SessionID,
		ProjectID:        r.ProjectID,
		Harness:          r.Harness,
		PRURL:            r.PRURL,
		ReviewerHandleID: r.ReviewerHandleID,
		CreatedAt:        r.CreatedAt,
		UpdatedAt:        r.UpdatedAt,
	})
}

// GetReviewBySession returns the review row for a worker session, ok=false if none.
func (s *Store) GetReviewBySession(ctx context.Context, id domain.SessionID) (domain.Review, bool, error) {
	row, err := s.qr.GetReviewBySession(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Review{}, false, nil
	}
	if err != nil {
		return domain.Review{}, false, fmt.Errorf("get review by session %s: %w", id, err)
	}
	return reviewFromRow(row), true, nil
}

// InsertReviewRun records a new review pass. A unique-constraint hit on the
// (session_id, pr_url, target_sha) index (migration 0020) is surfaced as the sentinel
// domain.ErrDuplicateReviewRun so the engine can fall back to the existing run.
func (s *Store) InsertReviewRun(ctx context.Context, r domain.ReviewRun) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	err := s.qw.InsertReviewRun(ctx, gen.InsertReviewRunParams{
		ID:             r.ID,
		ReviewID:       r.ReviewID,
		SessionID:      r.SessionID,
		BatchID:        r.BatchID,
		Harness:        r.Harness,
		PRURL:          r.PRURL,
		TargetSha:      r.TargetSHA,
		Status:         r.Status,
		Verdict:        r.Verdict,
		Body:           r.Body,
		GithubReviewID: r.GithubReviewID,
		CreatedAt:      r.CreatedAt,
	})
	if isSQLiteUnique(err) {
		return fmt.Errorf("insert review run for session %s pr %s sha %s: %w", r.SessionID, r.PRURL, r.TargetSHA, domain.ErrDuplicateReviewRun)
	}
	return err
}

// UpdateReviewRunResult sets the status/verdict/body and the GitHub review id of
// a running review pass.
func (s *Store) UpdateReviewRunResult(ctx context.Context, id string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdateReviewRunResult(ctx, gen.UpdateReviewRunResultParams{
		Status:         status,
		Verdict:        verdict,
		Body:           body,
		GithubReviewID: githubReviewID,
		ID:             id,
	})
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// SupersedeReviewRun marks an unverdicted non-failed pass failed so a new pass
// for the same commit can be recorded.
func (s *Store) SupersedeReviewRun(ctx context.Context, id, body string) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.SupersedeReviewRun(ctx, gen.SupersedeReviewRunParams{
		Body: body,
		ID:   id,
	})
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// SupersedeStaleRunningReviewRuns marks older running unverdicted passes for a
// worker failed before starting a review for a newer commit.
func (s *Store) SupersedeStaleRunningReviewRuns(ctx context.Context, sessionID domain.SessionID, prURL, targetSHA, body string) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.SupersedeStaleRunningReviewRuns(ctx, gen.SupersedeStaleRunningReviewRunsParams{
		Body:      body,
		SessionID: sessionID,
		PRURL:     prURL,
		TargetSha: targetSHA,
	})
}

// MarkReviewRunDelivered records that lifecycle delivered the worker nudge for
// a completed AO-internal review pass.
func (s *Store) MarkReviewRunDelivered(ctx context.Context, id string, deliveredAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.MarkReviewRunDelivered(ctx, gen.MarkReviewRunDeliveredParams{
		DeliveredAt: sql.NullTime{Time: deliveredAt, Valid: true},
		ID:          id,
	})
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// GetReviewRun returns one review pass by id.
func (s *Store) GetReviewRun(ctx context.Context, id string) (domain.ReviewRun, bool, error) {
	row, err := s.qr.GetReviewRun(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ReviewRun{}, false, nil
	}
	if err != nil {
		return domain.ReviewRun{}, false, fmt.Errorf("get review run %s: %w", id, err)
	}
	return reviewRunFromRow(row), true, nil
}

// GetReviewRunBySessionPRAndSHA returns the most recent review pass for a
// worker session, PR, and commit, ok=false if none. It lets a repeat trigger for
// the same PR head short-circuit to the existing run without colliding with
// another PR that happens to share the same head commit.
func (s *Store) GetReviewRunBySessionPRAndSHA(ctx context.Context, id domain.SessionID, prURL, targetSHA string) (domain.ReviewRun, bool, error) {
	row, err := s.qr.GetReviewRunBySessionPRAndSHA(ctx, gen.GetReviewRunBySessionPRAndSHAParams{SessionID: id, PRURL: prURL, TargetSha: targetSHA})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ReviewRun{}, false, nil
	}
	if err != nil {
		return domain.ReviewRun{}, false, fmt.Errorf("get review run for session %s pr %s sha %s: %w", id, prURL, targetSHA, err)
	}
	return reviewRunFromRow(row), true, nil
}

// ListReviewRunsBySession returns all review passes for a worker session, newest first.
func (s *Store) ListReviewRunsBySession(ctx context.Context, id domain.SessionID) ([]domain.ReviewRun, error) {
	rows, err := s.qr.ListReviewRunsBySession(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("list review runs for session %s: %w", id, err)
	}
	out := make([]domain.ReviewRun, 0, len(rows))
	for _, row := range rows {
		out = append(out, reviewRunFromRow(row))
	}
	return out, nil
}

// ListReviewRunsByBatch returns all passes in one trigger-created batch, oldest first.
func (s *Store) ListReviewRunsByBatch(ctx context.Context, id domain.SessionID, batchID string) ([]domain.ReviewRun, error) {
	rows, err := s.qr.ListReviewRunsByBatch(ctx, gen.ListReviewRunsByBatchParams{SessionID: id, BatchID: batchID})
	if err != nil {
		return nil, fmt.Errorf("list review runs for session %s batch %s: %w", id, batchID, err)
	}
	out := make([]domain.ReviewRun, 0, len(rows))
	for _, row := range rows {
		out = append(out, reviewRunFromRow(row))
	}
	return out, nil
}

func reviewFromRow(r gen.Review) domain.Review {
	return domain.Review{
		ID:               r.ID,
		SessionID:        r.SessionID,
		ProjectID:        r.ProjectID,
		Harness:          r.Harness,
		PRURL:            r.PRURL,
		ReviewerHandleID: r.ReviewerHandleID,
		CreatedAt:        r.CreatedAt,
		UpdatedAt:        r.UpdatedAt,
	}
}

func reviewRunFromRow(r gen.ReviewRun) domain.ReviewRun {
	var deliveredAt *time.Time
	if r.DeliveredAt.Valid {
		t := r.DeliveredAt.Time
		deliveredAt = &t
	}
	return domain.ReviewRun{
		ID:             r.ID,
		ReviewID:       r.ReviewID,
		SessionID:      r.SessionID,
		BatchID:        r.BatchID,
		Harness:        r.Harness,
		PRURL:          r.PRURL,
		TargetSHA:      r.TargetSha,
		Status:         r.Status,
		Verdict:        r.Verdict,
		Body:           r.Body,
		GithubReviewID: r.GithubReviewID,
		CreatedAt:      r.CreatedAt,
		DeliveredAt:    deliveredAt,
	}
}
