package suggestion

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeStore struct {
	projects map[string]domain.ProjectRecord
	items    map[string]domain.SuggestionRecord
}

func (f *fakeStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	rec, ok := f.projects[id]
	return rec, ok, nil
}

func (f *fakeStore) CreateSuggestion(_ context.Context, rec domain.SuggestionRecord) (domain.SuggestionRecord, error) {
	f.items[rec.ID] = rec
	return rec, nil
}

func (f *fakeStore) ListSuggestions(_ context.Context, projectID domain.ProjectID) ([]domain.SuggestionRecord, error) {
	out := []domain.SuggestionRecord{}
	for _, item := range f.items {
		if item.ProjectID == projectID {
			out = append(out, item)
		}
	}
	return out, nil
}

func (f *fakeStore) GetSuggestion(_ context.Context, projectID domain.ProjectID, id string) (domain.SuggestionRecord, bool, error) {
	rec, ok := f.items[id]
	return rec, ok && rec.ProjectID == projectID, nil
}

func (f *fakeStore) UpdateSuggestion(_ context.Context, rec domain.SuggestionRecord) (domain.SuggestionRecord, bool, error) {
	if _, ok := f.items[rec.ID]; !ok {
		return domain.SuggestionRecord{}, false, nil
	}
	f.items[rec.ID] = rec
	return rec, true, nil
}

type fakeStarter struct {
	cfg ports.SpawnConfig
}

func (f *fakeStarter) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.Session, error) {
	f.cfg = cfg
	return domain.Session{SessionRecord: domain.SessionRecord{ID: "mer-7", ProjectID: cfg.ProjectID, Kind: cfg.Kind}}, nil
}

func TestCreateAndStartSuggestion(t *testing.T) {
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{
		projects: map[string]domain.ProjectRecord{"mer": {ID: "mer"}},
		items:    map[string]domain.SuggestionRecord{},
	}
	starter := &fakeStarter{}
	m := New(Deps{Store: store, Sessions: starter, Clock: func() time.Time { return now }, NewID: func() string { return "sg_test" }})

	created, err := m.Create(context.Background(), "mer", CreateInput{Title: "  Explore shared cache  ", Note: "Useful after the current release."})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != "sg_test" || created.Title != "Explore shared cache" || created.Priority != domain.SuggestionPriorityNormal || created.Status != domain.SuggestionBacklog {
		t.Fatalf("created = %#v", created)
	}

	started, err := m.Start(context.Background(), "mer", created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if started.SessionID != "mer-7" || started.Suggestion.Status != domain.SuggestionInProgress || started.Suggestion.SessionID != "mer-7" {
		t.Fatalf("started = %#v", started)
	}
	if starter.cfg.Kind != domain.KindWorker || starter.cfg.DisplayName != "Explore shared cache" {
		t.Fatalf("spawn config = %#v", starter.cfg)
	}
	for _, want := range []string{"deferred project suggestion", "non-blocking grand-workflow improvement", "Useful after the current release."} {
		if !strings.Contains(starter.cfg.Prompt, want) {
			t.Fatalf("worker prompt missing %q:\n%s", want, starter.cfg.Prompt)
		}
	}
}

func TestUpdateSuggestionReturnsItToBacklog(t *testing.T) {
	now := time.Now().UTC()
	store := &fakeStore{
		projects: map[string]domain.ProjectRecord{"mer": {ID: "mer"}},
		items: map[string]domain.SuggestionRecord{"sg_1": {
			ID: "sg_1", ProjectID: "mer", Title: "Idea", Priority: domain.SuggestionPriorityNormal,
			Status: domain.SuggestionDone, SessionID: "mer-2", CreatedAt: now, UpdatedAt: now,
		}},
	}
	m := New(Deps{Store: store})
	status := domain.SuggestionBacklog
	got, err := m.Update(context.Background(), "mer", "sg_1", UpdateInput{Status: &status})
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != domain.SuggestionBacklog || got.SessionID != "" {
		t.Fatalf("updated = %#v", got)
	}
}
