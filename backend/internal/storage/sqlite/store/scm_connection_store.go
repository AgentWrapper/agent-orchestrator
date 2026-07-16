package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// CreateSCMConnection inserts one metadata-only SCM connection.
func (s *Store) CreateSCMConnection(ctx context.Context, connection domain.SCMConnection) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.CreateSCMConnection(ctx, createSCMConnectionParams(connection)); err != nil {
		return fmt.Errorf("create SCM connection %s: %w", connection.ID, err)
	}
	return nil
}

// GetSCMConnection returns one connection by ID.
func (s *Store) GetSCMConnection(ctx context.Context, id string) (domain.SCMConnection, bool, error) {
	row, err := s.qr.GetSCMConnection(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.SCMConnection{}, false, nil
	}
	if err != nil {
		return domain.SCMConnection{}, false, fmt.Errorf("get SCM connection %s: %w", id, err)
	}
	return scmConnectionFromGen(row), true, nil
}

// ListSCMConnections returns all connections ordered by ID.
func (s *Store) ListSCMConnections(ctx context.Context) ([]domain.SCMConnection, error) {
	rows, err := s.qr.ListSCMConnections(ctx)
	if err != nil {
		return nil, fmt.Errorf("list SCM connections: %w", err)
	}
	connections := make([]domain.SCMConnection, 0, len(rows))
	for _, row := range rows {
		connections = append(connections, scmConnectionFromGen(row))
	}
	return connections, nil
}

// UpdateSCMConnection replaces mutable metadata and reports whether it existed.
func (s *Store) UpdateSCMConnection(ctx context.Context, connection domain.SCMConnection) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.UpdateSCMConnection(ctx, gen.UpdateSCMConnectionParams{
		Provider:      string(connection.Provider),
		DisplayName:   connection.DisplayName,
		WebBaseURL:    connection.WebBaseURL,
		APIBaseURL:    connection.APIBaseURL,
		CredentialRef: connection.CredentialRef,
		Status:        string(connection.Status),
		Username:      connection.Username,
		UpdatedAt:     connection.UpdatedAt,
		ID:            connection.ID,
	})
	if err != nil {
		return false, fmt.Errorf("update SCM connection %s: %w", connection.ID, err)
	}
	return rows > 0, nil
}

// UpdateSCMConnectionValidation persists test metadata without advancing the configuration revision.
func (s *Store) UpdateSCMConnectionValidation(ctx context.Context, id string, expectedUpdatedAt time.Time, status domain.SCMConnectionStatus, username string) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.UpdateSCMConnectionValidation(ctx, gen.UpdateSCMConnectionValidationParams{
		Status:            string(status),
		Username:          username,
		ID:                id,
		ExpectedUpdatedAt: expectedUpdatedAt,
	})
	if err != nil {
		return false, fmt.Errorf("update SCM connection %s validation: %w", id, err)
	}
	return rows > 0, nil
}

// DeleteSCMConnection deletes an unreferenced connection and reports whether it existed.
func (s *Store) DeleteSCMConnection(ctx context.Context, id string) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	deleted := false
	err := s.inTx(ctx, "delete SCM connection "+id, func(q *gen.Queries) error {
		if err := q.AcquireSCMConnectionWriteLock(ctx); err != nil {
			return fmt.Errorf("acquire write lock: %w", err)
		}
		rows, err := q.DeleteUnreferencedSCMConnection(ctx, gen.DeleteUnreferencedSCMConnectionParams{
			ID:     id,
			Config: sql.NullString{String: id, Valid: true},
		})
		if err != nil {
			return err
		}
		if rows > 0 {
			deleted = true
			return nil
		}
		_, err = q.GetSCMConnection(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("classify zero-row delete: %w", err)
		}
		return ports.ErrSCMConnectionReferenced
	})
	if err != nil {
		return false, err
	}
	return deleted, nil
}

func createSCMConnectionParams(connection domain.SCMConnection) gen.CreateSCMConnectionParams {
	return gen.CreateSCMConnectionParams{
		ID:            connection.ID,
		Provider:      string(connection.Provider),
		DisplayName:   connection.DisplayName,
		WebBaseURL:    connection.WebBaseURL,
		APIBaseURL:    connection.APIBaseURL,
		CredentialRef: connection.CredentialRef,
		Status:        string(connection.Status),
		Username:      connection.Username,
		CreatedAt:     connection.CreatedAt,
		UpdatedAt:     connection.UpdatedAt,
	}
}

func scmConnectionFromGen(row gen.SCMConnection) domain.SCMConnection {
	return domain.SCMConnection{
		ID:            row.ID,
		Provider:      domain.SCMProvider(row.Provider),
		DisplayName:   row.DisplayName,
		WebBaseURL:    row.WebBaseURL,
		APIBaseURL:    row.APIBaseURL,
		CredentialRef: row.CredentialRef,
		Status:        domain.SCMConnectionStatus(row.Status),
		Username:      row.Username,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
	}
}
