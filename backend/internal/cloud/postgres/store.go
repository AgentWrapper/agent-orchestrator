package postgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	// Register pgx with database/sql for goose migrations.
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

//go:embed migrations/*.sql
var migrations embed.FS

const migrationTableName = "ao_schema_migrations"

// Store persists AO Cloud state in PostgreSQL.
type Store struct {
	pool *pgxpool.Pool
}

// Migrate applies embedded AO Cloud database migrations.
func Migrate(ctx context.Context, databaseURL string) error {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open migration database: %w", err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping migration database: %w", err)
	}
	if _, err := db.ExecContext(ctx, "SELECT pg_advisory_lock(624829104271)"); err != nil {
		return fmt.Errorf("lock cloud migrations: %w", err)
	}
	defer func() {
		_, _ = db.ExecContext(context.Background(), "SELECT pg_advisory_unlock(624829104271)")
	}()
	if _, err := db.ExecContext(ctx, `
		DO $$
		BEGIN
			IF to_regclass('public.goose_db_version') IS NOT NULL
				AND to_regclass('public.ao_schema_migrations') IS NULL THEN
				ALTER TABLE public.goose_db_version RENAME TO ao_schema_migrations;
			END IF;
		END
		$$
	`); err != nil {
		return fmt.Errorf("normalize cloud migration table: %w", err)
	}
	goose.SetBaseFS(migrations)
	defer goose.SetBaseFS(nil)
	goose.SetTableName(migrationTableName)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set goose dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		return fmt.Errorf("apply cloud migrations: %w", err)
	}
	if _, err := db.ExecContext(
		ctx,
		"ALTER TABLE IF EXISTS public."+migrationTableName+" ENABLE ROW LEVEL SECURITY",
	); err != nil {
		return fmt.Errorf("secure cloud migration table: %w", err)
	}
	return nil
}

// Open connects to the AO Cloud PostgreSQL database.
func Open(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open postgres pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the store's connection pool.
func (s *Store) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}

// Ping verifies that the database is reachable.
func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

// EnsureAccount returns the account owned by a user, creating it when necessary.
func (s *Store) EnsureAccount(ctx context.Context, ownerUserID, displayName string) (clouddomain.Account, error) {
	var account clouddomain.Account
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_accounts (owner_user_id, display_name)
		VALUES ($1, $2)
		ON CONFLICT (owner_user_id) DO UPDATE
		SET display_name = CASE
			WHEN ao_accounts.display_name = '' THEN EXCLUDED.display_name
			ELSE ao_accounts.display_name
		END,
		updated_at = now()
		RETURNING id, owner_user_id, display_name, created_at, updated_at
	`, ownerUserID, displayName).Scan(
		&account.ID,
		&account.OwnerUserID,
		&account.DisplayName,
		&account.CreatedAt,
		&account.UpdatedAt,
	)
	if err != nil {
		return clouddomain.Account{}, fmt.Errorf("ensure account: %w", err)
	}
	return account, nil
}

// CreateProjectInput contains the writable fields of a new project.
type CreateProjectInput struct {
	DisplayName   string
	RepositoryURL string
	DefaultBranch string
	Config        json.RawMessage
}

// CreateProject creates a repository-backed project in an account.
func (s *Store) CreateProject(
	ctx context.Context,
	accountID clouddomain.AccountID,
	input CreateProjectInput,
) (clouddomain.Project, error) {
	if len(input.Config) == 0 {
		input.Config = json.RawMessage(`{}`)
	}
	var project clouddomain.Project
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_projects (
			account_id, display_name, repository_url, default_branch, config
		)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, account_id, display_name, repository_url, default_branch,
			config, created_at, updated_at
	`, accountID, input.DisplayName, input.RepositoryURL, input.DefaultBranch, input.Config).Scan(
		&project.ID,
		&project.AccountID,
		&project.DisplayName,
		&project.RepositoryURL,
		&project.DefaultBranch,
		&project.Config,
		&project.CreatedAt,
		&project.UpdatedAt,
	)
	if err != nil {
		return clouddomain.Project{}, fmt.Errorf("create project: %w", err)
	}
	return project, nil
}

