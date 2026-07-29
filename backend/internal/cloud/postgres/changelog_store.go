//nolint:revive // Store methods satisfy existing service interfaces; interface docs live at call sites.
package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
)

func (s *Store) EventsAfter(ctx context.Context, after int64, limit int) ([]cdc.Event, error) {
	if limit <= 0 {
		limit = 512
	}
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT seq, org_id, project_id, session_id, event_type, payload, created_at
FROM change_log
WHERE org_id = $1 AND seq > $2
ORDER BY seq
LIMIT $3
`, orgID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("read change_log: %w", err)
	}
	return scanChangeLogRows(rows)
}

func (s *Store) LatestSeq(ctx context.Context) (int64, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return 0, err
	}
	var seq int64
	err = s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) FROM change_log WHERE org_id = $1`, orgID).Scan(&seq)
	if err != nil {
		return 0, fmt.Errorf("max change_log seq: %w", err)
	}
	return seq, nil
}

// AdminChangeLogSource returns the explicitly global CDC source used only by
// the process-local broadcaster poller. Client replay stays tenant-scoped via
// Store.EventsAfter.
func (s *Store) AdminChangeLogSource() cdc.Source {
	return adminChangeLogSource{store: s}
}

type adminChangeLogSource struct {
	store *Store
}

func (s adminChangeLogSource) EventsAfter(ctx context.Context, after int64, limit int) ([]cdc.Event, error) {
	if limit <= 0 {
		limit = 512
	}
	rows, err := s.store.db.QueryContext(ctx, `
SELECT seq, org_id, project_id, session_id, event_type, payload, created_at
FROM change_log
WHERE seq > $1
ORDER BY seq
LIMIT $2
`, after, limit)
	if err != nil {
		return nil, fmt.Errorf("read admin change_log: %w", err)
	}
	return scanChangeLogRows(rows)
}

func (s adminChangeLogSource) LatestSeq(ctx context.Context) (int64, error) {
	var seq int64
	if err := s.store.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) FROM change_log`).Scan(&seq); err != nil {
		return 0, fmt.Errorf("max admin change_log seq: %w", err)
	}
	return seq, nil
}

func scanChangeLogRows(rows *sql.Rows) ([]cdc.Event, error) {
	defer func() { _ = rows.Close() }()
	var out []cdc.Event
	for rows.Next() {
		var e cdc.Event
		var sessionID *string
		var payload []byte
		if err := rows.Scan(&e.Seq, &e.OrgID, &e.ProjectID, &sessionID, &e.Type, &payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		if sessionID != nil {
			e.SessionID = *sessionID
		}
		e.Payload = json.RawMessage(payload)
		out = append(out, e)
	}
	return out, rows.Err()
}
