package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// ProviderConnection describes an account-owned sandbox provider credential.
type ProviderConnection struct {
	ID              string                `json:"id"`
	AccountID       clouddomain.AccountID `json:"accountId"`
	OrgID           clouddomain.OrgID     `json:"orgId"`
	Provider        string                `json:"provider"`
	Label           string                `json:"label"`
	Config          json.RawMessage       `json:"config"`
	ValidationState string                `json:"validationState"`
	ValidatedAt     *time.Time            `json:"validatedAt,omitempty"`
	CreatedAt       time.Time             `json:"createdAt"`
	UpdatedAt       time.Time             `json:"updatedAt"`
}

// OrgProviderSettings controls how an organization gets coding-agent credentials.
type OrgProviderSettings struct {
	OrgID                clouddomain.OrgID `json:"orgId"`
	AgentCredentialsMode string            `json:"agentCredentialsMode"`
	UpdatedAt            time.Time         `json:"updatedAt"`
}

// UpsertProviderConnection stores encrypted provider credentials and metadata.
func (s *Store) UpsertProviderConnection(
	ctx context.Context,
	accountID clouddomain.AccountID,
	provider, label string,
	encryptedSecret, nonce []byte,
	config json.RawMessage,
) (ProviderConnection, error) {
	if len(config) == 0 {
		config = json.RawMessage(`{}`)
	}
	var connection ProviderConnection
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_provider_connections (
			account_id, org_id, provider, label, encrypted_secret, secret_nonce, config,
			validation_state, validated_at
		)
		VALUES ($1, $1, $2, $3, $4, $5, $6, 'valid', now())
		ON CONFLICT (org_id, provider, label) DO UPDATE
		SET encrypted_secret = EXCLUDED.encrypted_secret,
			secret_nonce = EXCLUDED.secret_nonce,
			config = EXCLUDED.config,
			validation_state = 'valid',
			validated_at = now(),
			updated_at = now()
		RETURNING id, account_id, org_id, provider, label, config, validation_state,
			validated_at, created_at, updated_at
	`, accountID, provider, label, encryptedSecret, nonce, config).Scan(
		&connection.ID,
		&connection.AccountID,
		&connection.OrgID,
		&connection.Provider,
		&connection.Label,
		&connection.Config,
		&connection.ValidationState,
		&connection.ValidatedAt,
		&connection.CreatedAt,
		&connection.UpdatedAt,
	)
	if err != nil {
		return ProviderConnection{}, fmt.Errorf("upsert provider connection: %w", err)
	}
	return connection, nil
}

// SetOrgProviderSettings stores provider credential behavior for an organization.
func (s *Store) SetOrgProviderSettings(
	ctx context.Context,
	orgID clouddomain.OrgID,
	mode string,
) (OrgProviderSettings, error) {
	if mode != "custom" && mode != "personal_default" {
		return OrgProviderSettings{}, ErrInvalidProviderSettings
	}
	var settings OrgProviderSettings
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_org_provider_settings (org_id, agent_credentials_mode)
		VALUES ($1, $2)
		ON CONFLICT (org_id) DO UPDATE
		SET agent_credentials_mode = EXCLUDED.agent_credentials_mode,
			updated_at = now()
		RETURNING org_id, agent_credentials_mode, updated_at
	`, orgID, mode).Scan(
		&settings.OrgID,
		&settings.AgentCredentialsMode,
		&settings.UpdatedAt,
	)
	if err != nil {
		return OrgProviderSettings{}, fmt.Errorf("set provider settings: %w", err)
	}
	return settings, nil
}

// OrgProviderSettings returns provider credential behavior for an organization.
func (s *Store) OrgProviderSettings(
	ctx context.Context,
	orgID clouddomain.OrgID,
) (OrgProviderSettings, error) {
	var settings OrgProviderSettings
	err := s.pool.QueryRow(ctx, `
		SELECT org.id,
			COALESCE(settings.agent_credentials_mode, 'custom'),
			COALESCE(settings.updated_at, org.updated_at)
		FROM ao_organizations org
		LEFT JOIN ao_org_provider_settings settings ON settings.org_id = org.id
		WHERE org.id = $1
	`, orgID).Scan(
		&settings.OrgID,
		&settings.AgentCredentialsMode,
		&settings.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return OrgProviderSettings{}, ErrOrganizationNotFound
	}
	if err != nil {
		return OrgProviderSettings{}, fmt.Errorf("get provider settings: %w", err)
	}
	return settings, nil
}

// PersonalOrgIDForUser returns the user's personal organization.
func (s *Store) PersonalOrgIDForUser(ctx context.Context, userID string) (clouddomain.OrgID, error) {
	var orgID clouddomain.OrgID
	err := s.pool.QueryRow(ctx, `
		SELECT org.id
		FROM ao_org_memberships membership
		JOIN ao_organizations org ON org.id = membership.org_id
		WHERE membership.user_id = $1
			AND membership.status = 'active'
			AND org.kind = 'personal'
			AND org.status = 'active'
		ORDER BY org.created_at
		LIMIT 1
	`, userID).Scan(&orgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrOrganizationNotFound
	}
	if err != nil {
		return "", fmt.Errorf("get personal organization: %w", err)
	}
	return orgID, nil
}

