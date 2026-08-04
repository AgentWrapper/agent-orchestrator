package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// ClaimSandboxes leases due sandboxes for reconciliation.
func (s *Store) ClaimSandboxes(
	ctx context.Context,
	owner string,
	limit int,
	lease time.Duration,
) ([]clouddomain.Sandbox, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin sandbox claim: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		WITH candidates AS (
			SELECT session_id
			FROM ao_sandboxes
			WHERE reconcile_after <= now()
				AND (
					reconcile_lease_until IS NULL
					OR reconcile_lease_until < now()
				)
				AND (
					observed_state <> 'deleted'
					OR desired_state <> 'deleted'
				)
			ORDER BY reconcile_after, created_at
			FOR UPDATE SKIP LOCKED
			LIMIT $1
		)
		UPDATE ao_sandboxes sandbox
		SET reconcile_lease_owner = $2,
			reconcile_lease_until = now() + $3::interval,
			updated_at = now()
		FROM candidates
		WHERE sandbox.session_id = candidates.session_id
		RETURNING sandbox.session_id, sandbox.account_id, sandbox.org_id, sandbox.provider,
			COALESCE(sandbox.provider_environment_id, ''),
			COALESCE(sandbox.provider_connection_id::text, ''),
			sandbox.desired_state, sandbox.observed_state,
			sandbox.resource_profile, sandbox.worker_last_seen_at,
			sandbox.last_error, sandbox.reconcile_after,
			sandbox.created_at, sandbox.updated_at
	`, limit, owner, intervalString(lease))
	if err != nil {
		return nil, fmt.Errorf("claim sandboxes: %w", err)
	}
	defer rows.Close()
	sandboxes := make([]clouddomain.Sandbox, 0)
	for rows.Next() {
		sandbox, err := scanSandbox(rows)
		if err != nil {
			return nil, err
		}
		sandboxes = append(sandboxes, sandbox)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sandbox claims: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit sandbox claims: %w", err)
	}
	return sandboxes, nil
}

// UpdateSandboxObservation records provider state and releases its reconciliation lease.
func (s *Store) UpdateSandboxObservation(
	ctx context.Context,
	owner string,
	sessionID clouddomain.SessionID,
	providerEnvironmentID, observedState, lastError string,
	reconcileAfter time.Time,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin sandbox observation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE ao_sandboxes
		SET provider_environment_id = NULLIF($3, ''),
			observed_state = $4,
			last_error = $5,
			reconcile_after = $6,
			reconcile_lease_owner = '',
			reconcile_lease_until = NULL,
			worker_last_seen_at = CASE
				WHEN $4 IN ('requested', 'provisioning', 'bootstrapping')
					AND (
						provider_environment_id IS DISTINCT FROM NULLIF($3, '')
						OR observed_state IS DISTINCT FROM $4
					)
					THEN NULL
				ELSE worker_last_seen_at
			END,
			updated_at = CASE
				WHEN provider_environment_id IS DISTINCT FROM NULLIF($3, '')
					OR observed_state IS DISTINCT FROM $4
					OR last_error IS DISTINCT FROM $5
					THEN now()
				ELSE updated_at
			END
		WHERE session_id = $1 AND reconcile_lease_owner = $2
	`, sessionID, owner, providerEnvironmentID, observedState, lastError, reconcileAfter)
	if err != nil {
		return fmt.Errorf("update sandbox observation: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSandboxLeaseLost
	}
	if providerEnvironmentID == "" {
		if _, err := tx.Exec(ctx, `
			UPDATE ao_sessions
			SET agent_session_id = '', updated_at = now()
			WHERE id = $1
		`, sessionID); err != nil {
			return fmt.Errorf("reset provider session after sandbox loss: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit sandbox observation: %w", err)
	}
	return nil
}

// ReleaseSandboxClaim releases a reconciliation lease and schedules another attempt.
func (s *Store) ReleaseSandboxClaim(
	ctx context.Context,
	owner string,
	sessionID clouddomain.SessionID,
	reconcileAfter time.Time,
) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE ao_sandboxes
		SET reconcile_after = $3,
			reconcile_lease_owner = '',
			reconcile_lease_until = NULL,
			updated_at = now()
		WHERE session_id = $1 AND reconcile_lease_owner = $2
	`, sessionID, owner, reconcileAfter)
	if err != nil {
		return fmt.Errorf("release sandbox claim: %w", err)
	}
	return nil
}

// SetSandboxDesiredState updates the requested lifecycle state of a session sandbox.
func (s *Store) SetSandboxDesiredState(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	desiredState string,
) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_sandboxes
		SET desired_state = $3, reconcile_after = now(), updated_at = now()
		WHERE org_id = $1 AND session_id = $2
	`, accountID, sessionID, desiredState)
	if err != nil {
		return fmt.Errorf("set sandbox desired state: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

// GetSandbox returns the account-owned sandbox for a session.
func (s *Store) GetSandbox(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (clouddomain.Sandbox, error) {
	sandbox, err := scanSandbox(s.pool.QueryRow(ctx, `
		SELECT session_id, account_id, org_id, provider,
			COALESCE(provider_environment_id, ''),
			COALESCE(provider_connection_id::text, ''),
			desired_state, observed_state, resource_profile, worker_last_seen_at,
			last_error, reconcile_after, created_at, updated_at
		FROM ao_sandboxes
		WHERE org_id = $1 AND session_id = $2
	`, accountID, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.Sandbox{}, ErrSessionNotFound
	}
	return sandbox, err
}

// CountActiveSandboxes returns the number of org sandboxes that still occupy
// capacity. Deleted sandboxes no longer count toward the hosted quota.
func (s *Store) CountActiveSandboxes(
	ctx context.Context,
	accountID clouddomain.AccountID,
) (int, error) {
	var count int
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM ao_sandboxes
		WHERE org_id = $1 AND desired_state <> 'deleted'
	`, accountID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count active sandboxes: %w", err)
	}
	return count, nil
}

// RegisterWorkerBootstrap records the epoch authorized by a successful
// bootstrap exchange without claiming that the worker runtime is ready.
func (s *Store) RegisterWorkerBootstrap(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	workerID, version string,
	epoch int64,
	capabilities []string,
) error {
	encodedCapabilities, err := json.Marshal(capabilities)
	if err != nil {
		return fmt.Errorf("encode worker capabilities: %w", err)
	}
	if err := upsertWorkerConnection(
		ctx,
		s.pool,
		accountID,
		sessionID,
		workerID,
		version,
		epoch,
		encodedCapabilities,
		false,
	); err != nil {
		return fmt.Errorf("register worker bootstrap: %w", err)
	}
	return nil
}

// MarkWorkerSeen records a worker heartbeat and its current connection epoch.
func (s *Store) MarkWorkerSeen(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	workerID, version string,
	epoch int64,
	capabilities []string,
) error {
	encodedCapabilities, err := json.Marshal(capabilities)
	if err != nil {
		return fmt.Errorf("encode worker capabilities: %w", err)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin worker heartbeat: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE ao_sandboxes
		SET worker_last_seen_at = now(),
			observed_state = CASE
				WHEN observed_state IN ('requested', 'provisioning', 'bootstrapping', 'disconnected')
					THEN 'running'
				ELSE observed_state
			END,
			reconcile_after = now() + interval '30 seconds',
			updated_at = now()
		WHERE org_id = $1 AND session_id = $2
	`, accountID, sessionID)
	if err != nil {
		return fmt.Errorf("mark sandbox worker seen: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	if err := upsertWorkerConnection(
		ctx,
		tx,
		accountID,
		sessionID,
		workerID,
		version,
		epoch,
		encodedCapabilities,
		true,
	); err != nil {
		return fmt.Errorf("upsert worker connection: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit worker heartbeat: %w", err)
	}
	return nil
}

type sqlExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func upsertWorkerConnection(
	ctx context.Context,
	executor sqlExecutor,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	workerID, version string,
	epoch int64,
	encodedCapabilities []byte,
	ready bool,
) error {
	_, err := executor.Exec(ctx, `
		INSERT INTO ao_worker_connections (
			session_id, account_id, org_id, sandbox_id, epoch, worker_id, version,
			capabilities, connected_at, last_seen_at, ready_at, disconnected_at
		)
		VALUES (
			$1, $2, $2, $1, $3, $4, $5, $6, now(), now(),
			CASE WHEN $7 THEN now() ELSE NULL END,
			NULL
		)
		ON CONFLICT (session_id) DO UPDATE
		SET epoch = EXCLUDED.epoch,
			worker_id = EXCLUDED.worker_id,
			version = EXCLUDED.version,
			capabilities = EXCLUDED.capabilities,
			last_seen_at = now(),
			ready_at = CASE
				WHEN $7 THEN now()
				WHEN ao_worker_connections.epoch < EXCLUDED.epoch THEN NULL
				ELSE ao_worker_connections.ready_at
			END,
			disconnected_at = NULL
		WHERE ao_worker_connections.epoch <= EXCLUDED.epoch
	`, sessionID, accountID, epoch, workerID, version, encodedCapabilities, ready)
	return err
}

type rowScanner interface {
	Scan(...any) error
}

func scanSandbox(row rowScanner) (clouddomain.Sandbox, error) {
	var sandbox clouddomain.Sandbox
	var resourceRaw []byte
	if err := row.Scan(
		&sandbox.SessionID,
		&sandbox.AccountID,
		&sandbox.OrgID,
		&sandbox.Provider,
		&sandbox.ProviderEnvironmentID,
		&sandbox.ProviderConnectionID,
		&sandbox.DesiredState,
		&sandbox.ObservedState,
		&resourceRaw,
		&sandbox.WorkerLastSeenAt,
		&sandbox.LastError,
		&sandbox.ReconcileAfter,
		&sandbox.CreatedAt,
		&sandbox.UpdatedAt,
	); err != nil {
		return clouddomain.Sandbox{}, fmt.Errorf("scan sandbox: %w", err)
	}
	if err := json.Unmarshal(resourceRaw, &sandbox.ResourceProfile); err != nil {
		return clouddomain.Sandbox{}, fmt.Errorf("decode sandbox resources: %w", err)
	}
	return sandbox, nil
}

// ErrSandboxLeaseLost indicates that another reconciler owns the sandbox lease.
var ErrSandboxLeaseLost = errors.New("cloud sandbox reconciliation lease lost")
