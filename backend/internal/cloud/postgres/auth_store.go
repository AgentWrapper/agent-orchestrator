//nolint:revive // Store methods satisfy existing service interfaces; interface docs live at call sites.
package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
)

// CreateOrg creates an organization and owner membership. It is used by auth
// onboarding and integration tests.
func (s *Store) CreateOrg(ctx context.Context, userID, name string, at time.Time) (auth.Org, error) {
	org := auth.Org{ID: uuid.NewString(), Name: name}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO orgs (id, name, created_by, created_at)
VALUES ($1, $2, $3, $4)
`, org.ID, org.Name, userID, at.UTC())
	if err != nil {
		return auth.Org{}, fmt.Errorf("create org: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO org_members (org_id, user_id, role, created_at)
VALUES ($1, $2, 'owner', $3)
ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
`, org.ID, userID, at.UTC())
	if err != nil {
		return auth.Org{}, fmt.Errorf("create owner membership: %w", err)
	}
	return org, nil
}

func (s *Store) UpsertGoogleUser(ctx context.Context, profile auth.GoogleProfile) (auth.User, []auth.Org, error) {
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return auth.User{}, nil, err
	}
	defer func() { _ = tx.Rollback() }()

	user := auth.User{ID: uuid.NewString(), Email: profile.Email}
	err = tx.QueryRowContext(ctx, `
INSERT INTO users (id, google_subject, email, display_name, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $5)
ON CONFLICT (google_subject) DO UPDATE
SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
RETURNING id, email
`, user.ID, profile.Subject, profile.Email, profile.DisplayName, now).Scan(&user.ID, &user.Email)
	if err != nil {
		return auth.User{}, nil, fmt.Errorf("upsert google user: %w", err)
	}
	orgs, err := listUserOrgs(ctx, tx, user.ID)
	if err != nil {
		return auth.User{}, nil, err
	}
	if len(orgs) == 0 {
		org := auth.Org{ID: uuid.NewString(), Name: defaultOrgName(profile)}
		if _, err := tx.ExecContext(ctx, `INSERT INTO orgs (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)`, org.ID, org.Name, user.ID, now); err != nil {
			return auth.User{}, nil, fmt.Errorf("create default org: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)`, org.ID, user.ID, now); err != nil {
			return auth.User{}, nil, fmt.Errorf("create default org membership: %w", err)
		}
		orgs = []auth.Org{org}
	}
	if err := tx.Commit(); err != nil {
		return auth.User{}, nil, err
	}
	return user, orgs, nil
}

func defaultOrgName(profile auth.GoogleProfile) string {
	if profile.DisplayName != "" {
		return profile.DisplayName
	}
	if profile.Email != "" {
		return profile.Email
	}
	return "Personal"
}

func (s *Store) StoreRefreshToken(ctx context.Context, token auth.APIToken) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO api_tokens (id, user_id, token_hash, kind, expires_at, created_at)
VALUES ($1, $2, $3, $4, $5, $6)
`, token.ID, token.UserID, token.TokenHash, token.Kind, nullTime(token.ExpiresAt), token.CreatedAt.UTC())
	if err != nil {
		return fmt.Errorf("store refresh token: %w", err)
	}
	return nil
}

func (s *Store) ConsumeRefreshToken(ctx context.Context, tokenHash string, now time.Time) (auth.User, []auth.Org, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return auth.User{}, nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	var user auth.User
	err = tx.QueryRowContext(ctx, `
SELECT u.id, u.email
FROM api_tokens t
JOIN users u ON u.id = t.user_id
WHERE t.token_hash = $1 AND t.kind = 'refresh' AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > $2)
`, tokenHash, now.UTC()).Scan(&user.ID, &user.Email)
	if noRows(err) {
		return auth.User{}, nil, false, nil
	}
	if err != nil {
		return auth.User{}, nil, false, fmt.Errorf("consume refresh token: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE api_tokens SET revoked_at = $1 WHERE token_hash = $2`, now.UTC(), tokenHash); err != nil {
		return auth.User{}, nil, false, err
	}
	orgs, err := listUserOrgs(ctx, tx, user.ID)
	if err != nil {
		return auth.User{}, nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return auth.User{}, nil, false, err
	}
	return user, orgs, true, nil
}

