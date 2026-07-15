package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestSuggestionStoreRoundTrip(t *testing.T) {
	s := newTestStore(t)
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)
	rec := domain.SuggestionRecord{
		ID: "sg_1", ProjectID: "mer", Title: "Consider a cache", Note: "Grand workflow note",
		Priority: domain.SuggestionPriorityImportant, Status: domain.SuggestionBacklog, CreatedAt: now, UpdatedAt: now,
	}
	created, err := s.CreateSuggestion(context.Background(), rec)
	if err != nil {
		t.Fatal(err)
	}
	if created.Title != rec.Title || created.Status != domain.SuggestionBacklog {
		t.Fatalf("created = %#v", created)
	}
	items, err := s.ListSuggestions(context.Background(), "mer")
	if err != nil || len(items) != 1 {
		t.Fatalf("list = %#v, err=%v", items, err)
	}
	created.Status = domain.SuggestionDone
	created.UpdatedAt = now.Add(time.Minute)
	updated, ok, err := s.UpdateSuggestion(context.Background(), created)
	if err != nil || !ok || updated.Status != domain.SuggestionDone {
		t.Fatalf("update = %#v, ok=%v err=%v", updated, ok, err)
	}
}
