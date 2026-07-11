package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	moderncsqlite "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

var _ notificationsvc.Store = (*Store)(nil)

// CreateNotification inserts one unread notification. It returns created=false
// when the unread dedupe index already has a matching row.
func (s *Store) CreateNotification(ctx context.Context, rec domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	if err := rec.Validate(); err != nil {
		return domain.NotificationRecord{}, false, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if existing, ok, err := s.getUnreadNotificationByDedupe(ctx, rec); err != nil {
		return domain.NotificationRecord{}, false, err
	} else if ok {
		return existing, false, nil
	}
	row, err := s.qw.CreateNotification(ctx, gen.CreateNotificationParams{
		ID:           rec.ID,
		SessionID:    rec.SessionID,
		ProjectID:    rec.ProjectID,
		PRURL:        rec.PRURL,
		Type:         rec.Type,
		Title:        rec.Title,
		Body:         rec.Body,
		Sensitive:    rec.Sensitive,
		ChangedPaths: encodeNotificationPaths(rec.ChangedPaths),
		HeadSha:      rec.HeadSHA,
		Status:       rec.Status,
		CreatedAt:    rec.CreatedAt,
	})
	if err != nil {
		if isSQLiteUnique(err) {
			if existing, ok, lookupErr := s.getUnreadNotificationByDedupe(ctx, rec); lookupErr != nil {
				return domain.NotificationRecord{}, false, lookupErr
			} else if ok {
				return existing, false, nil
			}
		}
		return domain.NotificationRecord{}, false, fmt.Errorf("create notification %s: %w", rec.ID, err)
	}
	return notificationFromGen(row), true, nil
}

// ListUnreadNotifications returns unread notifications newest-first.
func (s *Store) ListUnreadNotifications(ctx context.Context, limit int) ([]domain.NotificationRecord, error) {
	rows, err := s.qr.ListUnreadNotifications(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("list unread notifications: %w", err)
	}
	return notificationsFromGen(rows), nil
}

// MarkNotificationRead marks one unread notification read.
func (s *Store) MarkNotificationRead(ctx context.Context, id string) (domain.NotificationRecord, bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row, err := s.qw.MarkNotificationRead(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.NotificationRecord{}, false, nil
	}
	if err != nil {
		return domain.NotificationRecord{}, false, fmt.Errorf("mark notification read %s: %w", id, err)
	}
	return notificationFromGen(row), true, nil
}

// MarkAllNotificationsRead marks every unread notification read.
func (s *Store) MarkAllNotificationsRead(ctx context.Context) ([]domain.NotificationRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.MarkAllNotificationsRead(ctx)
	if err != nil {
		return nil, fmt.Errorf("mark all notifications read: %w", err)
	}
	return notificationsFromGen(rows), nil
}

func (s *Store) getUnreadNotificationByDedupe(ctx context.Context, rec domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	row, err := s.qw.GetUnreadNotificationByDedupe(ctx, gen.GetUnreadNotificationByDedupeParams{
		SessionID: rec.SessionID,
		Type:      rec.Type,
		PRURL:     rec.PRURL,
		Sensitive: rec.Sensitive,
		HeadSha:   rec.HeadSHA,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.NotificationRecord{}, false, nil
	}
	if err != nil {
		return domain.NotificationRecord{}, false, fmt.Errorf("lookup unread notification dedupe: %w", err)
	}
	return notificationFromGen(row), true, nil
}

func isSQLiteUnique(err error) bool {
	var sqliteErr *moderncsqlite.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE
}

func notificationFromGen(row gen.Notification) domain.NotificationRecord {
	return domain.NotificationRecord{
		ID:           row.ID,
		SessionID:    row.SessionID,
		ProjectID:    row.ProjectID,
		PRURL:        row.PRURL,
		Type:         row.Type,
		Title:        row.Title,
		Body:         row.Body,
		Sensitive:    row.Sensitive,
		ChangedPaths: decodeNotificationPaths(row.ChangedPaths),
		HeadSHA:      row.HeadSha,
		Status:       row.Status,
		CreatedAt:    row.CreatedAt,
	}
}

func encodeNotificationPaths(paths []string) string {
	if len(paths) == 0 {
		return "[]"
	}
	b, err := json.Marshal(paths)
	if err != nil {
		return "[]"
	}
	return string(b)
}

func decodeNotificationPaths(raw string) []string {
	var paths []string
	if err := json.Unmarshal([]byte(raw), &paths); err != nil {
		return nil
	}
	return paths
}

func notificationsFromGen(rows []gen.Notification) []domain.NotificationRecord {
	out := make([]domain.NotificationRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, notificationFromGen(row))
	}
	return out
}
