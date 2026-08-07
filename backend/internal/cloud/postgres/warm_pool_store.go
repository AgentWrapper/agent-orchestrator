package postgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// ECSWarmTask is one clean Fargate task waiting for a single session assignment.
type ECSWarmTask struct {
	ID               string
	Generation       string
	TaskARN          string
	State            string
	ClaimedSessionID clouddomain.SessionID
	ReadyAt          *time.Time
	ClaimedAt        *time.Time
	StoppedAt        *time.Time
	LastError        string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

const ecsWarmPoolAdvisoryLock int64 = 624829104272

// ECSWarmPoolLease elects one pool manager across control-plane replicas.
type ECSWarmPoolLease struct {
	conn *pgxpool.Conn
}

// ECSWarmPoolLeaseHandle is the lifetime of one elected pool manager.
type ECSWarmPoolLeaseHandle interface {
	Valid(context.Context) bool
	Release(context.Context)
}

// TryAcquireECSWarmPoolLease attempts to become the only active pool manager.
func (s *Store) TryAcquireECSWarmPoolLease(
	ctx context.Context,
) (ECSWarmPoolLeaseHandle, bool, error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("acquire ECS warm-pool connection: %w", err)
	}
	var acquired bool
	if err := conn.QueryRow(
		ctx,
		"SELECT pg_try_advisory_lock($1)",
		ecsWarmPoolAdvisoryLock,
	).Scan(&acquired); err != nil {
		conn.Release()
		return nil, false, fmt.Errorf("acquire ECS warm-pool lease: %w", err)
	}
	if !acquired {
		conn.Release()
		return nil, false, nil
	}
	return &ECSWarmPoolLease{conn: conn}, true, nil
}

// Valid confirms that the live database session still owns its advisory lock.
func (l *ECSWarmPoolLease) Valid(ctx context.Context) bool {
	if l == nil || l.conn == nil || l.conn.Conn().PgConn().IsClosed() {
		return false
	}
	var valid bool
	err := l.conn.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM pg_locks
			WHERE locktype = 'advisory'
				AND pid = pg_backend_pid()
				AND granted
		)
	`).Scan(&valid)
	return err == nil && valid
}

// Release unlocks and returns the dedicated lease connection.
func (l *ECSWarmPoolLease) Release(ctx context.Context) {
	if l == nil || l.conn == nil {
		return
	}
	conn := l.conn
	l.conn = nil
	if ctx == nil || ctx.Err() != nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", ecsWarmPoolAdvisoryLock); err != nil {
		raw := conn.Hijack()
		_ = raw.Close(ctx)
		return
	}
	conn.Release()
}

// ReserveECSWarmTask durably reserves a unique enrollment token before RunTask.
func (s *Store) ReserveECSWarmTask(
	ctx context.Context,
	generation string,
	target int,
) (ECSWarmTask, string, bool, error) {
	if target <= 0 {
		return ECSWarmTask{}, "", false, nil
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return ECSWarmTask{}, "", false, fmt.Errorf("generate warm worker token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	hash := sha256.Sum256([]byte(token))
	task := ECSWarmTask{ID: uuid.NewString(), Generation: generation}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ECSWarmTask{}, "", false, fmt.Errorf("begin ECS warm task reservation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtext('ao_ecs_warm_pool:' || $1))
	`, generation); err != nil {
		return ECSWarmTask{}, "", false, fmt.Errorf("lock ECS warm pool: %w", err)
	}
	var available int
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		FROM ao_ecs_warm_tasks
		WHERE generation = $1 AND state IN ('launching', 'ready')
	`, generation).Scan(&available); err != nil {
		return ECSWarmTask{}, "", false, fmt.Errorf("count ECS warm capacity: %w", err)
	}
	if available >= target {
		return ECSWarmTask{}, "", false, nil
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_ecs_warm_tasks (id, generation, token_hash)
		VALUES ($1, $2, $3)
		RETURNING id, generation, task_arn, state,
			COALESCE(claimed_session_id::text, ''), ready_at, claimed_at,
			stopped_at, last_error, created_at, updated_at
	`, task.ID, generation, hash[:]).Scan(
		&task.ID,
		&task.Generation,
		&task.TaskARN,
		&task.State,
		&task.ClaimedSessionID,
		&task.ReadyAt,
		&task.ClaimedAt,
		&task.StoppedAt,
		&task.LastError,
		&task.CreatedAt,
		&task.UpdatedAt,
	)
	if err != nil {
		return ECSWarmTask{}, "", false, fmt.Errorf("reserve ECS warm task: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ECSWarmTask{}, "", false, fmt.Errorf("commit ECS warm task reservation: %w", err)
	}
	return task, token, true, nil
}