// ListProjects returns the projects in an account.
func (s *Store) ListProjects(
	ctx context.Context,
	accountID clouddomain.AccountID,
) ([]clouddomain.Project, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, account_id, display_name, repository_url, default_branch,
			config, created_at, updated_at
		FROM ao_projects
		WHERE account_id = $1
		ORDER BY created_at
	`, accountID)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	projects := make([]clouddomain.Project, 0)
	for rows.Next() {
		var project clouddomain.Project
		if err := rows.Scan(
			&project.ID,
			&project.AccountID,
			&project.DisplayName,
			&project.RepositoryURL,
			&project.DefaultBranch,
			&project.Config,
			&project.CreatedAt,
			&project.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		projects = append(projects, project)
	}
	return projects, rows.Err()
}

// CreateSessionInput contains the durable settings for a new session.
type CreateSessionInput struct {
	IdempotencyKey       string
	ProjectID            clouddomain.ProjectID
	Kind                 string
	Harness              string
	DisplayName          string
	Branch               string
	Prompt               string
	Resource             clouddomain.ResourceProfile
	Provider             string
	ProviderConnectionID string
}

// CreateSessionResult contains the session creation receipt and resources.
type CreateSessionResult struct {
	Session clouddomain.Session        `json:"session"`
	Sandbox clouddomain.Sandbox        `json:"sandbox"`
	Command clouddomain.CommandReceipt `json:"command"`
	Created bool                       `json:"created"`
}

// CreateSession idempotently creates a session and requested sandbox.
func (s *Store) CreateSession(
	ctx context.Context,
	accountID clouddomain.AccountID,
	input CreateSessionInput,
) (CreateSessionResult, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return CreateSessionResult{}, fmt.Errorf("begin create session: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if input.Provider == "" {
		input.Provider = "daytona"
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return CreateSessionResult{}, fmt.Errorf("encode session command: %w", err)
	}
	commandID := uuid.NewString()
	var insertedID string
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_commands (
			id, account_id, idempotency_key, kind, payload
		)
		VALUES ($1, $2, $3, 'session.create', $4)
		ON CONFLICT (account_id, idempotency_key) DO NOTHING
		RETURNING id
	`, commandID, accountID, input.IdempotencyKey, payload).Scan(&insertedID)
	switch {
	case err == nil:
	case errors.Is(err, pgx.ErrNoRows):
		existing, loadErr := loadCreateSessionResult(ctx, tx, accountID, input.IdempotencyKey)
		if loadErr != nil {
			return CreateSessionResult{}, loadErr
		}
		if err := tx.Commit(ctx); err != nil {
			return CreateSessionResult{}, fmt.Errorf("commit existing session receipt: %w", err)
		}
		return existing, nil
	default:
		return CreateSessionResult{}, fmt.Errorf("insert command receipt: %w", err)
	}

	if input.Branch == "" {
		input.Branch = "ao/" + slug(input.DisplayName) + "-" + commandID[:8]
	}
	sessionID := uuid.NewString()
	var session clouddomain.Session
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_sessions (
			id, account_id, project_id, kind, harness, display_name, branch, prompt
		)
		SELECT $1, $2, id, $3, $4, $5, $6, $7
		FROM ao_projects
		WHERE id = $8 AND account_id = $2
		RETURNING id, account_id, project_id, kind, harness, display_name, branch,
			prompt, activity_state, is_terminated, agent_session_id, created_at,
			updated_at
	`, sessionID, accountID, input.Kind, input.Harness, input.DisplayName, input.Branch, input.Prompt, input.ProjectID).Scan(
		&session.ID,
		&session.AccountID,
		&session.ProjectID,
		&session.Kind,
		&session.Harness,
		&session.DisplayName,
		&session.Branch,
		&session.Prompt,
		&session.ActivityState,
		&session.IsTerminated,
		&session.AgentSessionID,
		&session.CreatedAt,
		&session.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateSessionResult{}, ErrProjectNotFound
	}
	if err != nil {
		return CreateSessionResult{}, fmt.Errorf("insert session: %w", err)
	}
	session.Status = deriveCloudStatus(session, "", "", "", "")
	if _, err := tx.Exec(ctx, `
		INSERT INTO ao_session_sequences (session_id, next_sequence)
		VALUES ($1, 1)
	`, session.ID); err != nil {
		return CreateSessionResult{}, fmt.Errorf("initialize session sequence: %w", err)
	}

	resourceJSON, err := json.Marshal(input.Resource)
	if err != nil {
		return CreateSessionResult{}, fmt.Errorf("encode resource profile: %w", err)
	}
	var resourceRaw []byte
	var sandbox clouddomain.Sandbox
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_sandboxes (
			session_id, account_id, provider, provider_connection_id,
			desired_state, observed_state, resource_profile
		)
		SELECT $1, $2, $5, connection.id, 'running', 'requested', $3
		FROM (SELECT 1) seed
		LEFT JOIN ao_provider_connections connection
			ON connection.account_id = $2
			AND connection.id = NULLIF($4, '')::uuid
		WHERE $4 = '' OR connection.id IS NOT NULL
		RETURNING session_id, account_id, provider,
			COALESCE(provider_environment_id, ''),
			COALESCE(provider_connection_id::text, ''),
			desired_state, observed_state, resource_profile, worker_last_seen_at,
			last_error, reconcile_after, created_at, updated_at
	`, session.ID, accountID, resourceJSON, input.ProviderConnectionID, input.Provider).Scan(
		&sandbox.SessionID,
		&sandbox.AccountID,
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
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateSessionResult{}, ErrProviderConnectionNotFound
	}
	if err != nil {
		return CreateSessionResult{}, fmt.Errorf("insert sandbox request: %w", err)
	}
	if err := json.Unmarshal(resourceRaw, &sandbox.ResourceProfile); err != nil {
		return CreateSessionResult{}, fmt.Errorf("decode resource profile: %w", err)
	}
	eventPayload, _ := json.Marshal(map[string]any{
		"kind":    session.Kind,
		"harness": session.Harness,
		"branch":  session.Branch,
	})
	if _, err := appendEventTx(ctx, tx, accountID, session.ID, "session.requested", eventPayload); err != nil {
		return CreateSessionResult{}, err
	}

	resultJSON, _ := json.Marshal(map[string]any{"sessionId": session.ID})
	var command clouddomain.CommandReceipt
	var commandResultRaw []byte
	err = tx.QueryRow(ctx, `
		UPDATE ao_commands
		SET session_id = $2, status = 'succeeded', result = $3, updated_at = now()
		WHERE id = $1
		RETURNING id, account_id, session_id, idempotency_key, kind, status,
			result, error_code, error_message, created_at, updated_at
	`, commandID, session.ID, resultJSON).Scan(
		&command.ID,
		&command.AccountID,
		&command.SessionID,
		&command.IdempotencyKey,
		&command.Kind,
		&command.Status,
		&commandResultRaw,
		&command.ErrorCode,
		&command.ErrorMessage,
		&command.CreatedAt,
		&command.UpdatedAt,
	)
	if err != nil {
		return CreateSessionResult{}, fmt.Errorf("complete command receipt: %w", err)
	}
	_ = json.Unmarshal(commandResultRaw, &command.Result)
	if err := tx.Commit(ctx); err != nil {
		return CreateSessionResult{}, fmt.Errorf("commit create session: %w", err)
	}
	return CreateSessionResult{Session: session, Sandbox: sandbox, Command: command, Created: true}, nil
}

