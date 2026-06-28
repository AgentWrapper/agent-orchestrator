package convergence

// These tests exercise the convergence observer's orchestration contract with
// fake differ, store, and lifecycle collaborators so overlap classification,
// signature-based dedup, reconciliation (upsert/delete), and hot-collision
// nudging stay independent of git and SQLite.

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeDiffer struct {
	regions map[domain.SessionID]map[string][]ports.LineRange
	err     map[domain.SessionID]error
}

func (f *fakeDiffer) ChangedRegions(_ context.Context, info ports.WorkspaceInfo) (map[string][]ports.LineRange, error) {
	if f.err != nil {
		if e := f.err[info.SessionID]; e != nil {
			return nil, e
		}
	}
	return f.regions[info.SessionID], nil
}

type fakeStore struct {
	mu        sync.Mutex
	sessions  []domain.SessionRecord
	current   map[pairKey]domain.SessionCollision
	upserts   int
	deletes   int
	upsertErr error
}

func newFakeStore(sessions ...domain.SessionRecord) *fakeStore {
	return &fakeStore{sessions: sessions, current: map[pairKey]domain.SessionCollision{}}
}

func (s *fakeStore) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return s.sessions, nil
}

func (s *fakeStore) ListAllCollisions(context.Context) ([]domain.SessionCollision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.SessionCollision, 0, len(s.current))
	for _, c := range s.current {
		out = append(out, c)
	}
	return out, nil
}

func (s *fakeStore) UpsertCollision(_ context.Context, c domain.SessionCollision) error {
	if s.upsertErr != nil {
		return s.upsertErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	k := pairKey{c.SessionA, c.SessionB}
	if existing, ok := s.current[k]; ok {
		c.FirstSeenAt = existing.FirstSeenAt // mirror the DB's preserve-on-conflict.
	}
	s.current[k] = c
	s.upserts++
	return nil
}

func (s *fakeStore) DeleteCollision(_ context.Context, a, b domain.SessionID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.current, pairKey{a, b})
	s.deletes++
	return nil
}

type fakeLifecycle struct {
	mu      sync.Mutex
	applied []domain.CollisionWithNames
}

func (l *fakeLifecycle) ApplyCollision(_ context.Context, c domain.CollisionWithNames) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.applied = append(l.applied, c)
	return nil
}

func worker(id, project, name, path string) domain.SessionRecord {
	return domain.SessionRecord{
		ID:          domain.SessionID(id),
		ProjectID:   domain.ProjectID(project),
		Kind:        domain.KindWorker,
		DisplayName: name,
		Metadata:    domain.SessionMetadata{WorkspacePath: path},
	}
}

func rng(start, end int) ports.LineRange { return ports.LineRange{Start: start, End: end} }

func newTestObserver(d Differ, s Store, l Lifecycle) *Observer {
	return New(d, s, l, Config{Clock: func() time.Time { return time.Unix(1000, 0).UTC() }})
}

func TestPoll_HotCollisionPersistsAndNudges(t *testing.T) {
	a := worker("p-1", "p", "alpha", "/wt/a")
	b := worker("p-2", "p", "bravo", "/wt/b")
	differ := &fakeDiffer{regions: map[domain.SessionID]map[string][]ports.LineRange{
		a.ID: {"config.go": {rng(10, 20)}},
		b.ID: {"config.go": {rng(15, 25)}}, // overlaps 15-20 → hot
	}}
	store := newFakeStore(a, b)
	lc := &fakeLifecycle{}
	o := newTestObserver(differ, store, lc)

	if err := o.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}

	if store.upserts != 1 {
		t.Fatalf("want 1 upsert, got %d", store.upserts)
	}
	got := store.current[pairKey{a.ID, b.ID}]
	if got.Severity != domain.CollisionHot {
		t.Fatalf("want hot, got %q", got.Severity)
	}
	if len(got.Files) != 1 || got.Files[0].Path != "config.go" {
		t.Fatalf("unexpected files: %+v", got.Files)
	}
	if len(got.Files[0].Ranges) != 1 || got.Files[0].Ranges[0] != [2]int{15, 20} {
		t.Fatalf("want overlap 15-20, got %+v", got.Files[0].Ranges)
	}
	if len(lc.applied) != 1 {
		t.Fatalf("want 1 nudge, got %d", len(lc.applied))
	}
	if lc.applied[0].NameA != "alpha" || lc.applied[0].NameB != "bravo" {
		t.Fatalf("unexpected names: %+v", lc.applied[0])
	}
}

func TestPoll_SoftCollisionPersistsWithoutNudge(t *testing.T) {
	a := worker("p-1", "p", "alpha", "/wt/a")
	b := worker("p-2", "p", "bravo", "/wt/b")
	differ := &fakeDiffer{regions: map[domain.SessionID]map[string][]ports.LineRange{
		a.ID: {"config.go": {rng(1, 5)}},
		b.ID: {"config.go": {rng(50, 60)}}, // same file, disjoint ranges → soft
	}}
	store := newFakeStore(a, b)
	lc := &fakeLifecycle{}
	o := newTestObserver(differ, store, lc)

	if err := o.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}
	got := store.current[pairKey{a.ID, b.ID}]
	if got.Severity != domain.CollisionSoft {
		t.Fatalf("want soft, got %q", got.Severity)
	}
	if len(lc.applied) != 0 {
		t.Fatalf("soft collision must not nudge; got %d", len(lc.applied))
	}
}