// ListECSWarmTasks returns all durable tasks for one release generation.
func (s *Store) ListECSWarmTasks(
	ctx context.Context,
	generation string,
) ([]ECSWarmTask, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, generation, task_arn, state,
			COALESCE(claimed_session_id::text, ''), ready_at, claimed_at,
			stopped_at, last_error, created_at, updated_at
		FROM ao_ecs_warm_tasks
		WHERE generation = $1
			OR state IN ('launching', 'ready')
			OR (state = 'failed' AND task_arn <> '' AND stopped_at IS NULL)
		ORDER BY created_at
	`, generation)
	if err != nil {
		return nil, fmt.Errorf("list ECS warm tasks: %w", err)
	}
	defer rows.Close()
	tasks := make([]ECSWarmTask, 0)
	for rows.Next() {
		var task ECSWarmTask
		if err := rows.Scan(
			&task.ID,
			&task.Generation,
			&task.TaskARN,
			&task.State,
			&task.ClaimedSessionID,
			&task.ReadyAt,
			&task.ClaimedAt,
			&task.StoppedAt,
			&task.LastError,
			&task.CreatedAt,
			&task.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan ECS warm task: %w", err)
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ECS warm tasks: %w", err)
	}
	return tasks, nil
}

// ActivateECSWarmTask records the task ARN returned by ECS.
func (s *Store) ActivateECSWarmTask(ctx context.Context, id, taskARN string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_ecs_warm_tasks
		SET task_arn = $2, updated_at = now()
		WHERE id = $1 AND state = 'launching'
	`, id, taskARN)
	if err != nil {
		return fmt.Errorf("activate ECS warm task: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrECSWarmTaskNotFound
	}
	return nil
}

// MarkECSWarmTaskReady makes one running blank task available for assignment.
func (s *Store) MarkECSWarmTaskReady(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_ecs_warm_tasks
		SET state = 'ready', ready_at = COALESCE(ready_at, now()),
			last_error = '', updated_at = now()
		WHERE id = $1 AND state = 'launching' AND task_arn <> ''
	`, id)
	if err != nil {
		return fmt.Errorf("mark ECS warm task ready: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrECSWarmTaskNotFound
	}
	return nil
}

// FailECSWarmTask retires a reservation that cannot become ready.
func (s *Store) FailECSWarmTask(ctx context.Context, id string, cause error) error {
	message := ""
	if cause != nil {
		message = cause.Error()
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE ao_ecs_warm_tasks
		SET state = 'failed', last_error = $2, stopped_at = now(), updated_at = now()
		WHERE id = $1 AND state IN ('launching', 'ready')
	`, id, message)
	if err != nil {
		return fmt.Errorf("fail ECS warm task: %w", err)
	}
	return nil
}

// RetireECSWarmTask atomically removes an unassigned task from claim eligibility.
func (s *Store) RetireECSWarmTask(
	ctx context.Context,
	id string,
) (string, bool, error) {
	var taskARN string
	err := s.pool.QueryRow(ctx, `
		UPDATE ao_ecs_warm_tasks
		SET state = 'failed', last_error = 'retiring unassigned task',
			stopped_at = NULL, updated_at = now()
		WHERE id = $1 AND state IN ('launching', 'ready')
		RETURNING task_arn
	`, id).Scan(&taskARN)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("retire ECS warm task: %w", err)
	}
	return taskARN, true, nil
}