func (s *Store) CreateDeviceCode(ctx context.Context, code auth.DeviceCode) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO devices (id, device_code_hash, user_code, client_name, expires_at, created_at)
VALUES ($1, $2, $3, $4, $5, $6)
`, code.ID, code.DeviceCodeHash, code.UserCode, code.ClientName, code.ExpiresAt.UTC(), code.CreatedAt.UTC())
	if err != nil {
		return fmt.Errorf("create device code: %w", err)
	}
	return nil
}

func (s *Store) ApproveDeviceCode(ctx context.Context, userID, userCode string, now time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
UPDATE devices
SET approved_user_id = $1, approved_at = $2
WHERE user_code = $3 AND consumed_at IS NULL AND expires_at > $2
`, userID, now.UTC(), userCode)
	if err != nil {
		return false, fmt.Errorf("approve device code: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) PollDeviceCode(ctx context.Context, deviceCodeHash string, now time.Time) (auth.DeviceCode, auth.User, []auth.Org, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return auth.DeviceCode{}, auth.User{}, nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	var code auth.DeviceCode
	var approvedAt, consumedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `
SELECT id, device_code_hash, user_code, client_name, approved_user_id, approved_at, consumed_at, expires_at, created_at
FROM devices
WHERE device_code_hash = $1 AND expires_at > $2 AND consumed_at IS NULL
`, deviceCodeHash, now.UTC()).Scan(&code.ID, &code.DeviceCodeHash, &code.UserCode, &code.ClientName, &code.ApprovedUserID, &approvedAt, &consumedAt, &code.ExpiresAt, &code.CreatedAt)
	if noRows(err) {
		return auth.DeviceCode{}, auth.User{}, nil, false, nil
	}
	if err != nil {
		return auth.DeviceCode{}, auth.User{}, nil, false, fmt.Errorf("poll device code: %w", err)
	}
	if approvedAt.Valid {
		code.ApprovedAt = approvedAt.Time
	}
	if consumedAt.Valid {
		code.ConsumedAt = consumedAt.Time
	}
	if code.ApprovedUserID == "" {
		return code, auth.User{}, nil, false, nil
	}
	var user auth.User
	if err := tx.QueryRowContext(ctx, `SELECT id, email FROM users WHERE id = $1`, code.ApprovedUserID).Scan(&user.ID, &user.Email); err != nil {
		return auth.DeviceCode{}, auth.User{}, nil, false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE devices SET consumed_at = $1 WHERE id = $2`, now.UTC(), code.ID); err != nil {
		return auth.DeviceCode{}, auth.User{}, nil, false, err
	}
	orgs, err := listUserOrgs(ctx, tx, user.ID)
	if err != nil {
		return auth.DeviceCode{}, auth.User{}, nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return auth.DeviceCode{}, auth.User{}, nil, false, err
	}
	return code, user, orgs, true, nil
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func listUserOrgs(ctx context.Context, q queryer, userID string) ([]auth.Org, error) {
	rows, err := q.QueryContext(ctx, `
SELECT o.id, o.name
FROM orgs o
JOIN org_members m ON m.org_id = o.id
WHERE m.user_id = $1
ORDER BY o.created_at, o.id
`, userID)
	if err != nil {
		return nil, fmt.Errorf("list user orgs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []auth.Org
	for rows.Next() {
		var org auth.Org
		if err := rows.Scan(&org.ID, &org.Name); err != nil {
			return nil, err
		}
		out = append(out, org)
	}
	return out, rows.Err()
}
