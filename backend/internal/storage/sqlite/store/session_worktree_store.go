package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// UpsertSessionWorktree records or updates one repo worktree for a session.
func (s *Store) UpsertSessionWorktree(ctx context.Context, row domain.SessionWorktreeRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	// An empty state means the caller is creating or updating a live worktree
	// row. Lifecycle paths set explicit states such as removed, unavailable, or
	// retry_remove.
	state := row.State
	if state == "" {
		state = "active"
	}
	return s.qw.UpsertSessionWorktree(ctx, gen.UpsertSessionWorktreeParams{
		SessionID:    row.SessionID,
		RepoName:     row.RepoName,
		Branch:       row.Branch,
		BaseSha:      row.BaseSHA,
		WorktreePath: row.WorktreePath,
		PreservedRef: row.PreservedRef,
		State:        state,
	})
}

// GetSessionWorktree returns one session worktree row.
func (s *Store) GetSessionWorktree(ctx context.Context, sessionID domain.SessionID, repoName string) (domain.SessionWorktreeRecord, bool, error) {
	row, err := s.qr.GetSessionWorktree(ctx, gen.GetSessionWorktreeParams{SessionID: sessionID, RepoName: repoName})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.SessionWorktreeRecord{}, false, nil
	}
	if err != nil {
		return domain.SessionWorktreeRecord{}, false, fmt.Errorf("get session worktree %s/%s: %w", sessionID, repoName, err)
	}
	return sessionWorktreeFromGen(row), true, nil
}

// ListSessionWorktrees returns every repo worktree for a session, root first.
func (s *Store) ListSessionWorktrees(ctx context.Context, sessionID domain.SessionID) ([]domain.SessionWorktreeRecord, error) {
	rows, err := s.qr.ListSessionWorktrees(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list session worktrees for %s: %w", sessionID, err)
	}
	out := make([]domain.SessionWorktreeRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, sessionWorktreeFromGen(row))
	}
	return out, nil
}

// DeleteSessionWorktrees deletes the per-repo worktree rows for a session.
func (s *Store) DeleteSessionWorktrees(ctx context.Context, sessionID domain.SessionID) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.DeleteSessionWorktrees(ctx, sessionID)
}

func sessionWorktreeFromGen(row gen.SessionWorktree) domain.SessionWorktreeRecord {
	return domain.SessionWorktreeRecord{
		SessionID:    row.SessionID,
		RepoName:     row.RepoName,
		Branch:       row.Branch,
		BaseSHA:      row.BaseSha,
		WorktreePath: row.WorktreePath,
		PreservedRef: row.PreservedRef,
		State:        row.State,
	}
}