// CompleteECSWarmTaskStop records provider-confirmed task deletion.
func (s *Store) CompleteECSWarmTaskStop(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE ao_ecs_warm_tasks
		SET state = 'stopped', stopped_at = now(), updated_at = now()
		WHERE id = $1 AND state = 'failed' AND stopped_at IS NULL
	`, id)
	if err != nil {
		return fmt.Errorf("complete ECS warm task stop: %w", err)
	}
	return nil
}

// StopECSWarmTaskForSession marks a claimed task as stopped during session deletion.
func (s *Store) StopECSWarmTaskForSession(
	ctx context.Context,
	sessionID clouddomain.SessionID,
) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE ao_ecs_warm_tasks
		SET state = 'stopped', stopped_at = now(), updated_at = now()
		WHERE claimed_session_id = $1 AND state = 'claimed'
	`, sessionID)
	if err != nil {
		return fmt.Errorf("stop claimed ECS warm task: %w", err)
	}
	return nil
}

// ClaimECSWarmTask atomically binds one ready task and its token to a leased sandbox.
func (s *Store) ClaimECSWarmTask(
	ctx context.Context,
	owner, generation string,
	sandbox clouddomain.Sandbox,
	scopes []string,
	ttl time.Duration,
) (string, bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", false, fmt.Errorf("begin ECS warm task claim: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var taskID, taskARN string
	var tokenHash []byte
	err = tx.QueryRow(ctx, `
		SELECT id, task_arn, token_hash
		FROM ao_ecs_warm_tasks
		WHERE generation = $1 AND state = 'ready' AND task_arn <> ''
		ORDER BY ready_at, created_at
		FOR UPDATE SKIP LOCKED
		LIMIT 1
	`, generation).Scan(&taskID, &taskARN, &tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("select ECS warm task: %w", err)
	}
	tag, err := tx.Exec(ctx, `
		UPDATE ao_ecs_warm_tasks
		SET state = 'claimed', claimed_session_id = $2,
			claimed_at = now(), updated_at = now()
		WHERE id = $1 AND state = 'ready'
	`, taskID, sandbox.SessionID)
	if err != nil {
		return "", false, fmt.Errorf("claim ECS warm task: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return "", false, ErrECSWarmTaskNotFound
	}
	tag, err = tx.Exec(ctx, `
		UPDATE ao_sandboxes
		SET provider_environment_id = $3,
			observed_state = 'bootstrapping',
			last_error = '',
			reconcile_after = now() + interval '2 seconds',
			reconcile_lease_owner = '',
			reconcile_lease_until = NULL,
			updated_at = now()
		WHERE session_id = $1 AND org_id = $2 AND reconcile_lease_owner = $4
	`, sandbox.SessionID, sandbox.OrgID, taskARN, owner)
	if err != nil {
		return "", false, fmt.Errorf("bind ECS warm task to sandbox: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return "", false, ErrSandboxLeaseLost
	}
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO ao_access_tickets (
			account_id, org_id, session_id, purpose, scopes, token_hash, expires_at
		)
		VALUES ($1, $2, $3, 'worker_bootstrap', $4, $5, now() + $6::interval)
	`, sandbox.AccountID, sandbox.OrgID, sandbox.SessionID, scopes, tokenHash, intervalString(ttl))
	if err != nil {
		return "", false, fmt.Errorf("activate ECS warm worker ticket: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, fmt.Errorf("commit ECS warm task claim: %w", err)
	}
	return taskARN, true, nil
}

var (
	// ErrECSWarmTaskNotFound means a warm task changed state before an operation completed.
	ErrECSWarmTaskNotFound = errors.New("ECS warm task not found")
)
