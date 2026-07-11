package session

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestHardDrainTerminatesWorkersKeepsOrchestratorByDefault: HardDrain kills live
// workers and leaves the orchestrator and already-terminated rows alone unless
// orchestrators are explicitly included.
func TestHardDrainTerminatesWorkersKeepsOrchestratorByDefault(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker}
	st.sessions["mer-2"] = domain.SessionRecord{ID: "mer-2", ProjectID: "mer", Kind: domain.KindOrchestrator}
	st.sessions["mer-3"] = domain.SessionRecord{ID: "mer-3", ProjectID: "mer", Kind: domain.KindWorker, IsTerminated: true}
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	n, err := svc.HardDrain(context.Background(), "mer", false)
	if err != nil {
		t.Fatalf("hard drain: %v", err)
	}
	if n != 1 {
		t.Fatalf("terminated = %d, want 1 (only the live worker)", n)
	}
	if len(fc.killed) != 1 || fc.killed[0] != "mer-1" {
		t.Fatalf("killed = %v, want [mer-1] (orchestrator + terminated left alone)", fc.killed)
	}
}

// TestHardDrainBestEffortContinuesPastKillFailure: `--hard` is the emergency
// stop, so a single failed Kill must not strand the other live workers. Every
// killable session is still terminated and the failure is surfaced as an error.
func TestHardDrainBestEffortContinuesPastKillFailure(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker}
	st.sessions["mer-2"] = domain.SessionRecord{ID: "mer-2", ProjectID: "mer", Kind: domain.KindWorker}
	st.sessions["mer-3"] = domain.SessionRecord{ID: "mer-3", ProjectID: "mer", Kind: domain.KindWorker}
	fc := &fakeCommander{killFailIDs: map[domain.SessionID]bool{"mer-2": true}}
	svc := &Service{manager: fc, store: st}

	n, err := svc.HardDrain(context.Background(), "mer", false)
	if err == nil {
		t.Fatal("want an aggregated error when a kill fails, got nil")
	}
	if n != 2 {
		t.Fatalf("terminated = %d, want 2 (both killable workers, past the mer-2 failure)", n)
	}
	killed := map[domain.SessionID]bool{}
	for _, id := range fc.killed {
		killed[id] = true
	}
	if !killed["mer-1"] || !killed["mer-3"] {
		t.Fatalf("killed = %v, want mer-1 and mer-3 terminated despite mer-2 failing", fc.killed)
	}
}

// TestHardDrainIncludesOrchestratorsWhenAsked: the --hard --all fleet path also
// terminates the orchestrator.
func TestHardDrainIncludesOrchestratorsWhenAsked(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker}
	st.sessions["mer-2"] = domain.SessionRecord{ID: "mer-2", ProjectID: "mer", Kind: domain.KindOrchestrator}
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	n, err := svc.HardDrain(context.Background(), "mer", true)
	if err != nil {
		t.Fatalf("hard drain: %v", err)
	}
	if n != 2 {
		t.Fatalf("terminated = %d, want 2 (worker + orchestrator)", n)
	}
	killed := map[domain.SessionID]bool{}
	for _, id := range fc.killed {
		killed[id] = true
	}
	if !killed["mer-1"] || !killed["mer-2"] {
		t.Fatalf("killed = %v, want both worker and orchestrator", fc.killed)
	}
}
