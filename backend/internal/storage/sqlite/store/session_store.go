package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// ---- sessions ----

// CreateSession assigns the per-project identity ("{project}-{num}") and inserts
// the record, returning it with ID populated. The next-num read and the insert
// run on the writer connection under writeMu, so two concurrent creates in the
// same project can't collide on num.
func (s *Store) CreateSession(ctx context.Context, rec domain.SessionRecord) (domain.SessionRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	num, err := s.qw.NextSessionNum(ctx, rec.ProjectID)
	if err != nil {
		return domain.SessionRecord{}, fmt.Errorf("next session num for %s: %w", rec.ProjectID, err)
	}
	rec.ID = domain.SessionID(fmt.Sprintf("%s-%d", rec.ProjectID, num))
	if err := s.qw.InsertSession(ctx, recordToInsert(rec, num)); err != nil {
		return domain.SessionRecord{}, fmt.Errorf("insert session %s: %w", rec.ID, err)
	}
	return rec, nil
}

// ReserveSpawn allocates a stable session identity without emitting a session row.
func (s *Store) ReserveSpawn(ctx context.Context, projectID domain.ProjectID, requestID, generation string, now time.Time) (domain.SpawnReservation, bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var reservation domain.SpawnReservation
	existing := false
	err := s.inTx(ctx, "reserve spawn", func(q *gen.Queries) error {
		row, err := q.GetSpawnReservationByRequestID(ctx, gen.GetSpawnReservationByRequestIDParams{ProjectID: string(projectID), RequestID: requestID})
		if err == nil {
			reservation = domain.SpawnReservation{RequestID: row.RequestID, Generation: row.Generation, SessionID: domain.SessionID(row.SessionID), ProjectID: domain.ProjectID(row.ProjectID), Num: row.Num, CreatedAt: row.CreatedAt}
			existing = true
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		num, err := q.NextSpawnNum(ctx, gen.NextSpawnNumParams{ProjectID: projectID, ProjectID_2: string(projectID)})
		if err != nil {
			return err
		}
		reservation = domain.SpawnReservation{RequestID: requestID, Generation: generation, SessionID: domain.SessionID(fmt.Sprintf("%s-%d", projectID, num)), ProjectID: projectID, Num: num, CreatedAt: now}
		return q.InsertSpawnReservation(ctx, gen.InsertSpawnReservationParams{RequestID: requestID, Generation: generation, SessionID: string(reservation.SessionID), ProjectID: string(projectID), Num: num, CreatedAt: now})
	})
	return reservation, existing, err
}

// CommitSpawn atomically creates the visible session and commits its reservation.
func (s *Store) CommitSpawn(ctx context.Context, reservation domain.SpawnReservation, rec domain.SessionRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "commit spawn", func(q *gen.Queries) error {
		if err := q.InsertSession(ctx, recordToInsert(rec, reservation.Num)); err != nil {
			return err
		}
		rows, err := q.MarkSpawnReservationCommitted(ctx, reservation.Generation)
		if err != nil {
			return err
		}
		if rows != 1 {
			return errors.New("spawn reservation generation mismatch")
		}
		return nil
	})
}

// RollbackSpawnReservation releases identity reserved by a failed attempt.
func (s *Store) RollbackSpawnReservation(ctx context.Context, generation string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.DeleteSpawnReservation(ctx, generation)
	if err != nil {
		return err
	}
	if rows != 1 {
		return errors.New("spawn reservation not found or already committed")
	}
	return nil
}

// RollbackCommittedSpawn removes a just-committed spawn whose final prompt
// delivery failed before Spawn returned success.
func (s *Store) RollbackCommittedSpawn(ctx context.Context, generation string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "rollback committed spawn", func(q *gen.Queries) error {
		rows, err := q.DeleteCommittedSpawnSession(ctx, generation)
		if err != nil {
			return err
		}
		if rows != 1 {
			return errors.New("committed spawn session not found")
		}
		rows, err = q.DeleteCommittedSpawnReservation(ctx, generation)
		if err != nil {
			return err
		}
		if rows != 1 {
			return errors.New("committed spawn reservation not found")
		}
		return nil
	})
}

// UpdateSession writes the full mutable state of an existing session. The
// id/project/num/created_at are immutable and not touched here.
func (s *Store) UpdateSession(ctx context.Context, rec domain.SessionRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.UpdateSession(ctx, recordToUpdate(rec))
}

