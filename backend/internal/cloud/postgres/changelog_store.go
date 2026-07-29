//nolint:revive // Store methods satisfy existing service interfaces; interface docs live at call sites.
package postgres

import (
	"context"
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
