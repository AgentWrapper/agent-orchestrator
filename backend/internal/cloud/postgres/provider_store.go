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
			account_id, provider, label, encrypted_secret, secret_nonce, config,
			validation_state, validated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, 'valid', now())
		ON CONFLICT (account_id, provider, label) DO UPDATE
		SET encrypted_secret = EXCLUDED.encrypted_secret,
			secret_nonce = EXCLUDED.secret_nonce,
			config = EXCLUDED.config,
			validation_state = 'valid',
			validated_at = now(),
			updated_at = now()
		RETURNING id, account_id, provider, label, config, validation_state,
			validated_at, created_at, updated_at
	`, accountID, provider, label, encryptedSecret, nonce, config).Scan(
		&connection.ID,
		&connection.AccountID,
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
		SELECT id, account_id, provider, label, config, validation_state,
			validated_at, created_at, updated_at
		FROM ao_provider_connections
		WHERE account_id = $1
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
		WHERE account_id = $1 AND id = $2
	`, accountID, connectionID).Scan(&encryptedSecret, &nonce, &config, &label)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil, "", ErrProviderConnectionNotFound
	}
	if err != nil {
		return nil, nil, nil, "", fmt.Errorf("load provider connection secret: %w", err)
	}
	return encryptedSecret, nonce, config, label, nil
}

// ErrProviderConnectionNotFound indicates that a provider connection does not exist.
var ErrProviderConnectionNotFound = errors.New("cloud provider connection not found")
