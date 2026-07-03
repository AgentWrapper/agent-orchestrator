package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// UpsertCollision inserts or refreshes one ordered session-pair collision row.
// The caller is responsible for supplying SessionA < SessionB (the convergence
// observer canonicalises the pair before writing); the table CHECK enforces it.
func (s *Store) UpsertCollision(ctx context.Context, c domain.SessionCollision) error {
	files, err := json.Marshal(c.Files)
	if err != nil {
		return fmt.Errorf("marshal collision files for %s/%s: %w", c.SessionA, c.SessionB, err)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.UpsertCollision(ctx, gen.UpsertCollisionParams{
		ProjectID:   c.ProjectID,
		SessionA:    c.SessionA,
		SessionB:    c.SessionB,
		Severity:    c.Severity,
		Files:       string(files),
		Signature:   c.Signature,
		FirstSeenAt: c.FirstSeenAt,
		UpdatedAt:   c.UpdatedAt,
	})
}

// DeleteCollision removes one ordered session-pair row. It is a no-op when the
// pair is absent, which keeps the observer's per-tick reconciliation idempotent.
func (s *Store) DeleteCollision(ctx context.Context, a, b domain.SessionID) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.DeleteCollision(ctx, gen.DeleteCollisionParams{SessionA: a, SessionB: b})
}

// ListCollisionsByProject returns every collision row for one project.
func (s *Store) ListCollisionsByProject(ctx context.Context, project domain.ProjectID) ([]domain.SessionCollision, error) {
	rows, err := s.qr.ListCollisionsByProject(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("list collisions for %s: %w", project, err)
	}
	return mapCollisionRows(rows)
}

// ListAllCollisions returns every collision row across all projects.
func (s *Store) ListAllCollisions(ctx context.Context) ([]domain.SessionCollision, error) {
	rows, err := s.qr.ListAllCollisions(ctx)
	if err != nil {
		return nil, fmt.Errorf("list all collisions: %w", err)
	}
	return mapCollisionRows(rows)
}

// ListCollisionsForSession returns every collision row that names the session on
// either side of the pair.
func (s *Store) ListCollisionsForSession(ctx context.Context, id domain.SessionID) ([]domain.SessionCollision, error) {
	rows, err := s.qr.ListCollisionsForSession(ctx, gen.ListCollisionsForSessionParams{SessionA: id, SessionB: id})
	if err != nil {
		return nil, fmt.Errorf("list collisions for session %s: %w", id, err)
	}
	return mapCollisionRows(rows)
}

func mapCollisionRows(rows []gen.SessionCollision) ([]domain.SessionCollision, error) {
	out := make([]domain.SessionCollision, 0, len(rows))
	for _, r := range rows {
		c, err := collisionFromGen(r)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

func collisionFromGen(r gen.SessionCollision) (domain.SessionCollision, error) {
	var files []domain.CollisionFile
	if r.Files != "" {
		if err := json.Unmarshal([]byte(r.Files), &files); err != nil {
			return domain.SessionCollision{}, fmt.Errorf("unmarshal collision files for %s/%s: %w", r.SessionA, r.SessionB, err)
		}
	}
	return domain.SessionCollision{
		ProjectID:   r.ProjectID,
		SessionA:    r.SessionA,
		SessionB:    r.SessionB,
		Severity:    r.Severity,
		Files:       files,
		Signature:   r.Signature,
		FirstSeenAt: r.FirstSeenAt,
		UpdatedAt:   r.UpdatedAt,
	}, nil
}
