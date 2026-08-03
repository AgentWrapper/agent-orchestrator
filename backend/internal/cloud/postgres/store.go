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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	// Register pgx with database/sql for goose migrations.
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/contract"
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
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.Account{}, fmt.Errorf("begin ensure account: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var account clouddomain.Account
	err = tx.QueryRow(ctx, `
		SELECT id, owner_user_id, display_name, created_at, updated_at
		FROM ao_accounts
		WHERE owner_user_id = $1
		ORDER BY created_at
		LIMIT 1
	`, ownerUserID).Scan(
		&account.ID,
		&account.OwnerUserID,
		&account.DisplayName,
		&account.CreatedAt,
		&account.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
			INSERT INTO ao_accounts (owner_user_id, display_name)
			VALUES ($1, $2)
			RETURNING id, owner_user_id, display_name, created_at, updated_at
		`, ownerUserID, displayName).Scan(
			&account.ID,
			&account.OwnerUserID,
			&account.DisplayName,
			&account.CreatedAt,
			&account.UpdatedAt,
		)
	}
	if err != nil {
		return clouddomain.Account{}, fmt.Errorf("ensure account: %w", err)
	}
	if err := ensureUserOrgTx(ctx, tx, account, displayName); err != nil {
		return clouddomain.Account{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.Account{}, fmt.Errorf("commit ensure account: %w", err)
	}
	return account, nil
}

// EnsureExternalAccount maps an external auth user into AO's durable user/org model.
func (s *Store) EnsureExternalAccount(
	ctx context.Context,
	authProvider string,
	externalUserID string,
	email string,
	displayName string,
) (clouddomain.Account, error) {
	authProvider = strings.TrimSpace(authProvider)
	externalUserID = strings.TrimSpace(externalUserID)
	email = strings.ToLower(strings.TrimSpace(email))
	displayName = strings.TrimSpace(displayName)
	if authProvider == "" || externalUserID == "" {
		return clouddomain.Account{}, fmt.Errorf("external auth provider and user ID are required")
	}
	if displayName == "" {
		displayName = firstNonEmpty(email, externalUserID)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.Account{}, fmt.Errorf("begin ensure external account: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var user clouddomain.User
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_users (auth_provider, external_user_id, email, display_name)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (auth_provider, external_user_id) DO UPDATE
		SET email = CASE
				WHEN EXCLUDED.email <> '' THEN EXCLUDED.email
				ELSE ao_users.email
			END,
			display_name = CASE
				WHEN ao_users.display_name = '' THEN EXCLUDED.display_name
				ELSE ao_users.display_name
			END,
			updated_at = now()
		RETURNING id, auth_provider, external_user_id, email, display_name, created_at, updated_at
	`, authProvider, externalUserID, email, displayName).Scan(
		&user.ID,
		&user.AuthProvider,
		&user.ExternalUserID,
		&user.Email,
		&user.DisplayName,
		&user.CreatedAt,
		&user.UpdatedAt,
	)
	if err != nil {
		return clouddomain.Account{}, fmt.Errorf("ensure external cloud user: %w", err)
	}

	var account clouddomain.Account
	err = tx.QueryRow(ctx, `
		SELECT id, owner_user_id, display_name, created_at, updated_at
		FROM ao_accounts
		WHERE owner_user_id = $1
		ORDER BY created_at
		LIMIT 1
	`, user.ID).Scan(
		&account.ID,
		&account.OwnerUserID,
		&account.DisplayName,
		&account.CreatedAt,
		&account.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
			INSERT INTO ao_accounts (owner_user_id, display_name)
			VALUES ($1, $2)
			RETURNING id, owner_user_id, display_name, created_at, updated_at
		`, user.ID, user.DisplayName).Scan(
			&account.ID,
			&account.OwnerUserID,
			&account.DisplayName,
			&account.CreatedAt,
			&account.UpdatedAt,
		)
	}
	if err != nil {
		return clouddomain.Account{}, fmt.Errorf("ensure external account: %w", err)
	}
	if err := ensureUserOrgTx(ctx, tx, account, user.DisplayName); err != nil {
		return clouddomain.Account{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.Account{}, fmt.Errorf("commit ensure external account: %w", err)
	}
	return account, nil
}

func ensureUserOrgTx(ctx context.Context, tx pgx.Tx, account clouddomain.Account, displayName string) error {
	if strings.TrimSpace(displayName) == "" {
		displayName = account.DisplayName
	}
	if strings.TrimSpace(displayName) == "" {
		displayName = "Personal workspace"
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ao_users (id, auth_provider, external_user_id, display_name)
		VALUES ($1::uuid, 'local', $1, $2)
		ON CONFLICT (id) DO UPDATE
		SET display_name = CASE
			WHEN ao_users.display_name = '' THEN EXCLUDED.display_name
			ELSE ao_users.display_name
		END,
		updated_at = now()
	`, account.OwnerUserID, displayName); err != nil {
		return fmt.Errorf("ensure cloud user: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ao_organizations (
			id, auth_provider, external_org_id, slug, display_name, kind, plan, status, created_by_user_id
		)
		VALUES ($1::uuid, 'local', $1, $2, $3, 'personal', 'free', 'active', $4)
		ON CONFLICT (id) DO UPDATE
		SET display_name = CASE
			WHEN ao_organizations.display_name = '' THEN EXCLUDED.display_name
			ELSE ao_organizations.display_name
		END,
		updated_at = now()
	`, account.ID, "personal-"+strings.ReplaceAll(string(account.ID), "-", ""), displayName, account.OwnerUserID); err != nil {
		return fmt.Errorf("ensure personal organization: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ao_org_memberships (org_id, user_id, role, status)
		VALUES ($1, $2, 'owner', 'active')
		ON CONFLICT (org_id, user_id) DO UPDATE
		SET role = CASE
			WHEN ao_org_memberships.role = '' THEN EXCLUDED.role
			ELSE ao_org_memberships.role
		END,
		status = 'active',
		updated_at = now()
	`, account.ID, account.OwnerUserID); err != nil {
		return fmt.Errorf("ensure organization membership: %w", err)
	}
	return nil
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
			account_id, org_id, display_name, repository_url, default_branch, config
		)
		VALUES ($1, $1, $2, $3, $4, $5)
		RETURNING id, account_id, org_id, display_name, repository_url, default_branch,
			config, created_at, updated_at
	`, accountID, input.DisplayName, input.RepositoryURL, input.DefaultBranch, input.Config).Scan(
		&project.ID,
		&project.AccountID,
		&project.OrgID,
		&project.DisplayName,
		&project.RepositoryURL,
		&project.DefaultBranch,
		&project.Config,
		&project.CreatedAt,
		&project.UpdatedAt,
	)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) &&
			(postgresError.ConstraintName == "ao_projects_account_id_repository_url_key" ||
				postgresError.ConstraintName == "ao_projects_org_repository_url_key") {
			return clouddomain.Project{}, ErrProjectExists
		}
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
		SELECT id, account_id, org_id, display_name, repository_url, default_branch,
			config, created_at, updated_at
		FROM ao_projects
		WHERE org_id = $1
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
			&project.OrgID,
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

// GetProject returns one account-owned cloud project.
func (s *Store) GetProject(
	ctx context.Context,
	accountID clouddomain.AccountID,
	projectID clouddomain.ProjectID,
) (clouddomain.Project, error) {
	var project clouddomain.Project
	err := s.pool.QueryRow(ctx, `
		SELECT id, account_id, org_id, display_name, repository_url, default_branch,
			config, created_at, updated_at
		FROM ao_projects
		WHERE org_id = $1 AND id = $2
	`, accountID, projectID).Scan(
		&project.ID,
		&project.AccountID,
		&project.OrgID,
		&project.DisplayName,
		&project.RepositoryURL,
		&project.DefaultBranch,
		&project.Config,
		&project.CreatedAt,
		&project.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.Project{}, ErrProjectNotFound
	}
	if err != nil {
		return clouddomain.Project{}, fmt.Errorf("get project: %w", err)
	}
	return project, nil
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
			id, account_id, org_id, idempotency_key, kind, payload
		)
		VALUES ($1, $2, $2, $3, 'session.create', $4)
		ON CONFLICT (org_id, idempotency_key) DO NOTHING
		RETURNING id
	`, commandID, accountID, input.IdempotencyKey, payload).Scan(&insertedID)
	switch {
	case err == nil:
	case errors.Is(err, pgx.ErrNoRows):
		existing, loadErr := loadCreateSessionResult(
			ctx,
			tx,
			accountID,
			input.IdempotencyKey,
			input,
		)
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
			id, account_id, org_id, project_id, kind, harness, display_name, branch, prompt
		)
		SELECT $1, $2, $2, id, $3, $4, $5, $6, $7
		FROM ao_projects
		WHERE id = $8 AND org_id = $2
		RETURNING id, account_id, org_id, project_id, kind, harness, display_name, branch,
			prompt, activity_state, is_terminated, agent_session_id, created_at,
			updated_at
	`, sessionID, accountID, input.Kind, input.Harness, input.DisplayName, input.Branch, input.Prompt, input.ProjectID).Scan(
		&session.ID,
		&session.AccountID,
		&session.OrgID,
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
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) &&
			postgresError.ConstraintName == "ao_sessions_one_active_orchestrator" {
			return CreateSessionResult{}, ErrActiveOrchestrator
		}
		return CreateSessionResult{}, fmt.Errorf("insert session: %w", err)
	}
	session.Status = string(deriveCloudStatus(session, nil))
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
			session_id, account_id, org_id, provider, provider_connection_id,
			desired_state, observed_state, resource_profile
		)
		SELECT $1, $2, $2, $5, connection.id, 'running', 'requested', $3
		FROM (SELECT 1) seed
		LEFT JOIN ao_provider_connections connection
			ON connection.org_id = $2
			AND connection.id = NULLIF($4, '')::uuid
		WHERE $4 = '' OR connection.id IS NOT NULL
		RETURNING session_id, account_id, org_id, provider,
			COALESCE(provider_environment_id, ''),
			COALESCE(provider_connection_id::text, ''),
			desired_state, observed_state, resource_profile, worker_last_seen_at,
			last_error, reconcile_after, created_at, updated_at
	`, session.ID, accountID, resourceJSON, input.ProviderConnectionID, input.Provider).Scan(
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
	if strings.TrimSpace(input.Prompt) != "" {
		turnID := uuid.NewString()
		promptPayload, marshalErr := json.Marshal(map[string]any{
			"id":      commandID,
			"text":    input.Prompt,
			"initial": true,
			"turnId":  turnID,
		})
		if marshalErr != nil {
			return CreateSessionResult{}, fmt.Errorf("encode initial user message: %w", marshalErr)
		}
		promptEvent, err := appendEventTx(
			ctx,
			tx,
			accountID,
			session.ID,
			"chat.user_message",
			promptPayload,
		)
		if err != nil {
			return CreateSessionResult{}, err
		}
		turn, err := scanTurn(tx.QueryRow(ctx, `
			INSERT INTO ao_turns (
				id, account_id, org_id, session_id, user_message_sequence, state
			)
			VALUES ($1, $2, $2, $3, $4, 'provisioning')
			RETURNING id, account_id, org_id, session_id, user_message_sequence, state,
				worker_epoch, attempt_count, error_message, started_at, completed_at,
				created_at, updated_at
		`, turnID, accountID, session.ID, promptEvent.Sequence))
		if err != nil {
			return CreateSessionResult{}, fmt.Errorf("insert initial durable turn: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE ao_sessions
			SET activity_state = 'active', updated_at = now()
			WHERE id = $1
		`, session.ID); err != nil {
			return CreateSessionResult{}, fmt.Errorf("activate initial cloud turn: %w", err)
		}
		session.ActivityState = "active"
		session.ActiveTurn = &turn
		session.Status = "working"
	}

	resultJSON, _ := json.Marshal(map[string]any{"sessionId": session.ID})
	var command clouddomain.CommandReceipt
	var commandResultRaw []byte
	err = tx.QueryRow(ctx, `
		UPDATE ao_commands
		SET session_id = $2, status = 'succeeded', result = $3, updated_at = now()
		WHERE id = $1
		RETURNING id, account_id, org_id, session_id, idempotency_key, kind, status,
			result, error_code, error_message, created_at, updated_at
	`, commandID, session.ID, resultJSON).Scan(
		&command.ID,
		&command.AccountID,
		&command.OrgID,
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
	expectedInput CreateSessionInput,
) (CreateSessionResult, error) {
	var receipt clouddomain.CommandReceipt
	var payloadRaw, resultRaw []byte
	err := tx.QueryRow(ctx, `
		SELECT id, account_id, org_id, COALESCE(session_id::text, ''), idempotency_key,
			kind, payload, status, result, error_code, error_message, created_at,
			updated_at
		FROM ao_commands
		WHERE org_id = $1 AND idempotency_key = $2
	`, accountID, idempotencyKey).Scan(
		&receipt.ID,
		&receipt.AccountID,
		&receipt.OrgID,
		&receipt.SessionID,
		&receipt.IdempotencyKey,
		&receipt.Kind,
		&payloadRaw,
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
	var existingInput CreateSessionInput
	if receipt.Kind != "session.create" ||
		json.Unmarshal(payloadRaw, &existingInput) != nil ||
		existingInput != expectedInput {
		return CreateSessionResult{}, ErrIdempotencyConflict
	}
	_ = json.Unmarshal(resultRaw, &receipt.Result)
	if receipt.SessionID == "" {
		return CreateSessionResult{Command: receipt}, nil
	}
	session, err := getSessionTx(ctx, tx, accountID, receipt.SessionID)
	if err != nil {
		return CreateSessionResult{}, err
	}
	session.Status = string(deriveCloudStatus(session, nil))
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
		SELECT id, account_id, org_id, project_id, kind, harness, display_name, branch,
			prompt, activity_state, is_terminated, agent_session_id, created_at,
			updated_at
		FROM ao_sessions
		WHERE org_id = $1
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
			&session.OrgID,
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
		activeTurn, err := s.GetActiveTurn(ctx, accountID, sessions[index].ID)
		if err != nil {
			return nil, err
		}
		sessions[index].ActiveTurn = activeTurn
		status, err := s.sessionStatus(ctx, accountID, sessions[index])
		if err != nil {
			return nil, err
		}
		sessions[index].Status = status
		capabilities, connected, err := s.sessionRuntime(ctx, accountID, sessions[index].ID)
		if err != nil {
			return nil, err
		}
		sessions[index].Capabilities = capabilities
		sessions[index].RuntimeConnected = connected
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
	activeTurn, err := s.GetActiveTurn(ctx, accountID, session.ID)
	if err != nil {
		return clouddomain.Session{}, err
	}
	session.ActiveTurn = activeTurn
	status, err := s.sessionStatus(ctx, accountID, session)
	if err != nil {
		return clouddomain.Session{}, err
	}
	session.Status = status
	capabilities, connected, err := s.sessionRuntime(ctx, accountID, session.ID)
	if err != nil {
		return clouddomain.Session{}, err
	}
	session.Capabilities = capabilities
	session.RuntimeConnected = connected
	return session, nil
}

// DeleteSession removes one account-owned worker session and all dependent cloud rows.
func (s *Store) DeleteSession(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM ao_sessions
		WHERE org_id = $1 AND id = $2 AND kind = 'worker'
	`, accountID, sessionID)
	if err != nil {
		return fmt.Errorf("delete cloud session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

func (s *Store) sessionRuntime(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) ([]string, bool, error) {
	var raw []byte
	var connected bool
	err := s.pool.QueryRow(ctx, `
		SELECT capabilities,
			ready_at IS NOT NULL
				AND disconnected_at IS NULL
				AND last_seen_at > now() - interval '45 seconds'
		FROM ao_worker_connections
		WHERE org_id = $1 AND session_id = $2
	`, accountID, sessionID).Scan(&raw, &connected)
	if errors.Is(err, pgx.ErrNoRows) {
		return []string{}, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("load session runtime: %w", err)
	}
	var capabilities []string
	if err := json.Unmarshal(raw, &capabilities); err != nil {
		return nil, false, fmt.Errorf("decode session capabilities: %w", err)
	}
	return capabilities, connected, nil
}

func (s *Store) sessionStatus(
	ctx context.Context,
	accountID clouddomain.AccountID,
	session clouddomain.Session,
) (string, error) {
	prs := make([]contract.PRFacts, 0)
	rows, err := s.pool.Query(ctx, `
		SELECT number, url, state, draft, ci_state, review_state, mergeability,
			source_branch, target_branch, updated_at,
			EXISTS (
				SELECT 1
				FROM ao_pr_review_threads t
				WHERE t.pull_request_id = pr.id
					AND t.is_resolved = false
					AND t.is_outdated = false
			) AS has_unresolved_threads
		FROM ao_pull_requests pr
		WHERE org_id = $1 AND session_id = $2
		ORDER BY updated_at DESC
	`, accountID, session.ID)
	if err != nil {
		return "", fmt.Errorf("derive cloud session status: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var pr contract.PRFacts
		var state, ci, review, mergeability string
		if err := rows.Scan(
			&pr.Number,
			&pr.URL,
			&state,
			&pr.Draft,
			&ci,
			&review,
			&mergeability,
			&pr.SourceBranch,
			&pr.TargetBranch,
			&pr.UpdatedAt,
			&pr.ReviewComments,
		); err != nil {
			return "", fmt.Errorf("scan cloud session PR status: %w", err)
		}
		pr.Merged = state == "merged"
		pr.Closed = state == "closed"
		pr.CI = contract.CIState(ci)
		pr.Review = contract.ReviewState(review)
		pr.Mergeability = contract.Mergeability(mergeability)
		prs = append(prs, pr)
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("scan cloud session PR statuses: %w", err)
	}
	if len(prs) == 0 {
		claimRows, claimErr := s.pool.Query(ctx, `
			SELECT number, url
			FROM ao_pr_claims
			WHERE org_id = $1 AND session_id = $2 AND released_at IS NULL
			ORDER BY claimed_at DESC
		`, accountID, session.ID)
		if claimErr != nil {
			return "", fmt.Errorf("derive cloud session claim status: %w", claimErr)
		}
		defer claimRows.Close()
		for claimRows.Next() {
			var pr contract.PRFacts
			if err := claimRows.Scan(&pr.Number, &pr.URL); err != nil {
				return "", fmt.Errorf("scan cloud session PR claim status: %w", err)
			}
			prs = append(prs, pr)
		}
		if err := claimRows.Err(); err != nil {
			return "", fmt.Errorf("scan cloud session PR claim statuses: %w", err)
		}
	}
	return string(deriveCloudStatus(session, prs)), nil
}

func deriveCloudStatus(session clouddomain.Session, prs []contract.PRFacts) contract.SessionStatus {
	return contract.DeriveSessionStatus(contract.SessionFacts{
		Terminated:    session.IsTerminated,
		Activity:      contract.ActivityState(session.ActivityState),
		HasActiveTurn: session.ActiveTurn != nil,
	}, prs)
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
			AND session.org_id = $2
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
		INSERT INTO ao_events (account_id, org_id, session_id, sequence, type, payload)
		VALUES ($1, $1, $2, $3, $4, $5)
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

// AppendUserMessage idempotently records a durable browser-submitted chat prompt.
func (s *Store) AppendUserMessage(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	idempotencyKey, text string,
) (clouddomain.Event, bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.Event{}, false, fmt.Errorf("begin append user message: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	commandID := uuid.NewString()
	commandPayload, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return clouddomain.Event{}, false, fmt.Errorf("encode user message command: %w", err)
	}
	var insertedID string
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_commands (
			id, account_id, org_id, session_id, idempotency_key, kind, payload
		)
		SELECT $1, $2, $2, session.id, $4, 'session.message', $5
		FROM ao_sessions session
		WHERE session.id = $3 AND session.org_id = $2
		ON CONFLICT (org_id, idempotency_key) DO NOTHING
		RETURNING id
	`, commandID, accountID, sessionID, idempotencyKey, commandPayload).Scan(&insertedID)
	switch {
	case err == nil:
	case errors.Is(err, pgx.ErrNoRows):
		event, loadErr := loadUserMessageEvent(ctx, tx, accountID, sessionID, idempotencyKey, text)
		if loadErr != nil {
			return clouddomain.Event{}, false, loadErr
		}
		if err := tx.Commit(ctx); err != nil {
			return clouddomain.Event{}, false, fmt.Errorf("commit existing user message: %w", err)
		}
		return event, false, nil
	default:
		return clouddomain.Event{}, false, fmt.Errorf("insert user message command: %w", err)
	}

	turnID := uuid.NewString()
	payload, err := json.Marshal(map[string]string{
		"id":     commandID,
		"text":   text,
		"turnId": turnID,
	})
	if err != nil {
		return clouddomain.Event{}, false, fmt.Errorf("encode user message event: %w", err)
	}
	event, err := appendEventTx(ctx, tx, accountID, sessionID, "chat.user_message", payload)
	if err != nil {
		return clouddomain.Event{}, false, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ao_turns (
			id, account_id, org_id, session_id, user_message_sequence, state
		)
		VALUES ($1, $2, $2, $3, $4, 'queued')
	`, turnID, accountID, sessionID, event.Sequence); err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) &&
			postgresError.ConstraintName == "ao_turns_one_active_per_session" {
			return clouddomain.Event{}, false, ErrActiveTurn
		}
		return clouddomain.Event{}, false, fmt.Errorf("insert durable turn: %w", err)
	}
	result, err := json.Marshal(map[string]any{
		"eventSequence": event.Sequence,
		"turnId":        turnID,
	})
	if err != nil {
		return clouddomain.Event{}, false, fmt.Errorf("encode user message result: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ao_commands
		SET status = 'succeeded', result = $2, updated_at = now()
		WHERE id = $1
	`, commandID, result); err != nil {
		return clouddomain.Event{}, false, fmt.Errorf("complete user message command: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.Event{}, false, fmt.Errorf("commit user message: %w", err)
	}
	return event, true, nil
}

func loadUserMessageEvent(
	ctx context.Context,
	tx pgx.Tx,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	idempotencyKey, text string,
) (clouddomain.Event, error) {
	var existingSessionID clouddomain.SessionID
	var kind string
	var payloadRaw, resultRaw []byte
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(session_id::text, ''), kind, payload, result
		FROM ao_commands
		WHERE org_id = $1 AND idempotency_key = $2
	`, accountID, idempotencyKey).Scan(&existingSessionID, &kind, &payloadRaw, &resultRaw)
	if err != nil {
		return clouddomain.Event{}, fmt.Errorf("load user message command: %w", err)
	}
	var payload struct {
		Text string `json:"text"`
	}
	var result struct {
		EventSequence int64 `json:"eventSequence"`
	}
	if kind != "session.message" ||
		existingSessionID != sessionID ||
		json.Unmarshal(payloadRaw, &payload) != nil ||
		payload.Text != text ||
		json.Unmarshal(resultRaw, &result) != nil ||
		result.EventSequence <= 0 {
		return clouddomain.Event{}, ErrIdempotencyConflict
	}
	var event clouddomain.Event
	err = tx.QueryRow(ctx, `
		SELECT session_id, sequence, type, payload, created_at
		FROM ao_events
		WHERE org_id = $1 AND session_id = $2 AND sequence = $3
	`, accountID, sessionID, result.EventSequence).Scan(
		&event.SessionID,
		&event.Sequence,
		&event.Type,
		&event.Payload,
		&event.CreatedAt,
	)
	if err != nil {
		return clouddomain.Event{}, fmt.Errorf("load user message event: %w", err)
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
		WHERE org_id = $1 AND session_id = $2 AND sequence > $3
		ORDER BY sequence
		LIMIT $4
	`, accountID, sessionID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("replay events: %w", err)
	}
	defer rows.Close()
	return scanEvents(rows, "event")
}

// ChatEventsAfter returns only native chat events after a sequence number.
func (s *Store) ChatEventsAfter(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	after int64,
	limit int,
) ([]clouddomain.Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx, `
		SELECT session_id, sequence, type, payload, created_at
		FROM ao_events
		WHERE org_id = $1
			AND session_id = $2
			AND sequence > $3
			AND type LIKE 'chat.%'
		ORDER BY sequence
		LIMIT $4
	`, accountID, sessionID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("replay chat events: %w", err)
	}
	defer rows.Close()
	return scanEvents(rows, "chat event")
}

// ResultEventsAfter returns result-bearing events for both structured and
// terminal-first workers.
func (s *Store) ResultEventsAfter(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	after int64,
	limit int,
) ([]clouddomain.Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx, `
		SELECT session_id, sequence, type, payload, created_at
		FROM ao_events
		WHERE org_id = $1
			AND session_id = $2
			AND sequence > $3
			AND (
				type LIKE 'chat.%'
				OR (
					type = 'agent.activity'
					AND payload->>'event' IN ('stop', 'after-agent')
				)
			)
		ORDER BY sequence
		LIMIT $4
	`, accountID, sessionID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("replay result events: %w", err)
	}
	defer rows.Close()
	return scanEvents(rows, "result event")
}

// ActivePromptEventsAfter returns legacy prompts and prompts whose durable
// turn is still unfinished. Terminal turns must never replay to a new worker.
func (s *Store) ActivePromptEventsAfter(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	after int64,
	limit int,
) ([]clouddomain.Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx, `
		SELECT event.session_id, event.sequence, event.type, event.payload, event.created_at
		FROM ao_events event
		LEFT JOIN ao_turns turn
			ON turn.session_id = event.session_id
			AND turn.user_message_sequence = event.sequence
		WHERE event.org_id = $1
			AND event.session_id = $2
			AND event.sequence > $3
			AND event.type = 'chat.user_message'
			AND (
				turn.id IS NULL
				OR turn.state = ANY($5)
			)
		ORDER BY event.sequence
		LIMIT $4
	`, accountID, sessionID, after, limit, activeTurnStates)
	if err != nil {
		return nil, fmt.Errorf("replay active prompt events: %w", err)
	}
	defer rows.Close()
	return scanEvents(rows, "active prompt event")
}

func scanEvents(rows pgx.Rows, description string) ([]clouddomain.Event, error) {
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
			return nil, fmt.Errorf("scan %s: %w", description, err)
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// LatestEventSequenceByType returns the newest matching session event sequence.
func (s *Store) LatestEventSequenceByType(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	eventType string,
) (int64, error) {
	var sequence int64
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(sequence), 0)
		FROM ao_events
		WHERE org_id = $1 AND session_id = $2 AND type = $3
	`, accountID, sessionID, eventType).Scan(&sequence); err != nil {
		return 0, fmt.Errorf("load latest event sequence: %w", err)
	}
	return sequence, nil
}

// LatestPromptAcceptedSequence returns the newest durable worker prompt acknowledgement.
func (s *Store) LatestPromptAcceptedSequence(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (int64, error) {
	var sequence int64
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(
			CASE
				WHEN jsonb_typeof(payload->'sequence') = 'number'
				THEN (payload->>'sequence')::bigint
			END
		), 0)
		FROM ao_events
		WHERE org_id = $1
			AND session_id = $2
			AND type = 'worker.prompt_accepted'
			AND payload ? 'sequence'
	`, accountID, sessionID).Scan(&sequence); err != nil {
		return 0, fmt.Errorf("load latest accepted prompt: %w", err)
	}
	return sequence, nil
}

// SetAgentSessionID records the provider-native conversation identifier for resume.
func (s *Store) SetAgentSessionID(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	agentSessionID string,
) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_sessions
		SET agent_session_id = $3, updated_at = now()
		WHERE org_id = $1 AND id = $2
	`, accountID, sessionID, agentSessionID)
	if err != nil {
		return fmt.Errorf("store agent session ID: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
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
			account_id, org_id, session_id, purpose, scopes, token_hash, expires_at
		)
		SELECT $1, $1, $2, $3, $4, $5, now() + $6::interval
		FROM ao_sessions
		WHERE id = $2 AND org_id = $1
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
	AccountID   clouddomain.AccountID
	SessionID   clouddomain.SessionID
	Purpose     string
	Scopes      []string
	WorkerEpoch int64
}

// ConsumeAccessTicket atomically redeems a valid access ticket.
func (s *Store) ConsumeAccessTicket(
	ctx context.Context,
	token, purpose string,
) (ConsumedTicket, error) {
	return s.redeemAccessTicket(ctx, token, purpose, false)
}

// RedeemWorkerBootstrapTicket redeems a worker bootstrap ticket and permits
// short-lived retries of the same exchange after an ambiguous HTTP failure.
func (s *Store) RedeemWorkerBootstrapTicket(
	ctx context.Context,
	token string,
) (ConsumedTicket, error) {
	return s.redeemAccessTicket(ctx, token, "worker_bootstrap", true)
}

func (s *Store) redeemAccessTicket(
	ctx context.Context,
	token, purpose string,
	allowRecentReplay bool,
) (ConsumedTicket, error) {
	hash := sha256.Sum256([]byte(token))
	var ticket ConsumedTicket
	err := s.pool.QueryRow(ctx, `
		UPDATE ao_access_tickets
		SET
			consumed_at = COALESCE(consumed_at, now()),
			worker_epoch = CASE
				WHEN purpose = 'worker_bootstrap'
				THEN COALESCE(worker_epoch, nextval('ao_worker_epoch_sequence'))
				ELSE worker_epoch
			END
		WHERE token_hash = $1
			AND purpose = $2
			AND (
				consumed_at IS NULL
				OR ($3 AND consumed_at > now() - interval '2 minutes')
			)
			AND expires_at > now()
		RETURNING account_id, session_id, purpose, scopes, COALESCE(worker_epoch, 0)
	`, hash[:], purpose, allowRecentReplay).Scan(
		&ticket.AccountID,
		&ticket.SessionID,
		&ticket.Purpose,
		&ticket.Scopes,
		&ticket.WorkerEpoch,
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func getSessionTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (clouddomain.Session, error) {
	var session clouddomain.Session
	err := tx.QueryRow(ctx, `
		SELECT id, account_id, org_id, project_id, kind, harness, display_name, branch,
			prompt, activity_state, is_terminated, agent_session_id, created_at,
			updated_at
		FROM ao_sessions
		WHERE org_id = $1 AND id = $2
	`, accountID, sessionID).Scan(
		&session.ID,
		&session.AccountID,
		&session.OrgID,
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
		SELECT session_id, account_id, org_id, provider,
			COALESCE(provider_environment_id, ''),
			COALESCE(provider_connection_id::text, ''),
			desired_state, observed_state, resource_profile, worker_last_seen_at,
			last_error, reconcile_after, created_at, updated_at
		FROM ao_sandboxes
		WHERE org_id = $1 AND session_id = $2
	`, accountID, sessionID).Scan(
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
	// ErrProjectExists indicates that a repository is already registered to an account.
	ErrProjectExists = errors.New("cloud project already exists")
	// ErrSessionNotFound indicates that an account-owned session does not exist.
	ErrSessionNotFound = errors.New("cloud session not found")
	// ErrActiveOrchestrator indicates that a project already has a live orchestrator.
	ErrActiveOrchestrator = errors.New("cloud project already has an active orchestrator")
	// ErrInvalidTicket indicates that an access ticket is invalid or expired.
	ErrInvalidTicket = errors.New("cloud access ticket is invalid or expired")
	// ErrIdempotencyConflict indicates that a key was already used for another command.
	ErrIdempotencyConflict = errors.New("cloud idempotency key conflicts with an existing command")
	// ErrActiveTurn indicates that a session already has unfinished work.
	ErrActiveTurn = errors.New("cloud session already has an active turn")
	// ErrLocalUserExists indicates the email is already registered for local authentication.
	ErrLocalUserExists = errors.New("cloud local user already exists")
	// ErrLocalUserNotFound indicates the email is not registered for local authentication.
	ErrLocalUserNotFound = errors.New("cloud local user not found")
	// ErrLocalSessionNotFound indicates the local login token is invalid or expired.
	ErrLocalSessionNotFound = errors.New("cloud local session not found")
	// ErrInvalidUserProfile indicates the profile update is invalid.
	ErrInvalidUserProfile = errors.New("cloud user profile is invalid")
	// ErrCloudUserNotFound indicates the cloud user row does not exist.
	ErrCloudUserNotFound = errors.New("cloud user not found")
	// ErrOrgMembershipNotFound indicates the user does not belong to the org.
	ErrOrgMembershipNotFound = errors.New("cloud organization membership not found")
)
