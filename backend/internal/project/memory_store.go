package project

import (
	"context"
	"sync"
	"time"
)

// ProjectRow mirrors the project table shape from the sqlite storage PR. The
// memory store is intentionally row-based so the API layer does not depend on a
// richer mock model than the real DB will provide.
type ProjectRow struct {
	ID            string
	Path          string
	RepoOriginURL string
	DisplayName   string
	RegisteredAt  time.Time
	ArchivedAt    time.Time
}

type Store interface {
	List(ctx context.Context) ([]ProjectRow, error)
	Get(ctx context.Context, id string) (ProjectRow, bool, error)
	FindByPath(ctx context.Context, path string) (ProjectRow, bool, error)
	Upsert(ctx context.Context, row ProjectRow) error
	Archive(ctx context.Context, id string, at time.Time) (bool, error)
}

// MemoryStore is the mocked DB layer for the project API implementation. It is
// process-local and intentionally small, but concurrency-safe for HTTP tests.
type MemoryStore struct {
	mu       sync.Mutex
	projects map[string]ProjectRow
	paths    map[string]string
}

var _ Store = (*MemoryStore)(nil)

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		projects: map[string]ProjectRow{},
		paths:    map[string]string{},
	}
}

func (s *MemoryStore) List(context.Context) ([]ProjectRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]ProjectRow, 0, len(s.projects))
	for _, row := range s.projects {
		if row.ArchivedAt.IsZero() {
			out = append(out, row)
		}
	}
	return out, nil
}

func (s *MemoryStore) Get(_ context.Context, id string) (ProjectRow, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	row, ok := s.projects[id]
	if !ok {
		return ProjectRow{}, false, nil
	}
	return row, true, nil
}

func (s *MemoryStore) FindByPath(_ context.Context, path string) (ProjectRow, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id, ok := s.paths[path]
	if !ok {
		return ProjectRow{}, false, nil
	}
	row, ok := s.projects[id]
	if !ok {
		return ProjectRow{}, false, nil
	}
	return row, true, nil
}

func (s *MemoryStore) Upsert(_ context.Context, row ProjectRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.projects[row.ID]; ok && existing.Path != row.Path {
		delete(s.paths, existing.Path)
	}
	s.projects[row.ID] = row
	s.paths[row.Path] = row.ID
	return nil
}

func (s *MemoryStore) Archive(_ context.Context, id string, at time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	row, ok := s.projects[id]
	if !ok {
		return false, nil
	}
	row.ArchivedAt = at
	s.projects[id] = row
	return true, nil
}
