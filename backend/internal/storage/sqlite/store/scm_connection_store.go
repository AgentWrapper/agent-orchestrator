package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// ErrSCMConnectionReferenced prevents deleting a connection selected by a project.
var ErrSCMConnectionReferenced = errors.New("scm connection is referenced by a project")

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
		UpdatedAt:     connection.UpdatedAt,
		ID:            connection.ID,
	})
	if err != nil {
		return false, fmt.Errorf("update SCM connection %s: %w", connection.ID, err)
	}
	return rows > 0, nil
}

// DeleteSCMConnection deletes an unreferenced connection and reports whether it existed.
func (s *Store) DeleteSCMConnection(ctx context.Context, id string) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	references, err := s.qw.CountProjectsReferencingSCMConnection(ctx, sql.NullString{String: id, Valid: true})
	if err != nil {
		return false, fmt.Errorf("check SCM connection %s references: %w", id, err)
	}
	if references > 0 {
		return false, ErrSCMConnectionReferenced
	}
	rows, err := s.qw.DeleteSCMConnection(ctx, id)
	if err != nil {
		return false, fmt.Errorf("delete SCM connection %s: %w", id, err)
	}
	return rows > 0, nil
}

func createSCMConnectionParams(connection domain.SCMConnection) gen.CreateSCMConnectionParams {
	return gen.CreateSCMConnectionParams{
		ID:            connection.ID,
		Provider:      string(connection.Provider),
		DisplayName:   connection.DisplayName,
		WebBaseURL:    connection.WebBaseURL,
		APIBaseURL:    connection.APIBaseURL,
		CredentialRef: connection.CredentialRef,
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
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
	}
}
