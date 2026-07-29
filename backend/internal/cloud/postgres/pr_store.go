//nolint:revive // Store methods satisfy existing service interfaces; interface docs live at call sites.
package postgres

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func (s *Store) GetDisplayPRFactsForSession(ctx context.Context, id domain.SessionID) (domain.PRFacts, bool, error) {
	facts, err := s.ListPRFactsForSession(ctx, id)
	if err != nil || len(facts) == 0 {
		return domain.PRFacts{}, false, err
	}
	return facts[0], true, nil
}

func (s *Store) ListPRFactsForSession(ctx context.Context, id domain.SessionID) ([]domain.PRFacts, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT url, number, pr_state, ci_state, review_decision, mergeability, updated_at
FROM pr
WHERE org_id = $1 AND session_id = $2
ORDER BY updated_at DESC, url
`, orgID, id)
	if err != nil {
		return nil, fmt.Errorf("list pr facts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []domain.PRFacts
	for rows.Next() {
		var state domain.PRState
		var f domain.PRFacts
		if err := rows.Scan(&f.URL, &f.Number, &state, &f.CI, &f.Review, &f.Mergeability, &f.UpdatedAt); err != nil {
			return nil, err
		}
		f.Draft = state == domain.PRStateDraft
		f.Merged = state == domain.PRStateMerged
		f.Closed = state == domain.PRStateClosed
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) ListPRsBySession(ctx context.Context, sessionID domain.SessionID) ([]domain.PullRequest, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT url, session_id, number, pr_state, review_decision, ci_state, mergeability, updated_at
FROM pr
WHERE org_id = $1 AND session_id = $2
ORDER BY updated_at DESC, url
`, orgID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list prs by session: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []domain.PullRequest
	for rows.Next() {
		var state domain.PRState
		var pr domain.PullRequest
		if err := rows.Scan(&pr.URL, &pr.SessionID, &pr.Number, &state, &pr.Review, &pr.CI, &pr.Mergeability, &pr.UpdatedAt); err != nil {
			return nil, err
		}
		pr.Draft = state == domain.PRStateDraft
		pr.Merged = state == domain.PRStateMerged
		pr.Closed = state == domain.PRStateClosed
		out = append(out, pr)
	}
	return out, rows.Err()
}

func (s *Store) GetPRLastNudgeSignature(context.Context, string) (string, error) { return "", nil }
func (s *Store) UpdatePRLastNudgeSignature(context.Context, string, string) error {
	return errNotImplemented("pr nudge signatures")
}
func (s *Store) WritePR(context.Context, domain.PullRequest, []domain.PullRequestCheck, []domain.PullRequestComment) error {
	return errNotImplemented("pr writes")
}
func (s *Store) WriteSCMObservation(context.Context, domain.PullRequest, []domain.PullRequestCheck, []domain.PullRequestReview, []domain.PullRequestReviewThread, []domain.PullRequestComment, ports.ReviewWriteMode) error {
	return errNotImplemented("scm observation writes")
}
func (s *Store) ClaimPR(context.Context, domain.PullRequest, []domain.PullRequestCheck, []domain.PullRequestReview, []domain.PullRequestReviewThread, []domain.PullRequestComment, ports.ReviewWriteMode, bool) (ports.ClaimOutcome, error) {
	return ports.ClaimOutcome{}, errNotImplemented("claim pr")
}
func (s *Store) GetPR(context.Context, string) (domain.PullRequest, bool, error) {
	return domain.PullRequest{}, false, nil
}
func (s *Store) ListChecks(context.Context, string) ([]domain.PullRequestCheck, error) {
	return []domain.PullRequestCheck{}, nil
}
func (s *Store) ListPRComments(context.Context, string) ([]domain.PullRequestComment, error) {
	return []domain.PullRequestComment{}, nil
}
func (s *Store) ListPRReviewThreads(context.Context, string) ([]domain.PullRequestReviewThread, error) {
	return []domain.PullRequestReviewThread{}, nil
}
func (s *Store) ListPRReviews(context.Context, string) ([]domain.PullRequestReview, error) {
	return []domain.PullRequestReview{}, nil
}
