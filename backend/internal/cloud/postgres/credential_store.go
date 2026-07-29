package postgres

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/credentials"
)

// CreateAgentCredential persists encrypted credential material.
func (s *Store) CreateAgentCredential(ctx context.Context, rec credentials.Record) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO agent_credentials (
	org_id, id, user_id, provider, label, ciphertext, nonce, key_id, algorithm, created_at, updated_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`, rec.OrgID, rec.ID, rec.UserID, rec.Provider, rec.Label, rec.Ciphertext, rec.Nonce, rec.KeyID, rec.Algorithm, rec.CreatedAt.UTC(), rec.UpdatedAt.UTC())
	if err != nil {
		return fmt.Errorf("create agent credential: %w", err)
	}
	return nil
}