func TestPoll_NoOverlapNoRow(t *testing.T) {
	a := worker("p-1", "p", "alpha", "/wt/a")
	b := worker("p-2", "p", "bravo", "/wt/b")
	differ := &fakeDiffer{regions: map[domain.SessionID]map[string][]ports.LineRange{
		a.ID: {"a.go": {rng(1, 5)}},
		b.ID: {"b.go": {rng(1, 5)}},
	}}
	store := newFakeStore(a, b)
	o := newTestObserver(differ, store, &fakeLifecycle{})

	if err := o.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if len(store.current) != 0 {
		t.Fatalf("want no collisions, got %d", len(store.current))
	}
}

func TestPoll_StableOverlapWritesOnceThenDedupes(t *testing.T) {
	a := worker("p-1", "p", "alpha", "/wt/a")
	b := worker("p-2", "p", "bravo", "/wt/b")
	differ := &fakeDiffer{regions: map[domain.SessionID]map[string][]ports.LineRange{
		a.ID: {"config.go": {rng(10, 20)}},
		b.ID: {"config.go": {rng(15, 25)}},
	}}
	store := newFakeStore(a, b)
	lc := &fakeLifecycle{}
	o := newTestObserver(differ, store, lc)

	for i := 0; i < 3; i++ {
		if err := o.Poll(context.Background()); err != nil {
			t.Fatalf("Poll %d: %v", i, err)
		}
	}
	if store.upserts != 1 {
		t.Fatalf("stable overlap must upsert once, got %d", store.upserts)
	}
	if len(lc.applied) != 1 {
		t.Fatalf("stable overlap must nudge once, got %d", len(lc.applied))
	}
}

func TestPoll_ResolvedOverlapIsDeleted(t *testing.T) {
	a := worker("p-1", "p", "alpha", "/wt/a")
	b := worker("p-2", "p", "bravo", "/wt/b")
	differ := &fakeDiffer{regions: map[domain.SessionID]map[string][]ports.LineRange{
		a.ID: {"config.go": {rng(10, 20)}},
		b.ID: {"config.go": {rng(15, 25)}},
	}}
	store := newFakeStore(a, b)
	o := newTestObserver(differ, store, &fakeLifecycle{})
	if err := o.Poll(context.Background()); err != nil {
		t.Fatalf("Poll 1: %v", err)
	}
	if len(store.current) != 1 {
		t.Fatalf("want 1 collision after first poll, got %d", len(store.current))
	}

	// Session b stops overlapping config.go.
	differ.regions[b.ID] = map[string][]ports.LineRange{"other.go": {rng(1, 2)}}
	if err := o.Poll(context.Background()); err != nil {
		t.Fatalf("Poll 2: %v", err)
	}
	if len(store.current) != 0 {
		t.Fatalf("resolved overlap must be deleted, got %d rows", len(store.current))
	}
	if store.deletes != 1 {
		t.Fatalf("want 1 delete, got %d", store.deletes)
	}
}

func TestPoll_TerminatedAndOrchestratorExcluded(t *testing.T) {
	a := worker("p-1", "p", "alpha", "/wt/a")
	b := worker("p-2", "p", "bravo", "/wt/b")
	b.IsTerminated = true
	c := worker("p-3", "p", "charlie", "/wt/c")
	c.Kind = domain.KindOrchestrator
	differ := &fakeDiffer{regions: map[domain.SessionID]map[string][]ports.LineRange{
		a.ID: {"config.go": {rng(10, 20)}},
		b.ID: {"config.go": {rng(10, 20)}},
		c.ID: {"config.go": {rng(10, 20)}},
	}}
	store := newFakeStore(a, b, c)
	o := newTestObserver(differ, store, &fakeLifecycle{})
	if err := o.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if len(store.current) != 0 {
		t.Fatalf("only one eligible session: want no collisions, got %d", len(store.current))
	}
}

func TestPoll_WholeFileChangeIsHot(t *testing.T) {
	a := worker("p-1", "p", "alpha", "/wt/a")
	b := worker("p-2", "p", "bravo", "/wt/b")
	differ := &fakeDiffer{regions: map[domain.SessionID]map[string][]ports.LineRange{
		a.ID: {"gone.go": {}},          // deletion / whole-file change, no ranges
		b.ID: {"gone.go": {rng(1, 3)}}, // edit
	}}
	store := newFakeStore(a, b)
	lc := &fakeLifecycle{}
	o := newTestObserver(differ, store, lc)
	if err := o.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got := store.current[pairKey{a.ID, b.ID}]; got.Severity != domain.CollisionHot {
		t.Fatalf("whole-file change vs edit must be hot, got %q", got.Severity)
	}
	if len(lc.applied) != 1 {
		t.Fatalf("want 1 nudge, got %d", len(lc.applied))
	}
}

func TestPoll_DifferErrorSkipsSessionNotCrash(t *testing.T) {
	a := worker("p-1", "p", "alpha", "/wt/a")
	b := worker("p-2", "p", "bravo", "/wt/b")
	differ := &fakeDiffer{
		regions: map[domain.SessionID]map[string][]ports.LineRange{
			b.ID: {"config.go": {rng(1, 5)}},
		},
		err: map[domain.SessionID]error{a.ID: context.DeadlineExceeded},
	}
	store := newFakeStore(a, b)
	o := newTestObserver(differ, store, &fakeLifecycle{})
	if err := o.Poll(context.Background()); err != nil {
		t.Fatalf("Poll must tolerate a per-session diff error: %v", err)
	}
	if len(store.current) != 0 {
		t.Fatalf("one session failed to diff: no pair possible, got %d", len(store.current))
	}
}
