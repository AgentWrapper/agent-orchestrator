package store

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	shelltermsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

var _ shelltermsvc.Store = (*Store)(nil)

// InsertShellTerminal records a standalone shell terminal against an app run.
func (s *Store) InsertShellTerminal(ctx context.Context, rec shelltermsvc.ShellTerminalRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.qw.InsertShellTerminal(ctx, gen.InsertShellTerminalParams{
		HandleID:   rec.HandleID,
		ProjectID:  optionalProjectID(rec.ProjectID),
		WorkingDir: rec.WorkingDir,
		Title:      rec.Title,
		AppRunID:   rec.AppRunID,
		CreatedAt:  rec.CreatedAt,
	})
	if err != nil {
		return fmt.Errorf("insert shell terminal %s: %w", rec.HandleID, err)
	}
	return nil
}

// SelectShellTerminalsByAppRunID returns the shell terminals owned by one app
// run, oldest first so the UI renders tabs in the order they were opened.
func (s *Store) SelectShellTerminalsByAppRunID(ctx context.Context, appRunID string) ([]shelltermsvc.ShellTerminalRecord, error) {
	rows, err := s.qr.SelectShellTerminalsByAppRunID(ctx, appRunID)
	if err != nil {
		return nil, fmt.Errorf("select shell terminals for app run %s: %w", appRunID, err)
	}
	return shellTerminalsFromGen(rows), nil
}

// SelectShellTerminalsFromPreviousAppRuns returns shell terminals left behind
// by any app run other than the one given — the orphans the boot-time reaper
// destroys.
func (s *Store) SelectShellTerminalsFromPreviousAppRuns(ctx context.Context, appRunID string) ([]shelltermsvc.ShellTerminalRecord, error) {
	rows, err := s.qr.SelectShellTerminalsFromPreviousAppRuns(ctx, appRunID)
	if err != nil {
		return nil, fmt.Errorf("select orphaned shell terminals: %w", err)
	}
	return shellTerminalsFromGen(rows), nil
}

// DeleteShellTerminalByHandleID forgets one shell terminal, reporting whether a
// row actually existed so the caller can answer 404 for an unknown handle.
func (s *Store) DeleteShellTerminalByHandleID(ctx context.Context, handleID string) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	affected, err := s.qw.DeleteShellTerminalByHandleID(ctx, handleID)
	if err != nil {
		return false, fmt.Errorf("delete shell terminal %s: %w", handleID, err)
	}
	return affected > 0, nil
}

// DeleteShellTerminalsFromPreviousAppRuns clears every orphaned row in one
// statement and returns how many were removed.
func (s *Store) DeleteShellTerminalsFromPreviousAppRuns(ctx context.Context, appRunID string) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	affected, err := s.qw.DeleteShellTerminalsFromPreviousAppRuns(ctx, appRunID)
	if err != nil {
		return 0, fmt.Errorf("delete orphaned shell terminals: %w", err)
	}
	return affected, nil
}

// optionalProjectID maps the service's "no project" empty string onto the
// nullable column, so a project-less shell stores NULL rather than an empty
// string that would violate the projects FK.
func optionalProjectID(id domain.ProjectID) *domain.ProjectID {
	if id == "" {
		return nil
	}
	return &id
}

func shellTerminalFromGen(row gen.ShellTerminal) shelltermsvc.ShellTerminalRecord {
	rec := shelltermsvc.ShellTerminalRecord{
		HandleID:   row.HandleID,
		WorkingDir: row.WorkingDir,
		Title:      row.Title,
		AppRunID:   row.AppRunID,
		CreatedAt:  row.CreatedAt,
	}
	if row.ProjectID != nil {
		rec.ProjectID = *row.ProjectID
	}
	return rec
}

func shellTerminalsFromGen(rows []gen.ShellTerminal) []shelltermsvc.ShellTerminalRecord {
	out := make([]shelltermsvc.ShellTerminalRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, shellTerminalFromGen(row))
	}
	return out
}