// SetSessionExecutionProfile persists an initial/legacy-compatible profile
// without recording a human change event. Callers must do this before launch.
func (s *Store) SetSessionExecutionProfile(ctx context.Context, id domain.SessionID, profile domain.ExecutionProfile, observedHash string, updatedAt time.Time) error {
	if err := profile.Validate(); err != nil {
		return err
	}
	b, err := json.Marshal(profile)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err = s.qw.SetSessionExecutionProfile(ctx, gen.SetSessionExecutionProfileParams{ID: id, ExecutionProfileJson: string(b), ObservedExecutionProfileHash: observedHash, UpdatedAt: updatedAt})
	return err
}

// ChangeSessionExecutionProfile atomically updates a profile and appends the
// human-authorized audit row. Authorization is validated again at this durable
// boundary so callers cannot bypass it by constructing a change directly.
func (s *Store) ChangeSessionExecutionProfile(ctx context.Context, change domain.ExecutionProfileChange) error {
	authorized, err := domain.AuthorizeExecutionProfileChange(change.SessionID, change.OldProfile, change.NewProfile, change.Authority, change.Reason, change.ChangedAt)
	if err != nil {
		return err
	}
	oldJSON, _ := json.Marshal(authorized.OldProfile)
	newJSON, _ := json.Marshal(authorized.NewProfile)
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "change execution profile", func(q *gen.Queries) error {
		current, err := q.GetSession(ctx, authorized.SessionID)
		if err != nil {
			return err
		}
		if current.ExecutionProfileJson != string(oldJSON) {
			return domain.ErrExecutionProfileDrift
		}
		if _, err := q.SetSessionExecutionProfile(ctx, gen.SetSessionExecutionProfileParams{ID: authorized.SessionID, ExecutionProfileJson: string(newJSON), ObservedExecutionProfileHash: "", UpdatedAt: authorized.ChangedAt}); err != nil {
			return err
		}
		return q.InsertSessionExecutionProfileChange(ctx, gen.InsertSessionExecutionProfileChangeParams{SessionID: string(authorized.SessionID), OldProfileJson: string(oldJSON), NewProfileJson: string(newJSON), Authority: authorized.Authority, Reason: authorized.Reason, ChangedAt: authorized.ChangedAt})
	})
}

// ListSessionExecutionProfileChanges returns newest-first durable audit rows.
func (s *Store) ListSessionExecutionProfileChanges(ctx context.Context, id domain.SessionID) ([]domain.ExecutionProfileChange, error) {
	rows, err := s.qr.ListSessionExecutionProfileChanges(ctx, string(id))
	if err != nil {
		return nil, err
	}
	out := make([]domain.ExecutionProfileChange, 0, len(rows))
	for _, row := range rows {
		var oldProfile, newProfile domain.ExecutionProfile
		if err := json.Unmarshal([]byte(row.OldProfileJson), &oldProfile); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(row.NewProfileJson), &newProfile); err != nil {
			return nil, err
		}
		out = append(out, domain.ExecutionProfileChange{SessionID: domain.SessionID(row.SessionID), OldProfile: oldProfile, NewProfile: newProfile, Authority: row.Authority, Reason: row.Reason, ChangedAt: row.ChangedAt})
	}
	return out, nil
}

// RenameSession updates only the user-facing display name for an existing
// session. It returns ok=false when the session id does not exist.
func (s *Store) RenameSession(ctx context.Context, id domain.SessionID, displayName string, updatedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.RenameSession(ctx, gen.RenameSessionParams{
		ID:          id,
		DisplayName: displayName,
		UpdatedAt:   updatedAt,
	})
	if err != nil {
		return false, fmt.Errorf("rename session %s: %w", id, err)
	}
	return rows > 0, nil
}

// SetSessionPreviewURL updates only the browser preview URL for an existing
// session. It returns ok=false when the session id does not exist. The
// sessions_cdc_update trigger fans out a session_updated CDC event when the
// preview URL actually changes.
func (s *Store) SetSessionPreviewURL(ctx context.Context, id domain.SessionID, previewURL string, updatedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.SetSessionPreviewURL(ctx, gen.SetSessionPreviewURLParams{
		ID:         id,
		PreviewURL: previewURL,
		UpdatedAt:  updatedAt,
	})
	if err != nil {
		return false, fmt.Errorf("set preview url for session %s: %w", id, err)
	}
	return rows > 0, nil
}

