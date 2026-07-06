package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
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

// UpdateSession writes the full mutable state of an existing session. The
// id/project/num/created_at are immutable and not touched here.
func (s *Store) UpdateSession(ctx context.Context, rec domain.SessionRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.UpdateSession(ctx, recordToUpdate(rec))
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
	return rowToRecord(getSessionRow(row)), true, nil
}

// ListSessions returns every session in a project, ordered by num.
func (s *Store) ListSessions(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error) {
	rows, err := s.qr.ListSessionsByProject(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("list sessions for %s: %w", project, err)
	}
	out := make([]domain.SessionRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, rowToRecord(listSessionsByProjectRow(row)))
	}
	return out, nil
}

// ListAllSessions returns every session across all projects.
func (s *Store) ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error) {
	rows, err := s.qr.ListAllSessions(ctx)
	if err != nil {
		return nil, fmt.Errorf("list all sessions: %w", err)
	}
	out := make([]domain.SessionRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, rowToRecord(listAllSessionsRow(row)))
	}
	return out, nil
}

type sessionRow struct {
	ID                domain.SessionID
	ProjectID         domain.ProjectID
	IssueID           domain.IssueID
	Kind              domain.SessionKind
	Harness           domain.AgentHarness
	DisplayName       string
	ActivityState     domain.ActivityState
	ActivityLastAt    time.Time
	FirstSignalAt     sql.NullTime
	IsTerminated      bool
	Branch            string
	WorkspacePath     string
	RuntimeHandleID   string
	AgentSessionID    string
	Prompt            string
	Model             string
	PreviewURL        string
	PreviewRevision   int64
	LaunchedHarnesses string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

func getSessionRow(row gen.GetSessionRow) sessionRow {
	return sessionRow{
		ID:                row.ID,
		ProjectID:         row.ProjectID,
		IssueID:           row.IssueID,
		Kind:              row.Kind,
		Harness:           row.Harness,
		DisplayName:       row.DisplayName,
		ActivityState:     row.ActivityState,
		ActivityLastAt:    row.ActivityLastAt,
		FirstSignalAt:     row.FirstSignalAt,
		IsTerminated:      row.IsTerminated,
		Branch:            row.Branch,
		WorkspacePath:     row.WorkspacePath,
		RuntimeHandleID:   row.RuntimeHandleID,
		AgentSessionID:    row.AgentSessionID,
		Prompt:            row.Prompt,
		Model:             row.Model,
		PreviewURL:        row.PreviewURL,
		PreviewRevision:   row.PreviewRevision,
		LaunchedHarnesses: row.LaunchedHarnesses,
		CreatedAt:         row.CreatedAt,
		UpdatedAt:         row.UpdatedAt,
	}
}

func listSessionsByProjectRow(row gen.ListSessionsByProjectRow) sessionRow {
	return sessionRow{
		ID:                row.ID,
		ProjectID:         row.ProjectID,
		IssueID:           row.IssueID,
		Kind:              row.Kind,
		Harness:           row.Harness,
		DisplayName:       row.DisplayName,
		ActivityState:     row.ActivityState,
		ActivityLastAt:    row.ActivityLastAt,
		FirstSignalAt:     row.FirstSignalAt,
		IsTerminated:      row.IsTerminated,
		Branch:            row.Branch,
		WorkspacePath:     row.WorkspacePath,
		RuntimeHandleID:   row.RuntimeHandleID,
		AgentSessionID:    row.AgentSessionID,
		Prompt:            row.Prompt,
		Model:             row.Model,
		PreviewURL:        row.PreviewURL,
		PreviewRevision:   row.PreviewRevision,
		LaunchedHarnesses: row.LaunchedHarnesses,
		CreatedAt:         row.CreatedAt,
		UpdatedAt:         row.UpdatedAt,
	}
}

func listAllSessionsRow(row gen.ListAllSessionsRow) sessionRow {
	return sessionRow{
		ID:                row.ID,
		ProjectID:         row.ProjectID,
		IssueID:           row.IssueID,
		Kind:              row.Kind,
		Harness:           row.Harness,
		DisplayName:       row.DisplayName,
		ActivityState:     row.ActivityState,
		ActivityLastAt:    row.ActivityLastAt,
		FirstSignalAt:     row.FirstSignalAt,
		IsTerminated:      row.IsTerminated,
		Branch:            row.Branch,
		WorkspacePath:     row.WorkspacePath,
		RuntimeHandleID:   row.RuntimeHandleID,
		AgentSessionID:    row.AgentSessionID,
		Prompt:            row.Prompt,
		Model:             row.Model,
		PreviewURL:        row.PreviewURL,
		PreviewRevision:   row.PreviewRevision,
		LaunchedHarnesses: row.LaunchedHarnesses,
		CreatedAt:         row.CreatedAt,
		UpdatedAt:         row.UpdatedAt,
	}
}

func rowToRecord(row sessionRow) domain.SessionRecord {
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
			Branch:            row.Branch,
			WorkspacePath:     row.WorkspacePath,
			RuntimeHandleID:   row.RuntimeHandleID,
			AgentSessionID:    row.AgentSessionID,
			Prompt:            row.Prompt,
			Model:             row.Model,
			PreviewURL:        row.PreviewURL,
			PreviewRevision:   row.PreviewRevision,
			LaunchedHarnesses: launchedHarnesses(row.LaunchedHarnesses),
			AgentSessionIDs:   launchedHarnessSessionIDs(row.LaunchedHarnesses, row.Harness, row.AgentSessionID),
		},
		CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt,
	}
}

