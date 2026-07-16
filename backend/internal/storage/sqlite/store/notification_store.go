package store

import (
	"context"
	"database/sql"
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
		ID:        rec.ID,
		SessionID: rec.SessionID,
		ProjectID: rec.ProjectID,
		PRURL:     rec.PRURL,
		Type:      rec.Type,
		Title:     rec.Title,
		Body:      rec.Body,
		Status:    rec.Status,
		CreatedAt: rec.CreatedAt,
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

// ListRecentNotifications returns recent notifications newest-first.
func (s *Store) ListRecentNotifications(ctx context.Context, limit int) ([]domain.NotificationRecord, error) {
	rows, err := s.readDB.QueryContext(ctx, `
SELECT id, session_id, project_id, pr_url, type, title, body, status, created_at
FROM notifications
ORDER BY created_at DESC
LIMIT ?
`, limit)
	if err != nil {
		return nil, fmt.Errorf("list recent notifications: %w", err)
	}
	out, err := scanNotificationRows(rows)
	if err != nil {
		return nil, fmt.Errorf("list recent notifications: %w", err)
	}
	return out, nil
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
		ID:        row.ID,
		SessionID: row.SessionID,
		ProjectID: row.ProjectID,
		PRURL:     row.PRURL,
		Type:      row.Type,
		Title:     row.Title,
		Body:      row.Body,
		Status:    row.Status,
		CreatedAt: row.CreatedAt,
	}
}

func notificationsFromGen(rows []gen.Notification) []domain.NotificationRecord {
	out := make([]domain.NotificationRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, notificationFromGen(row))
	}
	return out
}

func scanNotificationRows(rows *sql.Rows) (_ []domain.NotificationRecord, err error) {
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()
	out := []domain.NotificationRecord{}
	for rows.Next() {
		var rec domain.NotificationRecord
		if err := rows.Scan(
			&rec.ID,
			&rec.SessionID,
			&rec.ProjectID,
			&rec.PRURL,
			&rec.Type,
			&rec.Title,
			&rec.Body,
			&rec.Status,
			&rec.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
