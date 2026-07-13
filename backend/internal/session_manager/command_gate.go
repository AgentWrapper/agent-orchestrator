package sessionmanager

import (
	"context"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// commandGate serializes the mutating lifecycle commands of ONE session — kill,
// retire-for-replacement, restore, switch — and records terminal intent so a
// command admitted before a kill can never complete a resurrection afterwards.
//
// It gives two guarantees, and both are needed:
//
//  1. Mutual exclusion. A command holds the session's slot across its whole
//     read → validate → launch → completion-write sequence, so a kill can no
//     longer slip between a switch/restore's preflight and its MarkSwitched /
//     MarkSpawned write (which unconditionally clear IsTerminated). Because Kill
//     re-reads the session row after it acquires the slot, a kill that lands
//     behind a completed relaunch tears down the runtime that relaunch just
//     created: no runtime outlives the kill.
//
//  2. Terminal generation. A ticket captures the session's terminal generation
//     when the command is ADMITTED — before it queues for the slot. Kill and
//     retire bump that generation on every one of their return paths, while they
//     still hold the slot, so the bump records ACCEPTED terminal intent rather
//     than a successful teardown: a kill that preserves a dirty workspace, a
//     retire that finds the row already terminated, and a teardown that fails
//     partway all count. A relaunching command (restore/switch) whose captured
//     generation is stale therefore knows the session was killed while it
//     waited, and aborts instead of reviving the row. Kill wins.
//
// A slot lives only while at least one command holds or awaits it, so the map
// stays bounded by in-flight commands; the generation is dropped only when no
// command can still observe it.
type commandGate struct {
	mu    sync.Mutex
	slots map[domain.SessionID]*commandSlot
}

// commandSlot is one session's command mutex plus its terminal generation.
type commandSlot struct {
	// sem is a one-token semaphore rather than a sync.Mutex so acquisition can
	// honor context cancellation: a wedged relaunch must not hang a kill forever.
	sem  chan struct{}
	refs int
	gen  uint64
}

// commandTicket is a held slot. Release it exactly once (defer it).
type commandTicket struct {
	gate     *commandGate
	id       domain.SessionID
	slot     *commandSlot
	entryGen uint64
	released bool
}

func newCommandGate() *commandGate {
	return &commandGate{slots: map[domain.SessionID]*commandSlot{}}
}

// begin admits a command for id — capturing the terminal generation at
// admission — and blocks until the session's command slot is free or ctx ends.
func (g *commandGate) begin(ctx context.Context, id domain.SessionID) (*commandTicket, error) {
	g.mu.Lock()
	slot, ok := g.slots[id]
	if !ok {
		slot = &commandSlot{sem: make(chan struct{}, 1)}
		g.slots[id] = slot
	}
	slot.refs++
	entryGen := slot.gen
	g.mu.Unlock()

	select {
	case slot.sem <- struct{}{}:
		return &commandTicket{gate: g, id: id, slot: slot, entryGen: entryGen}, nil
	case <-ctx.Done():
		g.drop(id, slot)
		return nil, ctx.Err()
	}
}

// drop releases one reference on the slot, forgetting it once no command holds
// or awaits it.
func (g *commandGate) drop(id domain.SessionID, slot *commandSlot) {
	g.mu.Lock()
	defer g.mu.Unlock()
	slot.refs--
	if slot.refs <= 0 && g.slots[id] == slot {
		delete(g.slots, id)
	}
}

// markTerminal records terminal intent for a session. The caller must hold the
// session's slot, which is what keeps the bump ordered against every other
// command's completion write.
func (g *commandGate) markTerminal(id domain.SessionID) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if slot, ok := g.slots[id]; ok {
		slot.gen++
	}
}

// terminalIntentChanged reports whether the session was killed or retired after
// this command was admitted. A relaunching command must abort when it is true.
func (t *commandTicket) terminalIntentChanged() bool {
	t.gate.mu.Lock()
	defer t.gate.mu.Unlock()
	return t.slot.gen != t.entryGen
}

// release hands the slot to the next queued command. Idempotent.
func (t *commandTicket) release() {
	if t.released {
		return
	}
	t.released = true
	<-t.slot.sem
	t.gate.drop(t.id, t.slot)
}
