package main

import (
	"context"
	"io"
	"log/slog"
	"reflect"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/session"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/wiring"
)

// TestWiring_WriteFlowsToBroadcaster exercises the real boot path end to end:
// a lifecycle write -> sqlite -> DB trigger -> change_log -> CDC poller ->
// broadcaster, through the production wiring.Adapter and cdcSource.
func TestWiring_WriteFlowsToBroadcaster(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	a := wiring.Adapter{Store: store}
	lcm := lifecycle.New(a, a, noopNotifier{}, noopMessenger{})

	bcast := cdc.NewBroadcaster()
	poller := cdc.NewPoller(cdcSource{store}, bcast, cdc.PollerConfig{})
	if err := poller.SeekToHead(ctx); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var got []cdc.Event
	bcast.Subscribe(func(e cdc.Event) { mu.Lock(); got = append(got, e); mu.Unlock() })

	if err := store.UpsertProject(ctx, sqlite.ProjectRow{ID: "mer", Path: "/repo/mer"}); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "mer", Kind: domain.KindWorker,
		Lifecycle: domain.CanonicalSessionLifecycle{Version: domain.LifecycleVersion, Session: domain.SessionSubstate{State: domain.SessionNotStarted}},
	})
	if err != nil {
		t.Fatal(err)
	}
	// A real transition through the engine, which writes the row and fires the
	// is_alive/activity_state CDC trigger.
	if err := lcm.ApplyActivitySignal(ctx, rec.ID, ports.ActivitySignal{Valid: true, State: domain.ActivityActive, Timestamp: time.Now()}); err != nil {
		t.Fatal(err)
	}

	if err := poller.Poll(ctx); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	var sawSession bool
	for _, e := range got {
		if e.SessionID == string(rec.ID) {
			sawSession = true
		}
	}
	if !sawSession {
		t.Fatalf("expected a change_log event for %s to reach the broadcaster, got %d events", rec.ID, len(got))
	}
}

// TestWiring_SessionManagerSharesLifecycleStoreAndLCM verifies that startSession
// constructs an SM whose Store and Lifecycle dependencies are the exact same
// values the LCM holds: a single canonical-store + LCM pair, not two parallel
// stacks that would diverge under concurrent writes. The brief constraint
// forbids modifying session/manager.go to add accessors, so the assertion
// reaches into the unexported fields via reflect + unsafe — scoped to the test
// and isolated in inspectSessionDeps.
func TestWiring_SessionManagerSharesLifecycleStoreAndLCM(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// Registered first so it runs LAST (after the reaper has drained).
	t.Cleanup(func() { _ = store.Close() })

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := config.Config{DataDir: t.TempDir()}

	lcStack, err := startLifecycle(ctx, store, log)
	if err != nil {
		t.Fatal(err)
	}
	// lcStack.Stop blocks on the reaper goroutine, which only exits once its
	// ctx is cancelled. Production main.go calls stop() before lcStack.Stop()
	// for the same reason — same ordering here.
	t.Cleanup(func() {
		cancel()
		lcStack.Stop()
	})

	sStack, err := startSession(ctx, cfg, lcStack, log)
	if err != nil {
		t.Fatal(err)
	}
	if sStack == nil || sStack.SM == nil {
		t.Fatal("startSession returned nil Session Manager")
	}

	gotStore, gotLCM := inspectSessionDeps(t, sStack.SM)

	// Store should be the exact wiring.Adapter the LCM was constructed with.
	gotAdapter, ok := gotStore.(wiring.Adapter)
	if !ok {
		t.Fatalf("SM.store is %T, want wiring.Adapter", gotStore)
	}
	if gotAdapter.Store != lcStack.Adapter.Store {
		t.Fatalf("SM.store wraps a different *sqlite.Store than lcStack.Adapter")
	}

	// Lifecycle should be the exact *lifecycle.Manager pointer from startLifecycle.
	gotLCMPtr, ok := gotLCM.(*lifecycle.Manager)
	if !ok {
		t.Fatalf("SM.lcm is %T, want *lifecycle.Manager", gotLCM)
	}
	if gotLCMPtr != lcStack.LCM {
		t.Fatalf("SM.lcm pointer (%p) differs from lcStack.LCM (%p)", gotLCMPtr, lcStack.LCM)
	}
}

// inspectSessionDeps reads session.Manager's unexported store and lcm fields.
// The brief forbids modifying session/manager.go to expose them; we settle for
// reflect + unsafe scoped to this one test helper. If the field names change
// upstream, the type assertion (and this helper) is the only place to touch.
func inspectSessionDeps(t *testing.T, sm *session.Manager) (store any, lcm any) {
	t.Helper()
	v := reflect.ValueOf(sm).Elem()
	storeField := v.FieldByName("store")
	lcmField := v.FieldByName("lcm")
	if !storeField.IsValid() || !lcmField.IsValid() {
		t.Fatalf("session.Manager fields renamed: store.IsValid=%v lcm.IsValid=%v — update inspectSessionDeps", storeField.IsValid(), lcmField.IsValid())
	}
	storeVal := reflect.NewAt(storeField.Type(), unsafe.Pointer(storeField.UnsafeAddr())).Elem()
	lcmVal := reflect.NewAt(lcmField.Type(), unsafe.Pointer(lcmField.UnsafeAddr())).Elem()
	return storeVal.Interface(), lcmVal.Interface()
}
