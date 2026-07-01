package store_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCollisionStore_UpsertListDelete(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	a, _ := s.CreateSession(ctx, sampleRecord("mer"))
	b, _ := s.CreateSession(ctx, sampleRecord("mer"))

	now := time.Now().UTC().Truncate(time.Second)
	c := domain.SessionCollision{
		ProjectID: "mer",
		SessionA:  a.ID,
		SessionB:  b.ID,
		Severity:  domain.CollisionHot,
		Files: []domain.CollisionFile{
			{Path: "config.go", Ranges: [][2]int{{15, 20}}},
			{Path: "main.go"},
		},
		Signature:   "sig1",
		FirstSeenAt: now,
		UpdatedAt:   now,
	}
	if a.ID >= b.ID {
		c.SessionA, c.SessionB = b.ID, a.ID
	}

	if err := s.UpsertCollision(ctx, c); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	got, err := s.ListCollisionsByProject(ctx, "mer")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 collision, got %d", len(got))
	}
	if !reflect.DeepEqual(got[0].Files, c.Files) {
		t.Fatalf("files round-trip mismatch: got %+v want %+v", got[0].Files, c.Files)
	}
	if got[0].Severity != domain.CollisionHot {
		t.Fatalf("severity round-trip: got %q", got[0].Severity)
	}

	// Upsert with a changed signature preserves first_seen_at, moves updated_at.
	later := now.Add(time.Minute)
	c.Signature = "sig2"
	c.Severity = domain.CollisionSoft
	c.FirstSeenAt = later // should be ignored by the DB on conflict
	c.UpdatedAt = later
	if err := s.UpsertCollision(ctx, c); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	got, _ = s.ListCollisionsByProject(ctx, "mer")
	if len(got) != 1 {
		t.Fatalf("re-upsert should not duplicate; got %d rows", len(got))
	}
	if !got[0].FirstSeenAt.Equal(now) {
		t.Fatalf("first_seen_at must be preserved across upsert: got %v want %v", got[0].FirstSeenAt, now)
	}
	if got[0].Signature != "sig2" || got[0].Severity != domain.CollisionSoft {
		t.Fatalf("signature/severity not updated: %+v", got[0])
	}

	// ListCollisionsForSession finds the pair from either side.
	bySession, err := s.ListCollisionsForSession(ctx, a.ID)
	if err != nil {
		t.Fatalf("list for session: %v", err)
	}
	if len(bySession) != 1 {
		t.Fatalf("want 1 collision for session %s, got %d", a.ID, len(bySession))
	}

	if err := s.DeleteCollision(ctx, c.SessionA, c.SessionB); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, _ = s.ListCollisionsByProject(ctx, "mer")
	if len(got) != 0 {
		t.Fatalf("want 0 after delete, got %d", len(got))
	}
}
