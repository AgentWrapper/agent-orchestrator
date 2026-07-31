package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// GetAppSetting returns the stored value for a global app-setting key, or ""
// when no row exists. Absence is not an error: callers treat a missing key as
// "unset" and apply their own default.
func (s *Store) GetAppSetting(ctx context.Context, key string) (string, error) {
	v, err := s.qr.GetAppSetting(ctx, key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return v, nil
}

// SetAppSetting upserts a global app-setting (last write wins). writeMu
// serialises it with the store's other single-writer paths.
func (s *Store) SetAppSetting(ctx context.Context, key, value string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.SetAppSetting(ctx, gen.SetAppSettingParams{Key: key, Value: value})
}