func loadCreateSessionResult(
	ctx context.Context,
	tx pgx.Tx,
	accountID clouddomain.AccountID,
	idempotencyKey string,
) (CreateSessionResult, error) {
	var receipt clouddomain.CommandReceipt
	var resultRaw []byte
	err := tx.QueryRow(ctx, `
		SELECT id, account_id, COALESCE(session_id::text, ''), idempotency_key,
			kind, status, result, error_code, error_message, created_at, updated_at
		FROM ao_commands
		WHERE account_id = $1 AND idempotency_key = $2
	`, accountID, idempotencyKey).Scan(
		&receipt.ID,
		&receipt.AccountID,
		&receipt.SessionID,
		&receipt.IdempotencyKey,
		&receipt.Kind,
		&receipt.Status,
		&resultRaw,
		&receipt.ErrorCode,
		&receipt.ErrorMessage,
		&receipt.CreatedAt,
		&receipt.UpdatedAt,
	)
	if err != nil {
		return CreateSessionResult{}, fmt.Errorf("load command receipt: %w", err)
	}
	_ = json.Unmarshal(resultRaw, &receipt.Result)
	if receipt.SessionID == "" {
		return CreateSessionResult{Command: receipt}, nil
	}
	session, err := getSessionTx(ctx, tx, accountID, receipt.SessionID)
	if err != nil {
		return CreateSessionResult{}, err
	}
	session.Status = deriveCloudStatus(session, "", "", "", "")
	sandbox, err := getSandboxTx(ctx, tx, accountID, receipt.SessionID)
	if err != nil {
		return CreateSessionResult{}, err
	}
	return CreateSessionResult{
		Session: session,
		Sandbox: sandbox,
		Command: receipt,
		Created: false,
	}, nil
}

