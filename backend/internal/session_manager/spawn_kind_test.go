package sessionmanager

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// TestSpawnRejectsUnknownKind pins #293 M1 at the manager's invariant boundary:
// an unknown kind must never reach durable state. buildSystemPrompt has no
// standing instructions for it, so such a session launches roleless.
func TestSpawnRejectsUnknownKind(t *testing.T) {
	m, st, rt, _ := newManager()
	ctx := context.Background()

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.SessionKind("bogus"), Prompt: "go"})
	if !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("spawn err = %v, want ErrInvalidKind", err)
	}
	if len(st.sessions) != 0 {
		t.Fatalf("invalid kind persisted a session row: %#v", st.sessions)
	}
	if rt.created != 0 {
		t.Fatalf("invalid kind launched %d runtimes, want 0", rt.created)
	}
}

// An omitted kind keeps defaulting to worker, and the known kinds still spawn.
func TestSpawnAcceptsKnownKinds(t *testing.T) {
	ctx := context.Background()
	for _, kind := range []domain.SessionKind{"", domain.KindWorker, domain.KindOrchestrator, domain.KindPrime} {
		m, _, _, _ := newManager()
		// An explicit harness keeps the case about the kind: the test project's
		// role config names agents for worker/orchestrator only.
		rec, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: kind, Harness: domain.AgentHarness("claude-code"), Prompt: "go"})
		if err != nil {
			t.Fatalf("spawn kind %q: %v", kind, err)
		}
		want := kind
		if want == "" {
			want = domain.KindWorker
		}
		if rec.Kind != want {
			t.Fatalf("spawn kind %q recorded %q, want %q", kind, rec.Kind, want)
		}
	}
}
