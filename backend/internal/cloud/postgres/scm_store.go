package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudlocalgh "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/localgh"
)

// SCMTarget identifies a session branch that requires provider observation.
type SCMTarget struct {
	AccountID     clouddomain.AccountID
	SessionID     clouddomain.SessionID
	RepositoryURL string
	Branch        string
}

// ListSCMTargets returns active session branches to observe.
func (s *Store) ListSCMTargets(ctx context.Context) ([]SCMTarget, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT session.org_id, session.id, project.repository_url, session.branch
		FROM ao_sessions session
		JOIN ao_projects project ON project.id = session.project_id
		WHERE session.is_terminated = false
		ORDER BY session.created_at
	`)
	if err != nil {
		return nil, fmt.Errorf("list cloud SCM targets: %w", err)
	}
	defer rows.Close()
	targets := make([]SCMTarget, 0)
	for rows.Next() {
		var target SCMTarget
		if err := rows.Scan(
			&target.AccountID,
			&target.SessionID,
			&target.RepositoryURL,
			&target.Branch,
		); err != nil {
			return nil, fmt.Errorf("scan cloud SCM target: %w", err)
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

// WriteSCMObservation replaces the normalized SCM facts for a session.
func (s *Store) WriteSCMObservation(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	observation cloudlocalgh.PullRequestObservation,
) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin cloud SCM observation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var pullRequestID string
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_pull_requests (
			account_id, org_id, session_id, provider, repository, number, url, title,
			state, draft, head_sha, source_branch, target_branch, ci_state,
			review_state, mergeability, observed_at
		)
		VALUES ($1, $1, $2, 'github', $3, $4, $5, $6, $7, $8, $9, $10, $11,
			$12, $13, $14, $15)
		ON CONFLICT (org_id, provider, repository, number) DO UPDATE
		SET session_id = EXCLUDED.session_id,
			url = EXCLUDED.url,
			title = EXCLUDED.title,
			state = EXCLUDED.state,
			draft = EXCLUDED.draft,
			head_sha = EXCLUDED.head_sha,
			source_branch = EXCLUDED.source_branch,
			target_branch = EXCLUDED.target_branch,
			ci_state = EXCLUDED.ci_state,
			review_state = EXCLUDED.review_state,
			mergeability = EXCLUDED.mergeability,
			observed_at = EXCLUDED.observed_at,
			updated_at = now()
		RETURNING id
	`, accountID, sessionID, observation.Repository, observation.Number,
		observation.URL, observation.Title, observation.State, observation.Draft,
		observation.HeadSHA, observation.SourceBranch, observation.TargetBranch,
		observation.CIState, observation.ReviewState, observation.Mergeability,
		observation.ObservedAt,
	).Scan(&pullRequestID)
	if err != nil {
		return fmt.Errorf("upsert cloud pull request: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM ao_pr_checks WHERE pull_request_id = $1`, pullRequestID); err != nil {
		return fmt.Errorf("replace cloud PR checks: %w", err)
	}
	for _, check := range observation.Checks {
		if _, err := tx.Exec(ctx, `
			INSERT INTO ao_pr_checks (
				org_id, pull_request_id, name, status, conclusion, url, observed_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, accountID, pullRequestID, check.Name, check.Status, check.Conclusion, check.URL, check.ObservedAt); err != nil {
			return fmt.Errorf("insert cloud PR check: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM ao_pr_review_threads WHERE pull_request_id = $1`, pullRequestID); err != nil {
		return fmt.Errorf("replace cloud PR review threads: %w", err)
	}
	for _, thread := range observation.ReviewThreads {
		if _, err := tx.Exec(ctx, `
			INSERT INTO ao_pr_review_threads (
				account_id, org_id, pull_request_id, provider_thread_id, is_resolved,
				is_outdated, path, line, body, author_login, observed_at
			)
			VALUES ($1, $1, $2, $3, $4, $5, $6, NULLIF($7, 0), $8, $9, $10)
		`, accountID, pullRequestID, thread.ID, thread.IsResolved, thread.IsOutdated,
			thread.Path, thread.Line, thread.Body, thread.AuthorLogin, thread.ObservedAt); err != nil {
			return fmt.Errorf("insert cloud PR review thread: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit cloud SCM observation: %w", err)
	}
	return nil
}

// SessionSCM contains the latest normalized SCM state for a session.
type SessionSCM struct {
	PullRequest   cloudlocalgh.PullRequestObservation    `json:"pullRequest"`
	ReviewThreads []cloudlocalgh.ReviewThreadObservation `json:"reviewThreads,omitempty"`
}

// SessionSCM returns the latest SCM state for an account-owned session.
func (s *Store) SessionSCM(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (*SessionSCM, error) {
	var observation cloudlocalgh.PullRequestObservation
	var pullRequestID string
	err := s.pool.QueryRow(ctx, `
		SELECT id, repository, number, url, title, state, draft, head_sha,
			source_branch, target_branch, ci_state, review_state, mergeability,
			observed_at
		FROM ao_pull_requests
		WHERE org_id = $1 AND session_id = $2
		ORDER BY updated_at DESC
		LIMIT 1
	`, accountID, sessionID).Scan(
		&pullRequestID,
		&observation.Repository,
		&observation.Number,
		&observation.URL,
		&observation.Title,
		&observation.State,
		&observation.Draft,
		&observation.HeadSHA,
		&observation.SourceBranch,
		&observation.TargetBranch,
		&observation.CIState,
		&observation.ReviewState,
		&observation.Mergeability,
		&observation.ObservedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get cloud session SCM: %w", err)
	}
	rows, err := s.pool.Query(ctx, `
		SELECT name, status, conclusion, url, observed_at
		FROM ao_pr_checks
		WHERE pull_request_id = $1
		ORDER BY name
	`, pullRequestID)
	if err != nil {
		return nil, fmt.Errorf("list cloud PR checks: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var check cloudlocalgh.CheckObservation
		if err := rows.Scan(
			&check.Name,
			&check.Status,
			&check.Conclusion,
			&check.URL,
			&check.ObservedAt,
		); err != nil {
			return nil, err
		}
		observation.Checks = append(observation.Checks, check)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	threadRows, err := s.pool.Query(ctx, `
		SELECT provider_thread_id, is_resolved, is_outdated, path,
			COALESCE(line, 0), body, author_login, observed_at
		FROM ao_pr_review_threads
		WHERE pull_request_id = $1
		ORDER BY observed_at DESC, provider_thread_id
	`, pullRequestID)
	if err != nil {
		return nil, fmt.Errorf("list cloud PR review threads: %w", err)
	}
	defer threadRows.Close()
	threads := make([]cloudlocalgh.ReviewThreadObservation, 0)
	for threadRows.Next() {
		var thread cloudlocalgh.ReviewThreadObservation
		if err := threadRows.Scan(
			&thread.ID,
			&thread.IsResolved,
			&thread.IsOutdated,
			&thread.Path,
			&thread.Line,
			&thread.Body,
			&thread.AuthorLogin,
			&thread.ObservedAt,
		); err != nil {
			return nil, err
		}
		threads = append(threads, thread)
	}
	if err := threadRows.Err(); err != nil {
		return nil, err
	}
	observation.ReviewThreads = threads
	return &SessionSCM{PullRequest: observation, ReviewThreads: threads}, nil
}

// MarkReviewThreadResolved records a successful provider-side resolution.
func (s *Store) MarkReviewThreadResolved(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	providerThreadID string,
) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_pr_review_threads thread
		SET is_resolved = true, updated_at = now()
		FROM ao_pull_requests pr
		WHERE thread.pull_request_id = pr.id
			AND thread.account_id = $1
			AND pr.account_id = $1
			AND pr.session_id = $2
			AND thread.provider_thread_id = $3
	`, accountID, sessionID, providerThreadID)
	if err != nil {
		return fmt.Errorf("mark cloud PR review thread resolved: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrReviewThreadNotFound
	}
	return nil
}
