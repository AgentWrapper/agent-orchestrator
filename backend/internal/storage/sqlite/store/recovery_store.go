package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const recoveryIncidentColumns = "id, project_id, issue_id, fingerprint, status, rung, attempt, dead_session_id, last_session_id, terminal_failure_reason, failure_point, open_pr_url, fix_reference, last_failed_fix_reference, verification_session_id, diagnosis, created_at, updated_at, resolved_at"

// CreateRecoveryIncident inserts a new durable worker-death recovery incident.
func (s *Store) CreateRecoveryIncident(ctx context.Context, rec domain.RecoveryIncident) (domain.RecoveryIncident, error) {
	if err := rec.Validate(); err != nil {
		return domain.RecoveryIncident{}, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row := s.writeDB.QueryRowContext(ctx, "INSERT INTO recovery_incidents ("+recoveryIncidentColumns+") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING "+recoveryIncidentColumns,
		rec.ID,
		rec.ProjectID,
		rec.IssueID,
		rec.Fingerprint,
		rec.Status,
		rec.Rung,
		rec.Attempt,
		rec.DeadSessionID,
		rec.LastSessionID,
		rec.TerminalFailureReason,
		rec.FailurePoint,
		rec.OpenPRURL,
		rec.FixReference,
		rec.LastFailedFixReference,
		rec.VerificationSessionID,
		rec.Diagnosis,
		rec.CreatedAt.UTC(),
		rec.UpdatedAt.UTC(),
		nullTime(rec.ResolvedAt),
	)
	got, err := scanRecoveryIncident(row)
	if err != nil {
		return domain.RecoveryIncident{}, fmt.Errorf("create recovery incident %s: %w", rec.ID, err)
	}
	return got, nil
}

// UpdateRecoveryIncident replaces mutable recovery state for an existing
// incident.
func (s *Store) UpdateRecoveryIncident(ctx context.Context, rec domain.RecoveryIncident) (domain.RecoveryIncident, bool, error) {
	if err := rec.Validate(); err != nil {
		return domain.RecoveryIncident{}, false, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row := s.writeDB.QueryRowContext(ctx, "UPDATE recovery_incidents SET status = ?, rung = ?, attempt = ?, dead_session_id = ?, last_session_id = ?, terminal_failure_reason = ?, failure_point = ?, open_pr_url = ?, fix_reference = ?, last_failed_fix_reference = ?, verification_session_id = ?, diagnosis = ?, updated_at = ?, resolved_at = ? WHERE id = ? RETURNING "+recoveryIncidentColumns,
		rec.Status,
		rec.Rung,
		rec.Attempt,
		rec.DeadSessionID,
		rec.LastSessionID,
		rec.TerminalFailureReason,
		rec.FailurePoint,
		rec.OpenPRURL,
		rec.FixReference,
		rec.LastFailedFixReference,
		rec.VerificationSessionID,
		rec.Diagnosis,
		rec.UpdatedAt.UTC(),
		nullTime(rec.ResolvedAt),
		rec.ID,
	)
	got, err := scanRecoveryIncident(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.RecoveryIncident{}, false, nil
	}
	if err != nil {
		return domain.RecoveryIncident{}, false, fmt.Errorf("update recovery incident %s: %w", rec.ID, err)
	}
	return got, true, nil
}

// UpdateRecoveryIncidentIfUnchanged replaces mutable recovery state only when
// the row still matches the caller's read. It lets verification respawns roll
// back stale concurrent claims.
func (s *Store) UpdateRecoveryIncidentIfUnchanged(ctx context.Context, rec, expected domain.RecoveryIncident) (domain.RecoveryIncident, bool, error) {
	if err := rec.Validate(); err != nil {
		return domain.RecoveryIncident{}, false, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row := s.writeDB.QueryRowContext(ctx, "UPDATE recovery_incidents SET status = ?, rung = ?, attempt = ?, dead_session_id = ?, last_session_id = ?, terminal_failure_reason = ?, failure_point = ?, open_pr_url = ?, fix_reference = ?, last_failed_fix_reference = ?, verification_session_id = ?, diagnosis = ?, updated_at = ?, resolved_at = ? WHERE id = ? AND status = ? AND rung = ? AND attempt = ? AND dead_session_id = ? AND last_session_id = ? AND fix_reference = ? AND last_failed_fix_reference = ? AND verification_session_id = ? AND updated_at = ? RETURNING "+recoveryIncidentColumns,
		rec.Status,
		rec.Rung,
		rec.Attempt,
		rec.DeadSessionID,
		rec.LastSessionID,
		rec.TerminalFailureReason,
		rec.FailurePoint,
		rec.OpenPRURL,
		rec.FixReference,
		rec.LastFailedFixReference,
		rec.VerificationSessionID,
		rec.Diagnosis,
		rec.UpdatedAt.UTC(),
		nullTime(rec.ResolvedAt),
		rec.ID,
		expected.Status,
		expected.Rung,
		expected.Attempt,
		expected.DeadSessionID,
		expected.LastSessionID,
		expected.FixReference,
		expected.LastFailedFixReference,
		expected.VerificationSessionID,
		expected.UpdatedAt.UTC(),
	)
	got, err := scanRecoveryIncident(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.RecoveryIncident{}, false, nil
	}
	if err != nil {
		return domain.RecoveryIncident{}, false, fmt.Errorf("conditional update recovery incident %s: %w", rec.ID, err)
	}
	return got, true, nil
}

// GetUnresolvedRecoveryIncidentByFingerprint returns the active incident for a
// project/issue/fingerprint, if one exists.
func (s *Store) GetUnresolvedRecoveryIncidentByFingerprint(ctx context.Context, projectID domain.ProjectID, issueID domain.IssueID, fingerprint string) (domain.RecoveryIncident, bool, error) {
	row := s.readDB.QueryRowContext(ctx, "SELECT "+recoveryIncidentColumns+" FROM recovery_incidents WHERE project_id = ? AND issue_id = ? AND fingerprint = ? AND status != 'resolved' LIMIT 1", projectID, issueID, fingerprint)
	got, err := scanRecoveryIncident(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.RecoveryIncident{}, false, nil
	}
	if err != nil {
		return domain.RecoveryIncident{}, false, fmt.Errorf("get recovery incident by fingerprint: %w", err)
	}
	return got, true, nil
}

// GetRecoveryIncident returns a recovery incident by id.
func (s *Store) GetRecoveryIncident(ctx context.Context, id string) (domain.RecoveryIncident, bool, error) {
	row := s.readDB.QueryRowContext(ctx, "SELECT "+recoveryIncidentColumns+" FROM recovery_incidents WHERE id = ? LIMIT 1", id)
	got, err := scanRecoveryIncident(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.RecoveryIncident{}, false, nil
	}
	if err != nil {
		return domain.RecoveryIncident{}, false, fmt.Errorf("get recovery incident %s: %w", id, err)
	}
	return got, true, nil
}

// ListUnresolvedRecoveryIncidentsBySession returns unresolved incidents whose
// latest dead session or verification session matches the supplied session id.
func (s *Store) ListUnresolvedRecoveryIncidentsBySession(ctx context.Context, sessionID domain.SessionID) ([]domain.RecoveryIncident, error) {
	rows, err := s.readDB.QueryContext(ctx, "SELECT "+recoveryIncidentColumns+" FROM recovery_incidents WHERE (dead_session_id = ? OR verification_session_id = ?) AND status != 'resolved' ORDER BY updated_at DESC, id DESC", sessionID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list recovery incidents by session: %w", err)
	}
	return scanRecoveryIncidentRows(rows)
}

func scanRecoveryIncident(row interface{ Scan(dest ...any) error }) (domain.RecoveryIncident, error) {
	var rec domain.RecoveryIncident
	var resolved sql.NullTime
	if err := row.Scan(
		&rec.ID,
		&rec.ProjectID,
		&rec.IssueID,
		&rec.Fingerprint,
		&rec.Status,
		&rec.Rung,
		&rec.Attempt,
		&rec.DeadSessionID,
		&rec.LastSessionID,
		&rec.TerminalFailureReason,
		&rec.FailurePoint,
		&rec.OpenPRURL,
		&rec.FixReference,
		&rec.LastFailedFixReference,
		&rec.VerificationSessionID,
		&rec.Diagnosis,
		&rec.CreatedAt,
		&rec.UpdatedAt,
		&resolved,
	); err != nil {
		return domain.RecoveryIncident{}, err
	}
	if resolved.Valid {
		rec.ResolvedAt = resolved.Time
	}
	return rec, nil
}

func scanRecoveryIncidentRows(rows *sql.Rows) ([]domain.RecoveryIncident, error) {
	defer func() { _ = rows.Close() }()
	out := make([]domain.RecoveryIncident, 0)
	for rows.Next() {
		rec, err := scanRecoveryIncident(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
