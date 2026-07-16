package coordinatorwake

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeStore struct {
	projects []domain.ProjectRecord
	sessions []domain.SessionRecord
	err      error
}

func (f *fakeStore) ListProjects(context.Context) ([]domain.ProjectRecord, error) {
	return append([]domain.ProjectRecord(nil), f.projects...), f.err
}

func (f *fakeStore) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return append([]domain.SessionRecord(nil), f.sessions...), f.err
}

type sentWake struct {
	id      domain.SessionID
	message string
}

type fakeSender struct {
	mu    sync.Mutex
	sends []sentWake
	fail  map[domain.SessionID]error
}

func (f *fakeSender) Send(_ context.Context, id domain.SessionID, message string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.fail[id]; err != nil {
		return err
	}
	f.sends = append(f.sends, sentWake{id: id, message: message})
	return nil
}

func TestPollWakesOnlyEligibleOptInProjects(t *testing.T) {
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		autoWake   bool
		worker     *domain.SessionRecord
		activity   domain.ActivityState
		terminated bool
		want       bool
	}{
		{name: "default disabled", worker: workerPtr("p1", "w1"), activity: domain.ActivityIdle},
		{name: "no worker", autoWake: true, activity: domain.ActivityIdle},
		{name: "terminated worker", autoWake: true, worker: terminated(worker("p1", "w1")), activity: domain.ActivityIdle},
		{name: "exited worker", autoWake: true, worker: workerWithActivityPtr("p1", "w1", domain.ActivityExited), activity: domain.ActivityIdle},
		{name: "idle", autoWake: true, worker: workerPtr("p1", "w1"), activity: domain.ActivityIdle, want: true},
		{name: "waiting input", autoWake: true, worker: workerPtr("p1", "w1"), activity: domain.ActivityWaitingInput, want: true},
		{name: "active", autoWake: true, worker: workerPtr("p1", "w1"), activity: domain.ActivityActive},
		{name: "blocked", autoWake: true, worker: workerPtr("p1", "w1"), activity: domain.ActivityBlocked},
		{name: "exited", autoWake: true, worker: workerPtr("p1", "w1"), activity: domain.ActivityExited},
		{name: "terminated orchestrator", autoWake: true, worker: workerPtr("p1", "w1"), activity: domain.ActivityIdle, terminated: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			project := domain.ProjectRecord{ID: "p1"}
			project.Config.Coordinator.AutoWake = tc.autoWake
			orchestrator := session("p1", "orch", domain.KindOrchestrator, tc.activity, now)
			orchestrator.IsTerminated = tc.terminated
			sessions := []domain.SessionRecord{orchestrator}
			if tc.worker != nil {
				sessions = append(sessions, *tc.worker)
			}
			sender := &fakeSender{}
			runner := New(&fakeStore{projects: []domain.ProjectRecord{project}, sessions: sessions}, sender, Config{
				Clock: func() time.Time { return now }, Logger: discardLogger(),
			})

			if err := runner.Poll(context.Background()); err != nil {
				t.Fatalf("Poll: %v", err)
			}
			if got := len(sender.sends) == 1; got != tc.want {
				t.Fatalf("sent = %v, want %v (%#v)", got, tc.want, sender.sends)
			}
			if tc.want && sender.sends[0] != (sentWake{id: "orch", message: WakeMessage}) {
				t.Fatalf("send = %#v", sender.sends[0])
			}
		})
	}
}

func TestPollUsesNewestLiveOrchestratorAndKeepsProjectsIndependent(t *testing.T) {
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.UTC)
	projects := []domain.ProjectRecord{autoWakeProject("p1"), autoWakeProject("p2")}
	sessions := []domain.SessionRecord{
		worker("p1", "w1"),
		session("p1", "old", domain.KindOrchestrator, domain.ActivityIdle, now.Add(-time.Hour)),
		session("p1", "new", domain.KindOrchestrator, domain.ActivityWaitingInput, now),
		worker("p2", "w2"),
		session("p2", "p2-orch", domain.KindOrchestrator, domain.ActivityIdle, now),
	}
	sender := &fakeSender{}
	runner := New(&fakeStore{projects: projects, sessions: sessions}, sender, Config{
		Clock: func() time.Time { return now }, Logger: discardLogger(),
	})

	if err := runner.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sender.sends) != 2 || sender.sends[0].id != "new" || sender.sends[1].id != "p2-orch" {
		t.Fatalf("sends = %#v", sender.sends)
	}
}

func TestPollCooldownStartsOnlyAfterSuccessfulSend(t *testing.T) {
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.UTC)
	store := &fakeStore{
		projects: []domain.ProjectRecord{autoWakeProject("p1")},
		sessions: []domain.SessionRecord{worker("p1", "w1"), session("p1", "orch", domain.KindOrchestrator, domain.ActivityIdle, now)},
	}
	sender := &fakeSender{fail: map[domain.SessionID]error{"orch": errors.New("runtime unavailable")}}
	runner := New(store, sender, Config{Clock: func() time.Time { return now }, Cooldown: 30 * time.Second, Logger: discardLogger()})

	if err := runner.Poll(context.Background()); err == nil {
		t.Fatal("failed send should be returned")
	}
	delete(sender.fail, "orch")
	if err := runner.Poll(context.Background()); err != nil {
		t.Fatalf("retry after failure: %v", err)
	}
	if err := runner.Poll(context.Background()); err != nil {
		t.Fatalf("cooldown poll: %v", err)
	}
	if len(sender.sends) != 1 {
		t.Fatalf("sends during cooldown = %#v", sender.sends)
	}

	now = now.Add(30 * time.Second)
	if err := runner.Poll(context.Background()); err != nil {
		t.Fatalf("poll after cooldown: %v", err)
	}
	if len(sender.sends) != 2 {
		t.Fatalf("sends after cooldown = %#v", sender.sends)
	}
}

func TestStartStopsWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runner := New(&fakeStore{}, &fakeSender{}, Config{Tick: 5 * time.Millisecond, Logger: discardLogger()})
	done := runner.Start(ctx)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("runner did not stop")
	}
}

func autoWakeProject(id string) domain.ProjectRecord {
	project := domain.ProjectRecord{ID: id}
	project.Config.Coordinator.AutoWake = true
	return project
}

func worker(project, id string) domain.SessionRecord {
	return session(project, id, domain.KindWorker, domain.ActivityActive, time.Time{})
}

func workerPtr(project, id string) *domain.SessionRecord {
	record := worker(project, id)
	return &record
}

func workerWithActivityPtr(project, id string, activity domain.ActivityState) *domain.SessionRecord {
	record := session(project, id, domain.KindWorker, activity, time.Time{})
	return &record
}

func session(project, id string, kind domain.SessionKind, activity domain.ActivityState, createdAt time.Time) domain.SessionRecord {
	return domain.SessionRecord{
		ID:        domain.SessionID(id),
		ProjectID: domain.ProjectID(project),
		Kind:      kind,
		Activity:  domain.Activity{State: activity},
		CreatedAt: createdAt,
	}
}

func terminated(session domain.SessionRecord) *domain.SessionRecord {
	session.IsTerminated = true
	return &session
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