// DeleteSession removes a session row, but only if it is still in seed state
// (no workspace, no runtime handle, no agent session id, no prompt, and not
// already terminated). Rows that have observable spawn output are immutable
// to preserve the no-resurrection guarantee — for those, callers fall back to
// MarkTerminated (lifecycle.Manager) instead.
//
// The deletion runs in a transaction. It first probes seed state with
// SessionIsSeed; only if that returns true does it clear the session's
// change_log rows (required because change_log FKs sessions(id) without
// ON DELETE CASCADE) and then delete the session row. For live or absent
// sessions the transaction commits with no rows touched — critically, the
// session_created / session_updated CDC events for live sessions are NOT
// destroyed when callers (e.g. RollbackSpawn's delete-then-kill fallback)
// invoke DeleteSession on a fully-spawned row.
//
// Returns deleted=true when a seed row was removed; deleted=false when the
// session id did not match a seed row (either it never existed, or it had
// already progressed past seed state). The latter case is benign — the caller
// should fall back to MarkTerminated.
func (s *Store) DeleteSession(ctx context.Context, id domain.SessionID) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin delete seed session: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	q := s.qw.WithTx(tx)

	isSeed, err := q.SessionIsSeed(ctx, id)
	if err != nil {
		return false, fmt.Errorf("delete seed session: probe seed state for %s: %w", id, err)
	}
	if !isSeed {
		// Commit the empty tx so we don't leak a transaction. Critically, do
		// NOT touch change_log here — for a live session that contains real
		// session_created / session_updated CDC events.
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("delete seed session: commit no-op: %w", err)
		}
		return false, nil
	}

	// Drop change_log rows for this session id first so the FK doesn't reject
	// the session DELETE. We do not touch project-level events (session_id IS
	// NULL) — those belong to the project, not this session. Both this DELETE
	// and the session DELETE below run via raw ExecContext to sidestep sqlc
	// 1.31's SQLite-parser bug, which strips trailing `?` placeholders and
	// string literals from DELETE statements (see queries/changelog.sql and
	// queries/sessions.sql for the documented workaround context).
	if _, err := tx.ExecContext(ctx, `DELETE FROM change_log WHERE session_id = ?`, id); err != nil {
		return false, fmt.Errorf("delete seed session: clear change log for %s: %w", id, err)
	}
	res, err := tx.ExecContext(ctx, `
DELETE FROM sessions
WHERE id = ?
  AND is_terminated = 0
  AND workspace_path = ''
  AND runtime_handle_id = ''
  AND agent_session_id = ''
  AND prompt = ''`, id)
	if err != nil {
		return false, fmt.Errorf("delete seed session %s: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete seed session %s: rows affected: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("delete seed session: commit: %w", err)
	}
	return n > 0, nil
}

// GetSession returns the full record for a session, or ok=false if absent.
func (s *Store) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	row, err := s.qr.GetSession(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.SessionRecord{}, false, nil
	}
	if err != nil {
		return domain.SessionRecord{}, false, fmt.Errorf("get session %s: %w", id, err)
	}
	return rowToRecord(row), true, nil
}

// ListSessions returns every session in a project, ordered by num.
func (s *Store) ListSessions(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error) {
	rows, err := s.qr.ListSessionsByProject(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("list sessions for %s: %w", project, err)
	}
	return mapSessionRows(rows), nil
}

// ListAllSessions returns every session across all projects.
func (s *Store) ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error) {
	rows, err := s.qr.ListAllSessions(ctx)
	if err != nil {
		return nil, fmt.Errorf("list all sessions: %w", err)
	}
	return mapSessionRows(rows), nil
}

func mapSessionRows(rows []gen.Session) []domain.SessionRecord {
	out := make([]domain.SessionRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, rowToRecord(r))
	}
	return out
}

func rowToRecord(row gen.Session) domain.SessionRecord {
	var profile domain.ExecutionProfile
	if row.ExecutionProfileJson != "" {
		_ = json.Unmarshal([]byte(row.ExecutionProfileJson), &profile)
	}
	return domain.SessionRecord{
		ID:          row.ID,
		ProjectID:   row.ProjectID,
		IssueID:     row.IssueID,
		Kind:        row.Kind,
		Harness:     row.Harness,
		DisplayName: row.DisplayName,
		Activity: domain.Activity{
			State:          row.ActivityState,
			LastActivityAt: row.ActivityLastAt,
		},
		FirstSignalAt: nullTimeToTime(row.FirstSignalAt),
		IsTerminated:  row.IsTerminated,
		Metadata: domain.SessionMetadata{
			Generation:                   row.Generation,
			SpawnState:                   domain.SpawnState(row.SpawnState),
			Branch:                       row.Branch,
			WorkspacePath:                row.WorkspacePath,
			RuntimeHandleID:              row.RuntimeHandleID,
			AgentSessionID:               row.AgentSessionID,
			Prompt:                       row.Prompt,
			PreviewURL:                   row.PreviewURL,
			PreviewRevision:              row.PreviewRevision,
			CapabilityClass:              row.CapabilityClass,
			ExecutionProfile:             profile,
			ObservedExecutionProfileHash: row.ObservedExecutionProfileHash,
		},
		CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt,
	}
}

