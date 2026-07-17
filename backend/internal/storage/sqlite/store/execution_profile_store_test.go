package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestExecutionProfileChangeIsAtomicAndAudited(t *testing.T) {
	store := newTestStore(t)
	seedProject(t, store, "ao")
	oldProfile, _ := domain.NewExecutionProfile(domain.AgentConfig{Model: "gpt-5"}, "project_config")
	rec := sampleRecord("ao")
	rec.Metadata.ExecutionProfile = oldProfile
	rec.Metadata.ObservedExecutionProfileHash = oldProfile.Hash
	rec, err := store.CreateSession(context.Background(), rec)
	if err != nil {
		t.Fatal(err)
	}
	requested, _ := domain.NewExecutionProfile(domain.AgentConfig{Model: "gpt-5.1", FastMode: true}, "project_config")
	change, err := domain.AuthorizeExecutionProfileChange(rec.ID, oldProfile, requested, "human", "approved migration", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ChangeSessionExecutionProfile(context.Background(), change); err != nil {
		t.Fatal(err)
	}
	got, _, _ := store.GetSession(context.Background(), rec.ID)
	if got.Metadata.ExecutionProfile.Hash != change.NewProfile.Hash || got.Metadata.ObservedExecutionProfileHash != "" {
		t.Fatalf("session metadata = %#v", got.Metadata)
	}
	got.Metadata.ExecutionProfile = oldProfile
	if err := store.UpdateSession(context.Background(), got); err != nil {
		t.Fatal(err)
	}
	got, _, _ = store.GetSession(context.Background(), rec.ID)
	if got.Metadata.ExecutionProfile.Hash != change.NewProfile.Hash {
		t.Fatalf("generic update overwrote immutable profile: %#v", got.Metadata.ExecutionProfile)
	}
	history, err := store.ListSessionExecutionProfileChanges(context.Background(), rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].OldProfile.Hash != oldProfile.Hash || history[0].Authority != "human" || history[0].Reason != "approved migration" {
		t.Fatalf("history = %#v", history)
	}

	stale := change
	stale.NewProfile, _ = domain.NewExecutionProfile(domain.AgentConfig{Model: "fallback"}, "human")
	if err := store.ChangeSessionExecutionProfile(context.Background(), stale); !errors.Is(err, domain.ErrExecutionProfileDrift) {
		t.Fatalf("stale change err = %v", err)
	}
	history, _ = store.ListSessionExecutionProfileChanges(context.Background(), rec.ID)
	if len(history) != 1 {
		t.Fatalf("stale change wrote audit row: %d", len(history))
	}
}