func recordToInsert(rec domain.SessionRecord, num int64) gen.InsertSessionParams {
	activity := normalActivity(rec.Activity, rec.CreatedAt)
	return gen.InsertSessionParams{
		ID:                rec.ID,
		ProjectID:         rec.ProjectID,
		Num:               num,
		IssueID:           rec.IssueID,
		Kind:              rec.Kind,
		Harness:           rec.Harness,
		DisplayName:       rec.DisplayName,
		ActivityState:     activity.State,
		ActivityLastAt:    activity.LastActivityAt,
		FirstSignalAt:     timeToNullTime(rec.FirstSignalAt),
		IsTerminated:      rec.IsTerminated,
		Branch:            rec.Metadata.Branch,
		WorkspacePath:     rec.Metadata.WorkspacePath,
		RuntimeHandleID:   rec.Metadata.RuntimeHandleID,
		AgentSessionID:    rec.Metadata.AgentSessionID,
		Prompt:            rec.Metadata.Prompt,
		Model:             rec.Metadata.Model,
		PreviewURL:        rec.Metadata.PreviewURL,
		PreviewRevision:   rec.Metadata.PreviewRevision,
		LaunchedHarnesses: launchedHarnessPayload(rec.Metadata),
		CreatedAt:         rec.CreatedAt,
		UpdatedAt:         rec.UpdatedAt,
	}
}

func recordToUpdate(rec domain.SessionRecord) gen.UpdateSessionParams {
	activity := normalActivity(rec.Activity, rec.UpdatedAt)
	return gen.UpdateSessionParams{
		ID:                rec.ID,
		IssueID:           rec.IssueID,
		Kind:              rec.Kind,
		Harness:           rec.Harness,
		DisplayName:       rec.DisplayName,
		ActivityState:     activity.State,
		ActivityLastAt:    activity.LastActivityAt,
		FirstSignalAt:     timeToNullTime(rec.FirstSignalAt),
		IsTerminated:      rec.IsTerminated,
		Branch:            rec.Metadata.Branch,
		WorkspacePath:     rec.Metadata.WorkspacePath,
		RuntimeHandleID:   rec.Metadata.RuntimeHandleID,
		AgentSessionID:    rec.Metadata.AgentSessionID,
		Prompt:            rec.Metadata.Prompt,
		Model:             rec.Metadata.Model,
		PreviewURL:        rec.Metadata.PreviewURL,
		PreviewRevision:   rec.Metadata.PreviewRevision,
		LaunchedHarnesses: launchedHarnessPayload(rec.Metadata),
		UpdatedAt:         rec.UpdatedAt,
	}
}

type launchedHarnessesPayload struct {
	Harnesses       []domain.AgentHarness          `json:"harnesses,omitempty"`
	AgentSessionIDs map[domain.AgentHarness]string `json:"agentSessionIds,omitempty"`
}

