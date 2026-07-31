package engine

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// fakeOrphanSessions is the session store half of the orphan registry: the rows
// the marker is written onto and the ledger the cap and the TTL are derived
// from. Killing a session terminates its row, exactly as the real kill does,
// which is what stops a killed orphan from being counted or killed twice.
type fakeOrphanSessions struct {
	mu   sync.Mutex
	rows map[domain.SessionID]domain.SessionRecord
	// autoProject, when set, creates a row for any session the marker is written
	// to, so a caller need not enumerate the sessions it will spawn.
	autoProject domain.ProjectID
	killed      []string
	listErr     error
	markErr     error
	marks       int
}

func newFakeOrphanSessions(project domain.ProjectID, ids ...domain.SessionID) *fakeOrphanSessions {
	f := &fakeOrphanSessions{rows: map[domain.SessionID]domain.SessionRecord{}}
	for _, id := range ids {
		f.rows[id] = domain.SessionRecord{ID: id, ProjectID: project}
	}
	return f
}

// newAutoOrphanSessions stands in for a store where every spawned session
// already has a row, which is what the engine harness needs: it never enumerates
// the sessions its stages will spawn.
func newAutoOrphanSessions(project domain.ProjectID) *fakeOrphanSessions {
	f := newFakeOrphanSessions(project)
	f.autoProject = project
	return f
}

func (f *fakeOrphanSessions) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	out := make([]domain.SessionRecord, 0, len(f.rows))
	for _, rec := range f.rows {
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *fakeOrphanSessions) SetSessionPipelineOrphan(_ context.Context, id domain.SessionID, info *domain.PipelineOrphanInfo, _ time.Time) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.markErr != nil {
		return false, f.markErr
	}
	rec, ok := f.rows[id]
	if !ok {
		if f.autoProject == "" {
			return false, nil
		}
		rec = domain.SessionRecord{ID: id, ProjectID: f.autoProject}
	}
	f.marks++
	rec.Metadata.PipelineOrphan = info
	f.rows[id] = rec
	return true, nil
}

// Kill implements SessionDisposer over the same rows.
func (f *fakeOrphanSessions) Kill(_ context.Context, sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.killed = append(f.killed, sessionID)
	id := domain.SessionID(sessionID)
	if rec, ok := f.rows[id]; ok {
		rec.IsTerminated = true
		f.rows[id] = rec
	}
	return nil
}

func (f *fakeOrphanSessions) killedIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.killed...)
}

func (f *fakeOrphanSessions) marker(id domain.SessionID) *domain.PipelineOrphanInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rows[id].Metadata.PipelineOrphan
}

func keptAt(base time.Time, offset time.Duration) time.Time { return base.Add(offset) }

var orphanBase = time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)

func orphanInfo(runID, stage, outcome string, at time.Time) domain.PipelineOrphanInfo {
	return domain.PipelineOrphanInfo{
		RunID:    runID,
		Stage:    stage,
		Outcome:  outcome,
		KeptAt:   at,
		Pipeline: "pr-review",
	}
}

// A kept session carries the run, the stage and the outcome that spared it, so
// the session list can say why it is still there.
func TestOrphanRegistryMarksTheSession(t *testing.T) {
	rows := newFakeOrphanSessions("proj-1", "sess-1")
	reg := NewOrphanRegistry(rows, rows, nil)

	info := orphanInfo("run-a", "review", "no_output", orphanBase)
	reg.Keep(context.Background(), orphanKey("proj-1", "pr-review"), info, "sess-1")

	got := rows.marker("sess-1")
	if got == nil {
		t.Fatal("kept session is not marked pipeline-orphaned")
	}
	if *got != info {
		t.Fatalf("marker = %+v, want %+v", *got, info)
	}
	if killed := rows.killedIDs(); len(killed) != 0 {
		t.Fatalf("killed %v, want the first kept session left alone", killed)
	}
}

// The cap is what actually prevents the fifty-session case: a fourth kept
// session in the same pipeline evicts and kills the least recently kept, and
// another pipeline's kept sessions are none of its business.
func TestOrphanRegistryEvictsLeastRecentlyKept(t *testing.T) {
	rows := newFakeOrphanSessions("proj-1", "sess-1", "sess-2", "sess-3", "sess-4", "other-1")
	reg := NewOrphanRegistry(rows, rows, nil)
	ctx := context.Background()
	key := orphanKey("proj-1", "pr-review")

	for i, id := range []string{"sess-1", "sess-2", "sess-3"} {
		reg.Keep(ctx, key, orphanInfo("run-a", "review", "no_signal", keptAt(orphanBase, time.Duration(i)*time.Minute)), id)
	}
	if killed := rows.killedIDs(); len(killed) != 0 {
		t.Fatalf("killed %v at the cap, want nothing killed until it is exceeded", killed)
	}

	// A different pipeline has its own budget.
	otherInfo := orphanInfo("run-z", "triage", "timed_out", keptAt(orphanBase, 4*time.Minute))
	otherInfo.Pipeline = "session-triage"
	reg.Keep(ctx, orphanKey("proj-1", "session-triage"), otherInfo, "other-1")
	if killed := rows.killedIDs(); len(killed) != 0 {
		t.Fatalf("killed %v, want a second pipeline's keeps to be independent", killed)
	}

	reg.Keep(ctx, key, orphanInfo("run-b", "review", "no_signal", keptAt(orphanBase, 5*time.Minute)), "sess-4")
	killed := rows.killedIDs()
	if len(killed) != 1 || killed[0] != "sess-1" {
		t.Fatalf("killed %v, want only the least recently kept session (sess-1)", killed)
	}

	// Re-keeping a session already kept refreshes it rather than counting twice,
	// so the surviving three stay alive.
	reg.Keep(ctx, key, orphanInfo("run-b", "review", "no_signal", keptAt(orphanBase, 6*time.Minute)), "sess-4")
	if killed := rows.killedIDs(); len(killed) != 1 {
		t.Fatalf("killed %v, want re-keeping the same session to evict nobody", killed)
	}
}