// ListDefaultProviderOrgsForUser returns active organizations that inherit the
// user's personal provider credentials.
func (s *Store) ListDefaultProviderOrgsForUser(ctx context.Context, userID string) ([]clouddomain.OrgID, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT org.id
		FROM ao_org_memberships membership
		JOIN ao_organizations org ON org.id = membership.org_id
		JOIN ao_org_provider_settings settings ON settings.org_id = org.id
		WHERE membership.user_id = $1
			AND membership.role = 'owner'
			AND membership.status = 'active'
			AND org.kind <> 'personal'
			AND org.status = 'active'
			AND settings.agent_credentials_mode = 'personal_default'
		ORDER BY org.created_at
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list default provider organizations: %w", err)
	}
	defer rows.Close()
	out := make([]clouddomain.OrgID, 0)
	for rows.Next() {
		var orgID clouddomain.OrgID
		if err := rows.Scan(&orgID); err != nil {
			return nil, fmt.Errorf("scan default provider organization: %w", err)
		}
		out = append(out, orgID)
	}
	return out, rows.Err()
}

// ListProviderConnections returns redacted provider connections for an account.
func (s *Store) ListProviderConnections(
	ctx context.Context,
	accountID clouddomain.AccountID,
) ([]ProviderConnection, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, account_id, org_id, provider, label, config, validation_state,
			validated_at, created_at, updated_at
		FROM ao_provider_connections
		WHERE org_id = $1
		ORDER BY provider, label
	`, accountID)
	if err != nil {
		return nil, fmt.Errorf("list provider connections: %w", err)
	}
	defer rows.Close()
	connections := make([]ProviderConnection, 0)
	for rows.Next() {
		var connection ProviderConnection
		if err := rows.Scan(
			&connection.ID,
			&connection.AccountID,
			&connection.OrgID,
			&connection.Provider,
			&connection.Label,
			&connection.Config,
			&connection.ValidationState,
			&connection.ValidatedAt,
			&connection.CreatedAt,
			&connection.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan provider connection: %w", err)
		}
		connections = append(connections, connection)
	}
	return connections, rows.Err()
}

// ProviderConnectionSecret returns encrypted credentials and configuration for a connection.
func (s *Store) ProviderConnectionSecret(
	ctx context.Context,
	accountID clouddomain.AccountID,
	connectionID string,
) (encryptedSecret, nonce []byte, config json.RawMessage, label string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT encrypted_secret, secret_nonce, config, label
		FROM ao_provider_connections
		WHERE org_id = $1 AND id = $2
	`, accountID, connectionID).Scan(&encryptedSecret, &nonce, &config, &label)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil, "", ErrProviderConnectionNotFound
	}
	if err != nil {
		return nil, nil, nil, "", fmt.Errorf("load provider connection secret: %w", err)
	}
	return encryptedSecret, nonce, config, label, nil
}

// ProviderConnectionSecretByProvider returns encrypted credentials for an
// account-owned provider connection identified by provider and label.
func (s *Store) ProviderConnectionSecretByProvider(
	ctx context.Context,
	accountID clouddomain.AccountID,
	provider, label string,
) (encryptedSecret, nonce []byte, config json.RawMessage, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT encrypted_secret, secret_nonce, config
		FROM ao_provider_connections
		WHERE org_id = $1
			AND provider = $2
			AND label = $3
			AND validation_state = 'valid'
	`, accountID, provider, label).Scan(&encryptedSecret, &nonce, &config)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil, ErrProviderConnectionNotFound
	}
	if err != nil {
		return nil, nil, nil, fmt.Errorf("load provider connection by provider: %w", err)
	}
	return encryptedSecret, nonce, config, nil
}

// DeleteProviderConnection deletes one account-owned provider connection.
func (s *Store) DeleteProviderConnection(
	ctx context.Context,
	accountID clouddomain.AccountID,
	provider, label string,
) error {
	if _, err := s.pool.Exec(ctx, `
		DELETE FROM ao_provider_connections
		WHERE org_id = $1 AND provider = $2 AND label = $3
	`, accountID, provider, label); err != nil {
		return fmt.Errorf("delete provider connection: %w", err)
	}
	return nil
}

// ErrProviderConnectionNotFound indicates that a provider connection does not exist.
var ErrProviderConnectionNotFound = errors.New("cloud provider connection not found")

// ErrInvalidProviderSettings indicates unsupported provider settings input.
var ErrInvalidProviderSettings = errors.New("cloud provider settings are invalid")
