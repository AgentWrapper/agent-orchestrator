package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	suggestionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/suggestion"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

var _ suggestionsvc.Store = (*Store)(nil)

func (s *Store) CreateSuggestion(ctx context.Context, rec domain.SuggestionRecord) (domain.SuggestionRecord, error) {
	if err := rec.Validate(); err != nil {
		return domain.SuggestionRecord{}, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row, err := s.qw.CreateSuggestion(ctx, gen.CreateSuggestionParams{
		ID: rec.ID, ProjectID: rec.ProjectID, Title: rec.Title, Note: rec.Note, Priority: rec.Priority,
		Status: rec.Status, SessionID: optionalSessionID(rec.SessionID), CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt,
	})
	if err != nil {
		return domain.SuggestionRecord{}, fmt.Errorf("create suggestion %s: %w", rec.ID, err)
	}
	return suggestionFromGen(row), nil
}

func (s *Store) ListSuggestions(ctx context.Context, projectID domain.ProjectID) ([]domain.SuggestionRecord, error) {
	rows, err := s.qr.ListSuggestions(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("list suggestions for %s: %w", projectID, err)
	}
	out := make([]domain.SuggestionRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, suggestionFromGen(row))
	}
	return out, nil
}

func (s *Store) GetSuggestion(ctx context.Context, projectID domain.ProjectID, id string) (domain.SuggestionRecord, bool, error) {
	row, err := s.qr.GetSuggestion(ctx, gen.GetSuggestionParams{ProjectID: projectID, ID: id})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.SuggestionRecord{}, false, nil
	}
	if err != nil {
		return domain.SuggestionRecord{}, false, fmt.Errorf("get suggestion %s: %w", id, err)
	}
	return suggestionFromGen(row), true, nil
}

func (s *Store) UpdateSuggestion(ctx context.Context, rec domain.SuggestionRecord) (domain.SuggestionRecord, bool, error) {
	if err := rec.Validate(); err != nil {
		return domain.SuggestionRecord{}, false, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row, err := s.qw.UpdateSuggestion(ctx, gen.UpdateSuggestionParams{
		Title: rec.Title, Note: rec.Note, Priority: rec.Priority, Status: rec.Status,
		SessionID: optionalSessionID(rec.SessionID), UpdatedAt: rec.UpdatedAt, ProjectID: rec.ProjectID, ID: rec.ID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.SuggestionRecord{}, false, nil
	}
	if err != nil {
		return domain.SuggestionRecord{}, false, fmt.Errorf("update suggestion %s: %w", rec.ID, err)
	}
	return suggestionFromGen(row), true, nil
}

func optionalSessionID(id domain.SessionID) *domain.SessionID {
	if id == "" {
		return nil
	}
	return &id
}

func suggestionFromGen(row gen.Suggestion) domain.SuggestionRecord {
	rec := domain.SuggestionRecord{
		ID: row.ID, ProjectID: row.ProjectID, Title: row.Title, Note: row.Note, Priority: row.Priority,
		Status: row.Status, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
	if row.SessionID != nil {
		rec.SessionID = *row.SessionID
	}
	return rec
}
