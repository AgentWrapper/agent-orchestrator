package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

var (
	// ErrPRClaimed indicates that another active Cloud worker owns the PR.
	ErrPRClaimed = errors.New("cloud pull request is already claimed")
	// ErrIssueNotFound indicates that no issue is attached to the session.
	ErrIssueNotFound = errors.New("cloud issue not found")
	// ErrReviewThreadNotFound indicates the review thread is not known for the session.
	ErrReviewThreadNotFound = errors.New("cloud review thread not found")
)

// UpsertIssueSnapshot records the validated repository issue used for a session.
func (s *Store) UpsertIssueSnapshot(
	ctx context.Context,
	accountID clouddomain.AccountID,
	issue clouddomain.Issue,
) (clouddomain.Issue, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_issues (
			account_id, project_id, provider, repository, number, url, title, body, state, observed_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (account_id, provider, repository, number) DO UPDATE
		SET project_id = EXCLUDED.project_id, url = EXCLUDED.url, title = EXCLUDED.title,
			body = EXCLUDED.body, state = EXCLUDED.state, observed_at = EXCLUDED.observed_at,
			updated_at = now()
		RETURNING id, account_id, project_id, provider, repository, number, url, title, body, state, observed_at
	`, accountID, issue.ProjectID, issue.Provider, issue.Repository, issue.Number, issue.URL,
		issue.Title, issue.Body, issue.State, issue.ObservedAt).Scan(
		&issue.ID, &issue.AccountID, &issue.ProjectID, &issue.Provider, &issue.Repository,
		&issue.Number, &issue.URL, &issue.Title, &issue.Body, &issue.State, &issue.ObservedAt,
	)
	if err != nil {
		return clouddomain.Issue{}, fmt.Errorf("upsert cloud issue: %w", err)
	}
	return issue, nil
}

// LinkSessionIssue atomically associates a Cloud session with its validated issue.
func (s *Store) LinkSessionIssue(ctx context.Context, accountID clouddomain.AccountID, sessionID clouddomain.SessionID, issueID string) error {
	result, err := s.pool.Exec(ctx, `
		INSERT INTO ao_session_issue_links(session_id, issue_id)
		SELECT $1, $2 FROM ao_sessions WHERE id = $1 AND account_id = $3
		ON CONFLICT (session_id) DO UPDATE SET issue_id = EXCLUDED.issue_id
	`, sessionID, issueID, accountID)
	if err != nil {
		return fmt.Errorf("link cloud session issue: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

// ClaimPullRequest gives one active Cloud worker durable ownership of a PR.
func (s *Store) ClaimPullRequest(
	ctx context.Context,
	accountID clouddomain.AccountID,
	claim clouddomain.PRClaim,
) (clouddomain.PRClaim, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_pr_claims(account_id, session_id, provider, repository, number, url)
		SELECT $1, $2, $3, $4, $5, $6
		WHERE EXISTS (
			SELECT 1 FROM ao_sessions
			WHERE id = $2 AND account_id = $1 AND kind = 'worker' AND is_terminated = false
		)
		ON CONFLICT ON CONSTRAINT ao_pr_claims_session_id_provider_repository_number_key
		DO UPDATE SET url = EXCLUDED.url
		RETURNING id, account_id, session_id, provider, repository, number, url, claimed_at
	`, accountID, claim.SessionID, claim.Provider, claim.Repository, claim.Number, claim.URL).Scan(
		&claim.ID, &claim.AccountID, &claim.SessionID, &claim.Provider, &claim.Repository,
		&claim.Number, &claim.URL, &claim.ClaimedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.PRClaim{}, ErrSessionNotFound
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.ConstraintName == "ao_pr_claims_one_active_owner" {
			return clouddomain.PRClaim{}, ErrPRClaimed
		}
		return clouddomain.PRClaim{}, fmt.Errorf("claim cloud pull request: %w", err)
	}
	return claim, nil
}
