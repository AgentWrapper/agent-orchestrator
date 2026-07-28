package lifecycle

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// A worker sandbox has NO local orchestrator; a pending worker_idle event must be
// emitted over the bus to the remote orchestrator and then marked delivered.
func TestDispatch_RemoteNudgeWhenNoLocalOrchestrator(t *testing.T) {
	st := newFakeStore()
	m := New(st, &fakeMessenger{}) // worker sandboxes always have a messenger (guard set)

	// Only a worker lives locally (no orchestrator in this project/sandbox).
	st.sessions["w1"] = domain.SessionRecord{ID: "w1", ProjectID: "p1", Kind: domain.KindWorker}
	st.idleEvents = append(st.idleEvents, domain.WorkerIdleEvent{
		ID: "ev1", ProjectID: "p1", WorkerID: "w1", TransitionAt: time.Unix(1, 0),
	})

	var got struct {
		orch, worker, msg string
		calls             int
	}
	m.SetRemoteNudge("orch-remote", "sb-self", func(_ context.Context, orchestratorID, workerID domain.SessionID, message string) error {
		got.orch, got.worker, got.msg = string(orchestratorID), string(workerID), message
		got.calls++
		return nil
	})

	m.DispatchPendingWorkerIdleEvents(context.Background(), "p1")

	if got.calls != 1 {
		t.Fatalf("remote nudge calls = %d, want 1", got.calls)
	}
	// The worker must be addressed by its bus ROUTING KEY (selfKey "sb-self"), not
	// its in-sandbox WorkerID "w1" (which collides across sandboxes / loops back).
	if got.orch != "orch-remote" || got.worker != "sb-self" {
		t.Fatalf("nudge target = %q/%q, want orch-remote/sb-self", got.orch, got.worker)
	}
	if !strings.Contains(got.msg, "sb-self") || strings.Contains(got.msg, "w1") {
		t.Fatalf("nudge message must reference the routing key, not the in-sandbox id: %q", got.msg)
	}
	if !st.delivered["ev1"] {
		t.Fatal("event should be marked delivered after a successful remote nudge")
	}
}

// Without a remote orchestrator wired, a no-local-orchestrator dispatch is a
// no-op and the event stays pending (unchanged local behavior).
func TestDispatch_NoRemoteConfiguredLeavesPending(t *testing.T) {
	st := newFakeStore()
	m := New(st, &fakeMessenger{})
	st.sessions["w1"] = domain.SessionRecord{ID: "w1", ProjectID: "p1", Kind: domain.KindWorker}
	st.idleEvents = append(st.idleEvents, domain.WorkerIdleEvent{ID: "ev1", ProjectID: "p1", WorkerID: "w1"})

	m.DispatchPendingWorkerIdleEvents(context.Background(), "p1")

	if st.delivered["ev1"] {
		t.Fatal("event must stay pending when no remote orchestrator is wired")
	}
}

// A failing remote nudge leaves the event pending for retry.
func TestDispatch_RemoteNudgeErrorLeavesPending(t *testing.T) {
	st := newFakeStore()
	m := New(st, &fakeMessenger{})
	st.sessions["w1"] = domain.SessionRecord{ID: "w1", ProjectID: "p1", Kind: domain.KindWorker}
	st.idleEvents = append(st.idleEvents, domain.WorkerIdleEvent{ID: "ev1", ProjectID: "p1", WorkerID: "w1"})
	m.SetRemoteNudge("orch-remote", "sb-self", func(context.Context, domain.SessionID, domain.SessionID, string) error {
		return context.DeadlineExceeded
	})

	m.DispatchPendingWorkerIdleEvents(context.Background(), "p1")

	if st.delivered["ev1"] {
		t.Fatal("event must stay pending when the remote nudge fails")
	}
}