func recordToInsert(rec domain.SessionRecord, num int64) gen.InsertSessionParams {
	activity := normalActivity(rec.Activity, rec.CreatedAt)
	return gen.InsertSessionParams{
		ID:                           rec.ID,
		ProjectID:                    rec.ProjectID,
		Num:                          num,
		IssueID:                      rec.IssueID,
		Kind:                         rec.Kind,
		Harness:                      rec.Harness,
		DisplayName:                  rec.DisplayName,
		ActivityState:                activity.State,
		ActivityLastAt:               activity.LastActivityAt,
		FirstSignalAt:                timeToNullTime(rec.FirstSignalAt),
		IsTerminated:                 rec.IsTerminated,
		Branch:                       rec.Metadata.Branch,
		WorkspacePath:                rec.Metadata.WorkspacePath,
		RuntimeHandleID:              rec.Metadata.RuntimeHandleID,
		AgentSessionID:               rec.Metadata.AgentSessionID,
		Prompt:                       rec.Metadata.Prompt,
		PreviewURL:                   rec.Metadata.PreviewURL,
		PreviewRevision:              rec.Metadata.PreviewRevision,
		CapabilityClass:              rec.Metadata.CapabilityClass,
		ExecutionProfileJson:         marshalExecutionProfile(rec.Metadata.ExecutionProfile),
		ObservedExecutionProfileHash: rec.Metadata.ObservedExecutionProfileHash,
		Generation:                   rec.Metadata.Generation,
		SpawnState:                   string(rec.Metadata.SpawnState),
		CreatedAt:                    rec.CreatedAt,
		UpdatedAt:                    rec.UpdatedAt,
	}
}

func recordToUpdate(rec domain.SessionRecord) gen.UpdateSessionParams {
	activity := normalActivity(rec.Activity, rec.UpdatedAt)
	return gen.UpdateSessionParams{
		ID:                           rec.ID,
		IssueID:                      rec.IssueID,
		Kind:                         rec.Kind,
		Harness:                      rec.Harness,
		DisplayName:                  rec.DisplayName,
		ActivityState:                activity.State,
		ActivityLastAt:               activity.LastActivityAt,
		FirstSignalAt:                timeToNullTime(rec.FirstSignalAt),
		IsTerminated:                 rec.IsTerminated,
		Branch:                       rec.Metadata.Branch,
		WorkspacePath:                rec.Metadata.WorkspacePath,
		RuntimeHandleID:              rec.Metadata.RuntimeHandleID,
		AgentSessionID:               rec.Metadata.AgentSessionID,
		Prompt:                       rec.Metadata.Prompt,
		PreviewURL:                   rec.Metadata.PreviewURL,
		PreviewRevision:              rec.Metadata.PreviewRevision,
		CapabilityClass:              rec.Metadata.CapabilityClass,
		ObservedExecutionProfileHash: rec.Metadata.ObservedExecutionProfileHash,
		UpdatedAt:                    rec.UpdatedAt,
	}
}

func marshalExecutionProfile(profile domain.ExecutionProfile) string {
	if profile.IsZero() {
		return ""
	}
	b, _ := json.Marshal(profile)
	return string(b)
}

// nullTimeToTime / timeToNullTime bridge the nullable first_signal_at column
// to the domain's zero-time convention (zero = no signal received yet).
func nullTimeToTime(t sql.NullTime) time.Time {
	if !t.Valid {
		return time.Time{}
	}
	return t.Time
}

func timeToNullTime(t time.Time) sql.NullTime {
	if t.IsZero() {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t, Valid: true}
}

func normalActivity(a domain.Activity, fallback time.Time) domain.Activity {
	if a.State == "" {
		a.State = domain.ActivityIdle
	}
	if a.LastActivityAt.IsZero() {
		a.LastActivityAt = fallback
	}
	if a.LastActivityAt.IsZero() {
		a.LastActivityAt = time.Now().UTC()
	}
	return a
}