// launchedHarnessPayload serialises the launched harness set and optional
// per-harness native resume ids into sessions.launched_harnesses. Older rows
// used a comma-separated list; launchedHarnesses still accepts that legacy form.
func launchedHarnessPayload(meta domain.SessionMetadata) string {
	ids := normalizedAgentSessionIDs(meta.AgentSessionIDs, meta.LaunchedHarnesses, "", "")
	if len(meta.LaunchedHarnesses) == 0 && len(ids) == 0 {
		return ""
	}
	if len(ids) == 0 {
		return harnessCSV(meta.LaunchedHarnesses)
	}
	data, err := json.Marshal(launchedHarnessesPayload{
		Harnesses:       normalizedHarnesses(meta.LaunchedHarnesses),
		AgentSessionIDs: ids,
	})
	if err != nil {
		return harnessCSV(meta.LaunchedHarnesses)
	}
	return string(data)
}

func harnessCSV(hs []domain.AgentHarness) string {
	hs = normalizedHarnesses(hs)
	parts := make([]string, 0, len(hs))
	for _, h := range hs {
		parts = append(parts, string(h))
	}
	return strings.Join(parts, ",")
}

func launchedHarnesses(s string) []domain.AgentHarness {
	if payload, ok := parseLaunchedHarnessesPayload(s); ok {
		return payload.Harnesses
	}
	return parseHarnessCSV(s)
}

func launchedHarnessSessionIDs(s string, current domain.AgentHarness, currentID string) map[domain.AgentHarness]string {
	payload, _ := parseLaunchedHarnessesPayload(s)
	launched := payload.Harnesses
	if launched == nil {
		launched = parseHarnessCSV(s)
	}
	return normalizedAgentSessionIDs(payload.AgentSessionIDs, launched, current, currentID)
}

func parseLaunchedHarnessesPayload(s string) (launchedHarnessesPayload, bool) {
	s = strings.TrimSpace(s)
	if s == "" || !strings.HasPrefix(s, "{") {
		return launchedHarnessesPayload{}, false
	}
	var payload launchedHarnessesPayload
	if err := json.Unmarshal([]byte(s), &payload); err != nil {
		return launchedHarnessesPayload{}, false
	}
	payload.Harnesses = normalizedHarnesses(payload.Harnesses)
	payload.AgentSessionIDs = normalizedAgentSessionIDs(payload.AgentSessionIDs, payload.Harnesses, "", "")
	return payload, true
}

func parseHarnessCSV(s string) []domain.AgentHarness {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]domain.AgentHarness, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, domain.AgentHarness(p))
		}
	}
	return normalizedHarnesses(out)
}

func normalizedHarnesses(hs []domain.AgentHarness) []domain.AgentHarness {
	if len(hs) == 0 {
		return nil
	}
	out := make([]domain.AgentHarness, 0, len(hs))
	seen := make(map[domain.AgentHarness]struct{}, len(hs))
	for _, h := range hs {
		h = domain.AgentHarness(strings.TrimSpace(string(h)))
		if h == "" {
			continue
		}
		if _, ok := seen[h]; ok {
			continue
		}
		seen[h] = struct{}{}
		out = append(out, h)
	}
	return out
}

func normalizedAgentSessionIDs(ids map[domain.AgentHarness]string, launched []domain.AgentHarness, current domain.AgentHarness, currentID string) map[domain.AgentHarness]string {
	out := make(map[domain.AgentHarness]string, len(ids)+1)
	for h, id := range ids {
		h = domain.AgentHarness(strings.TrimSpace(string(h)))
		id = strings.TrimSpace(id)
		if h != "" && id != "" {
			out[h] = id
		}
	}
	if current != "" && strings.TrimSpace(currentID) != "" {
		out[current] = strings.TrimSpace(currentID)
	}
	launchedSet := make(map[domain.AgentHarness]struct{}, len(launched)+1)
	for _, h := range launched {
		if h != "" {
			launchedSet[h] = struct{}{}
		}
	}
	if current != "" {
		launchedSet[current] = struct{}{}
	}
	for h := range out {
		if _, ok := launchedSet[h]; !ok {
			delete(out, h)
		}
	}
	if len(out) == 0 {
		return nil
	}
	keys := make([]string, 0, len(out))
	for h := range out {
		keys = append(keys, string(h))
	}
	sort.Strings(keys)
	stable := make(map[domain.AgentHarness]string, len(out))
	for _, k := range keys {
		h := domain.AgentHarness(k)
		stable[h] = out[h]
	}
	return stable
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