// The TTL handles the slow leak: a kept session past 24h is killed by the
// supervisor's sweep, one still inside the window is not.
func TestOrphanRegistrySweepKillsPastTTL(t *testing.T) {
	rows := newFakeOrphanSessions("proj-1", "old", "fresh", "already-dead")
	reg := NewOrphanRegistry(rows, rows, nil)
	ctx := context.Background()
	key := orphanKey("proj-1", "pr-review")

	reg.Keep(ctx, key, orphanInfo("run-a", "review", "timed_out", orphanBase), "old")
	reg.Keep(ctx, key, orphanInfo("run-b", "review", "no_output", orphanBase.Add(23*time.Hour)), "fresh")
	reg.Keep(ctx, key, orphanInfo("run-c", "review", "no_output", orphanBase), "already-dead")
	_ = rows.Kill(ctx, "already-dead")

	reg.Sweep(ctx, orphanBase.Add(OrphanTTL+time.Minute))

	killed := rows.killedIDs()
	if len(killed) != 2 || killed[0] != "already-dead" || killed[1] != "old" {
		t.Fatalf("killed %v, want only the past-TTL session swept (the dead one was killed by hand)", killed)
	}

	// Sweeping again kills nothing new: the swept session's row is terminated,
	// so it has left the ledger.
	reg.Sweep(ctx, orphanBase.Add(OrphanTTL+time.Minute))
	if again := rows.killedIDs(); len(again) != 2 {
		t.Fatalf("killed %v, want the sweep to be idempotent", again)
	}
}

// The ledger lives on the session rows, not in this process, so the bounds still
// hold for sessions a previous daemon kept alive.
func TestOrphanRegistryBoundsSurviveARestart(t *testing.T) {
	rows := newFakeOrphanSessions("proj-1", "sess-1", "sess-2", "sess-3", "sess-4")
	ctx := context.Background()
	key := orphanKey("proj-1", "pr-review")

	before := NewOrphanRegistry(rows, rows, nil)
	for i, id := range []string{"sess-1", "sess-2", "sess-3"} {
		before.Keep(ctx, key, orphanInfo("run-a", "review", "no_signal", keptAt(orphanBase, time.Duration(i)*time.Minute)), id)
	}

	// A fresh registry, as a restarted daemon builds, still sees the three kept
	// sessions and evicts the oldest when the fourth arrives.
	after := NewOrphanRegistry(rows, rows, nil)
	after.Keep(ctx, key, orphanInfo("run-b", "review", "no_signal", keptAt(orphanBase, 9*time.Minute)), "sess-4")
	if killed := rows.killedIDs(); len(killed) != 1 || killed[0] != "sess-1" {
		t.Fatalf("killed %v, want the pre-restart keeps to still count toward the cap", killed)
	}
}

// A store that cannot be read must not kill anything: with no ledger there is no
// evidence any session is over the cap or past its TTL.
func TestOrphanRegistryUnreadableLedgerKillsNothing(t *testing.T) {
	rows := newFakeOrphanSessions("proj-1", "sess-1")
	reg := NewOrphanRegistry(rows, rows, nil)
	ctx := context.Background()
	rows.listErr = errors.New("db down")

	reg.Keep(ctx, orphanKey("proj-1", "pr-review"), orphanInfo("run-a", "review", "no_output", orphanBase), "sess-1")
	reg.Sweep(ctx, orphanBase.Add(2*OrphanTTL))
	if killed := rows.killedIDs(); len(killed) != 0 {
		t.Fatalf("killed %v with an unreadable ledger, want nothing killed", killed)
	}
}

// A nil registry is the no-reaper wiring (a test engine, or a daemon built
// without the session store). It must be inert, not a panic.
func TestOrphanRegistryNilIsInert(t *testing.T) {
	var reg *OrphanRegistry
	reg.Keep(context.Background(), "proj-1/pr-review", orphanInfo("run-a", "review", "no_output", orphanBase), "sess-1")
	reg.Sweep(context.Background(), orphanBase)
}