// ListSessions returns the sessions in an account.
func (s *Store) ListSessions(
	ctx context.Context,
	accountID clouddomain.AccountID,
) ([]clouddomain.Session, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, account_id, project_id, kind, harness, display_name, branch,
			prompt, activity_state, is_terminated, agent_session_id, created_at,
			updated_at
		FROM ao_sessions
		WHERE account_id = $1
		ORDER BY created_at
	`, accountID)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()
	sessions := make([]clouddomain.Session, 0)
	for rows.Next() {
		var session clouddomain.Session
		if err := rows.Scan(
			&session.ID,
			&session.AccountID,
			&session.ProjectID,
			&session.Kind,
			&session.Harness,
			&session.DisplayName,
			&session.Branch,
			&session.Prompt,
			&session.ActivityState,
			&session.IsTerminated,
			&session.AgentSessionID,
			&session.CreatedAt,
			&session.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range sessions {
		status, err := s.sessionStatus(ctx, accountID, sessions[index])
		if err != nil {
			return nil, err
		}
		sessions[index].Status = status
	}
	return sessions, nil
}

// GetSession returns one account-owned session with its derived status.
func (s *Store) GetSession(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (clouddomain.Session, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return clouddomain.Session{}, fmt.Errorf("begin get session: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	session, err := getSessionTx(ctx, tx, accountID, sessionID)
	if err != nil {
		return clouddomain.Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.Session{}, fmt.Errorf("commit get session: %w", err)
	}
	status, err := s.sessionStatus(ctx, accountID, session)
	if err != nil {
		return clouddomain.Session{}, err
	}
	session.Status = status
	return session, nil
}

func (s *Store) sessionStatus(
	ctx context.Context,
	accountID clouddomain.AccountID,
	session clouddomain.Session,
) (string, error) {
	var state, ci, review, mergeability string
	err := s.pool.QueryRow(ctx, `
		SELECT state, ci_state, review_state, mergeability
		FROM ao_pull_requests
		WHERE account_id = $1 AND session_id = $2
		ORDER BY updated_at DESC
		LIMIT 1
	`, accountID, session.ID).Scan(&state, &ci, &review, &mergeability)
	if errors.Is(err, pgx.ErrNoRows) {
		return deriveCloudStatus(session, "", "", "", ""), nil
	}
	if err != nil {
		return "", fmt.Errorf("derive cloud session status: %w", err)
	}
	return deriveCloudStatus(session, state, ci, review, mergeability), nil
}

func deriveCloudStatus(
	session clouddomain.Session,
	prState, ciState, reviewState, mergeability string,
) string {
	if session.IsTerminated {
		if prState == "merged" {
			return "merged"
		}
		return "terminated"
	}
	switch session.ActivityState {
	case "waiting_input", "blocked":
		return "needs_input"
	}
	switch {
	case prState == "merged":
		return "merged"
	case ciState == "failing":
		return "ci_failed"
	case reviewState == "changes_requested":
		return "changes_requested"
	case reviewState == "approved":
		return "approved"
	case mergeability == "mergeable":
		return "mergeable"
	case prState != "":
		return "pr_open"
	}
	switch session.ActivityState {
	case "active":
		return "working"
	case "exited":
		return "exited"
	default:
		return "idle"
	}
}

// AppendEvent appends the next durable event for a session.
func (s *Store) AppendEvent(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	eventType string,
	payload json.RawMessage,
) (clouddomain.Event, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.Event{}, fmt.Errorf("begin append event: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	event, err := appendEventTx(ctx, tx, accountID, sessionID, eventType, payload)
	if err != nil {
		return clouddomain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.Event{}, fmt.Errorf("commit event: %w", err)
	}
	return event, nil
}

func appendEventTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	eventType string,
	payload json.RawMessage,
) (clouddomain.Event, error) {
	var sequence int64
	err := tx.QueryRow(ctx, `
		UPDATE ao_session_sequences seq
		SET next_sequence = seq.next_sequence + 1
		FROM ao_sessions session
		WHERE seq.session_id = $1
			AND session.id = seq.session_id
			AND session.account_id = $2
		RETURNING seq.next_sequence - 1
	`, sessionID, accountID).Scan(&sequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.Event{}, ErrSessionNotFound
	}
	if err != nil {
		return clouddomain.Event{}, fmt.Errorf("allocate event sequence: %w", err)
	}
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	var event clouddomain.Event
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_events (account_id, session_id, sequence, type, payload)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING session_id, sequence, type, payload, created_at
	`, accountID, sessionID, sequence, eventType, payload).Scan(
		&event.SessionID,
		&event.Sequence,
		&event.Type,
		&event.Payload,
		&event.CreatedAt,
	)
	if err != nil {
		return clouddomain.Event{}, fmt.Errorf("insert event: %w", err)
	}
	return event, nil
}

