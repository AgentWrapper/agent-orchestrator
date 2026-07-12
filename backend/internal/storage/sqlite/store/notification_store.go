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
// when a matching dedupe row already exists.
func (s *Store) CreateNotification(ctx context.Context, rec domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	rec = rec.WithInferredSubject()
	if err := rec.Validate(); err != nil {
		return domain.NotificationRecord{}, false, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if existing, ok, err := s.getPersistentNotificationByDedupe(ctx, rec); err != nil {
		return domain.NotificationRecord{}, false, err
	} else if ok {
		return existing, false, nil
	}
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
		SubjectKind:  string(rec.SubjectKind),
		SubjectID:    rec.SubjectID,
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
			if existing, ok, lookupErr := s.getPersistentNotificationByDedupe(ctx, rec); lookupErr != nil {
				return domain.NotificationRecord{}, false, lookupErr
			} else if ok {
				return existing, false, nil
			}
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

func (s *Store) getPersistentNotificationByDedupe(ctx context.Context, rec domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	if !notificationDedupeSurvivesRead(rec.Type) {
		return domain.NotificationRecord{}, false, nil
	}
	row, err := s.qw.GetWorkerTerminalNotificationByDedupe(ctx, gen.GetWorkerTerminalNotificationByDedupeParams{
		SubjectKind: string(rec.SubjectKind),
		SubjectID:   rec.SubjectID,
		Type:        rec.Type,
		Body:        rec.Body,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.NotificationRecord{}, false, nil
	}
	if err != nil {
		return domain.NotificationRecord{}, false, fmt.Errorf("lookup persistent notification dedupe: %w", err)
	}
	return notificationFromGen(row), true, nil
}

func notificationDedupeSurvivesRead(t domain.NotificationType) bool {
	switch t {
	case domain.NotificationWorkerDiedUnfinished, domain.NotificationWorkerRetryExhausted:
		return true
	default:
		return false
	}
}

// ListUnreadNotifications returns unread notifications newest-first.
func (s *Store) ListUnreadNotifications(ctx context.Context, filter notificationsvc.ListFilter) ([]domain.NotificationRecord, error) {
	if len(filter.Types) == 0 {
		rows, err := s.qr.ListUnreadNotifications(ctx, int64(filter.Limit))
		if err != nil {
			return nil, fmt.Errorf("list unread notifications: %w", err)
		}
		return notificationsFromGen(rows), nil
	}
	rows, err := s.queryUnreadNotificationsByTypes(ctx, filter.Types, filter.Limit)
	if err != nil {
		return nil, fmt.Errorf("list unread notifications: %w", err)
	}
	return rows, nil
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

// MarkAllNotificationsRead marks unread notification-center rows read. Types
// passed in excludeTypes stay unread because they represent durable
// operator-attention conditions, not merely delivery-center unread state.
func (s *Store) MarkAllNotificationsRead(ctx context.Context, excludeTypes []domain.NotificationType) ([]domain.NotificationRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if len(excludeTypes) > 0 {
		rows, err := s.markAllNotificationsReadExcludingTypes(ctx, excludeTypes)
		if err != nil {
			return nil, fmt.Errorf("mark all notifications read: %w", err)
		}
		return rows, nil
	}
	rows, err := s.qw.MarkAllNotificationsRead(ctx)
	if err != nil {
		return nil, fmt.Errorf("mark all notifications read: %w", err)
	}
	return notificationsFromGen(rows), nil
}

const notificationColumns = "id, session_id, project_id, pr_url, type, subject_kind, subject_id, title, body, status, created_at, sensitive, changed_paths, head_sha"

const listUnreadNotificationsByTypes = "SELECT " + notificationColumns + " FROM notifications WHERE status = 'unread' AND type IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT ?"

const markAllNotificationsReadExcludingTypesSQL = "UPDATE notifications SET status = 'read' WHERE status = 'unread' AND type NOT IN (SELECT value FROM json_each(?)) RETURNING " + notificationColumns

func (s *Store) queryUnreadNotificationsByTypes(ctx context.Context, types []domain.NotificationType, limit int) ([]domain.NotificationRecord, error) {
	rows, err := s.readDB.QueryContext(ctx, listUnreadNotificationsByTypes, encodeNotificationTypes(types), limit)
	if err != nil {
		return nil, err
	}
	return scanNotificationRows(rows)
}

func (s *Store) markAllNotificationsReadExcludingTypes(ctx context.Context, excludeTypes []domain.NotificationType) ([]domain.NotificationRecord, error) {
	rows, err := s.writeDB.QueryContext(ctx, markAllNotificationsReadExcludingTypesSQL, encodeNotificationTypes(excludeTypes))
	if err != nil {
		return nil, err
	}
	return scanNotificationRows(rows)
}

func scanNotificationRows(rows *sql.Rows) ([]domain.NotificationRecord, error) {
	out := make([]domain.NotificationRecord, 0)
	for rows.Next() {
		var row gen.Notification
		if err := rows.Scan(
			&row.ID,
			&row.SessionID,
			&row.ProjectID,
			&row.PRURL,
			&row.Type,
			&row.SubjectKind,
			&row.SubjectID,
			&row.Title,
			&row.Body,
			&row.Status,
			&row.CreatedAt,
			&row.Sensitive,
			&row.ChangedPaths,
			&row.HeadSha,
		); err != nil {
			return nil, err
		}
		out = append(out, notificationFromGen(row))
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func encodeNotificationTypes(types []domain.NotificationType) string {
	values := make([]string, 0, len(types))
	for _, notificationType := range types {
		values = append(values, string(notificationType))
	}
	b, err := json.Marshal(values)
	if err != nil {
		return "[]"
	}
	return string(b)
}

func (s *Store) getUnreadNotificationByDedupe(ctx context.Context, rec domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	row, err := s.qw.GetUnreadNotificationByDedupe(ctx, gen.GetUnreadNotificationByDedupeParams{
		SubjectKind: string(rec.SubjectKind),
		SubjectID:   rec.SubjectID,
		Type:        rec.Type,
		PRURL:       rec.PRURL,
		Sensitive:   rec.Sensitive,
		HeadSha:     rec.HeadSHA,
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
		SubjectKind:  domain.NotificationSubjectKind(row.SubjectKind),
		SubjectID:    row.SubjectID,
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
