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