// EventsAfter returns session events after a sequence number.
func (s *Store) EventsAfter(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	after int64,
	limit int,
) ([]clouddomain.Event, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx, `
		SELECT session_id, sequence, type, payload, created_at
		FROM ao_events
		WHERE account_id = $1 AND session_id = $2 AND sequence > $3
		ORDER BY sequence
		LIMIT $4
	`, accountID, sessionID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("replay events: %w", err)
	}
	defer rows.Close()
	events := make([]clouddomain.Event, 0)
	for rows.Next() {
		var event clouddomain.Event
		if err := rows.Scan(
			&event.SessionID,
			&event.Sequence,
			&event.Type,
			&event.Payload,
			&event.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// IssueAccessTicket creates a short-lived, single-use session ticket.
func (s *Store) IssueAccessTicket(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	purpose string,
	scopes []string,
	ttl time.Duration,
) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate access ticket: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	hash := sha256.Sum256([]byte(token))
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO ao_access_tickets (
			account_id, session_id, purpose, scopes, token_hash, expires_at
		)
		SELECT $1, $2, $3, $4, $5, now() + $6::interval
		FROM ao_sessions
		WHERE id = $2 AND account_id = $1
	`, accountID, sessionID, purpose, scopes, hash[:], intervalString(ttl))
	if err != nil {
		return "", fmt.Errorf("store access ticket: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return "", ErrSessionNotFound
	}
	return token, nil
}

// ConsumedTicket contains the identity and grants from a redeemed ticket.
type ConsumedTicket struct {
	AccountID clouddomain.AccountID
	SessionID clouddomain.SessionID
	Purpose   string
	Scopes    []string
}

// ConsumeAccessTicket atomically redeems a valid access ticket.
func (s *Store) ConsumeAccessTicket(
	ctx context.Context,
	token, purpose string,
) (ConsumedTicket, error) {
	hash := sha256.Sum256([]byte(token))
	var ticket ConsumedTicket
	err := s.pool.QueryRow(ctx, `
		UPDATE ao_access_tickets
		SET consumed_at = now()
		WHERE token_hash = $1
			AND purpose = $2
			AND consumed_at IS NULL
			AND expires_at > now()
		RETURNING account_id, session_id, purpose, scopes
	`, hash[:], purpose).Scan(
		&ticket.AccountID,
		&ticket.SessionID,
		&ticket.Purpose,
		&ticket.Scopes,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ConsumedTicket{}, ErrInvalidTicket
	}
	if err != nil {
		return ConsumedTicket{}, fmt.Errorf("consume access ticket: %w", err)
	}
	return ticket, nil
}

func intervalString(duration time.Duration) string {
	if duration <= 0 {
		duration = time.Minute
	}
	return fmt.Sprintf("%f seconds", duration.Seconds())
}

func getSessionTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (clouddomain.Session, error) {
	var session clouddomain.Session
	err := tx.QueryRow(ctx, `
		SELECT id, account_id, project_id, kind, harness, display_name, branch,
			prompt, activity_state, is_terminated, agent_session_id, created_at,
			updated_at
		FROM ao_sessions
		WHERE account_id = $1 AND id = $2
	`, accountID, sessionID).Scan(
		&session.ID,
		&session.AccountID,
		&session.ProjectID,
		&session.Kind,
		&session.Harness,
		&session.DisplayName,
		&session.Branch,
		&session.Prompt,
		&session.ActivityState,
		&session.IsTerminated,
		&session.AgentSessionID,
		&session.CreatedAt,
		&session.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.Session{}, ErrSessionNotFound
	}
	if err != nil {
		return clouddomain.Session{}, fmt.Errorf("get session: %w", err)
	}
	return session, nil
}

func getSandboxTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (clouddomain.Sandbox, error) {
	var sandbox clouddomain.Sandbox
	var resourceRaw []byte
	err := tx.QueryRow(ctx, `
		SELECT session_id, account_id, provider,
			COALESCE(provider_environment_id, ''),
			COALESCE(provider_connection_id::text, ''),
			desired_state, observed_state, resource_profile, worker_last_seen_at,
			last_error, reconcile_after, created_at, updated_at
		FROM ao_sandboxes
		WHERE account_id = $1 AND session_id = $2
	`, accountID, sessionID).Scan(
		&sandbox.SessionID,
		&sandbox.AccountID,
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
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.Sandbox{}, ErrSessionNotFound
	}
	if err != nil {
		return clouddomain.Sandbox{}, fmt.Errorf("get sandbox: %w", err)
	}
	if err := json.Unmarshal(resourceRaw, &sandbox.ResourceProfile); err != nil {
		return clouddomain.Sandbox{}, fmt.Errorf("decode sandbox resources: %w", err)
	}
	return sandbox, nil
}

func slug(value string) string {
	var builder strings.Builder
	lastDash := false
	for _, char := range strings.ToLower(strings.TrimSpace(value)) {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9':
			builder.WriteRune(char)
			lastDash = false
		case !lastDash:
			builder.WriteByte('-')
			lastDash = true
		}
	}
	result := strings.Trim(builder.String(), "-")
	if result == "" {
		return "session"
	}
	if len(result) > 32 {
		return strings.TrimRight(result[:32], "-")
	}
	return result
}

var (
	// ErrProjectNotFound indicates that an account-owned project does not exist.
	ErrProjectNotFound = errors.New("cloud project not found")
	// ErrSessionNotFound indicates that an account-owned session does not exist.
	ErrSessionNotFound = errors.New("cloud session not found")
	// ErrInvalidTicket indicates that an access ticket is invalid or expired.
	ErrInvalidTicket = errors.New("cloud access ticket is invalid or expired")
)
