package usage

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	usagesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/usage"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestObserverPersistsAppendOnlyUsageAcrossRestartAndFinalization(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(1700000000, 0).UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "usage", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	binding, err := store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      domain.HarnessCodex,
		NativeRootID: "native-1",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	path := t.TempDir() + "/rollout.jsonl"
	initial := `{"type":"session_meta","payload":{"model_provider":"openai"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-5.6"}}` + "\n" +
		string(codexTokenLine("2026-07-01T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	identity, err := usagesvc.SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:     binding.ID,
		Kind:          domain.UsageSourceCodexRollout,
		ArtifactPath:  path,
		FileIdentity:  identity,
		ParserVersion: usagesvc.CodexRolloutParserVersion,
		State:         domain.UsageSourcePending,
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	if err != nil {
		t.Fatal(err)
	}
	observer := New(store, Config{Clock: func() time.Time { return now }})
	if err := observer.Poll(ctx); err != nil {
		t.Fatalf("first poll: %v", err)
	}
	assertTokenAggregate(t, store, session.ID, 120)

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(append(codexTokenLine("2026-07-01T10:00:01Z", 150, 90, 0, 30, 8), '\n')); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	_ = file.Close()
	now = now.Add(30 * time.Second)
	if err := observer.Poll(ctx); err != nil {
		t.Fatalf("append poll: %v", err)
	}
	assertTokenAggregate(t, store, session.ID, 180)

	restarted := New(store, Config{Clock: func() time.Time { return now }})
	if err := restarted.Poll(ctx); err != nil {
		t.Fatalf("restart poll: %v", err)
	}
	assertTokenAggregate(t, store, session.ID, 180)

	if _, err := store.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Poll(ctx); err != nil {
		t.Fatalf("final poll: %v", err)
	}
	got, ok, err := store.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("source ok=%v err=%v", ok, err)
	}
	if got.Source.State != domain.UsageSourceComplete {
		t.Fatalf("source state = %s", got.Source.State)
	}
	bindings, err := store.ListUsageBindingsForSession(ctx, session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingComplete {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
}

func assertTokenAggregate(t *testing.T, store *sqlite.Store, sessionID domain.SessionID, total int64) {
	t.Helper()
	aggregates, err := store.ListUsageModelAggregates(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	var got int64
	for _, aggregate := range aggregates {
		got += aggregate.Tokens.InputTokens + aggregate.Tokens.OutputTokens
	}
	if got != total {
		t.Fatalf("total tokens = %d, want %d; aggregates=%+v", got, total, aggregates)
	}
}
