package triggers

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// fakeSpawnCheck is the loop guard: the ids it holds are pipeline-spawned.
type fakeSpawnCheck struct {
	spawned map[domain.SessionID]bool
	err     error
	calls   int
}

func (f *fakeSpawnCheck) IsPipelineSpawned(_ context.Context, id domain.SessionID) (bool, error) {
	f.calls++
	if f.err != nil {
		return false, f.err
	}
	return f.spawned[id], nil
}

func sessionEventCDC(id string, state domain.ActivityState) cdc.Event {
	payload, _ := json.Marshal(sessionPayload{ID: id, Activity: string(state)})
	return cdc.Event{Seq: 1, ProjectID: testProject, SessionID: id, Type: cdc.EventSessionUpdated, Payload: payload}
}

func newSessionBridge(defs []pipeline.Definition, guard *fakeSpawnCheck) (*SessionBridge, *fakeEngine) {
	eng := &fakeEngine{}
	log, _ := logSink()
	b := NewSessionBridge(SessionConfig{
		Broadcaster: cdc.NewBroadcaster(),
		Defs:        &fakeDefs{byProject: map[domain.ProjectID][]pipeline.Definition{testProject: defs}},
		Engines:     fakeProvider{eng: eng},
		Spawned:     guard,
		Logger:      log,
	})
	return b, eng
}

func openGuard() *fakeSpawnCheck {
	return &fakeSpawnCheck{spawned: map[domain.SessionID]bool{}}
}

// ---------------------------------------------------------------------------
// Transition detection
// ---------------------------------------------------------------------------

func TestSessionIdleFiresOncePerTransition(t *testing.T) {
	ctx := context.Background()
	b, eng := newSessionBridge([]pipeline.Definition{sessionDefOn("onIdle", pipeline.SessionEventIdle)}, openGuard())

	// First sighting: active, no trigger event, and nothing fires.
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityActive))
	// Transition into idle fires once.
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))
	// session_updated also fires on renames and preview changes, so the same
	// idle reading arrives again and again. It must not re-trigger.
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))

	if got := eng.count(string(pipeline.SessionEventIdle)); got != 1 {
		t.Fatalf("idle triggers = %d, want exactly 1 (transition only)", got)
	}
}

func TestSessionIdleRefiresAfterGoingActive(t *testing.T) {
	ctx := context.Background()
	b, eng := newSessionBridge([]pipeline.Definition{sessionDefOn("onIdle", pipeline.SessionEventIdle)}, openGuard())

	b.process(ctx, sessionEventCDC(testSession, domain.ActivityActive))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityActive))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))

	if got := eng.count(string(pipeline.SessionEventIdle)); got != 2 {
		t.Fatalf("idle triggers = %d, want 2 (one per transition)", got)
	}
}

func TestSessionFirstSightingDoesNotFire(t *testing.T) {
	// The bridge only knows a transition happened when it saw the previous
	// state. Firing on a first sighting would turn any post-restart session
	// update (a rename, an `ao preview`) into a spurious run, so the first
	// sighting only seeds the map.
	ctx := context.Background()
	b, eng := newSessionBridge([]pipeline.Definition{sessionDefOn("onIdle", pipeline.SessionEventIdle)}, openGuard())

	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))

	if got := len(eng.all()); got != 0 {
		t.Fatalf("triggers = %d, want 0 on a first sighting", got)
	}
}

func TestSessionExitedAndBlockedMap(t *testing.T) {
	ctx := context.Background()
	def := sessionDefOn("all", pipeline.SessionEventIdle, pipeline.SessionEventExited, pipeline.SessionEventBlocked)
	b, eng := newSessionBridge([]pipeline.Definition{def}, openGuard())

	b.process(ctx, sessionEventCDC("s-blocked", domain.ActivityActive))
	b.process(ctx, sessionEventCDC("s-blocked", domain.ActivityBlocked))
	b.process(ctx, sessionEventCDC("s-exited", domain.ActivityActive))
	b.process(ctx, sessionEventCDC("s-exited", domain.ActivityExited))

	if got := eng.count(string(pipeline.SessionEventBlocked)); got != 1 {
		t.Fatalf("blocked triggers = %d, want 1", got)
	}
	if got := eng.count(string(pipeline.SessionEventExited)); got != 1 {
		t.Fatalf("exited triggers = %d, want 1", got)
	}
	if got := eng.count(string(pipeline.SessionEventIdle)); got != 0 {
		t.Fatalf("idle triggers = %d, want 0", got)
	}
}

func TestSessionNonTriggerStatesDoNotFire(t *testing.T) {
	// waiting_input is a real activity state with no trigger in spec section 4.
	ctx := context.Background()
	def := sessionDefOn("all", pipeline.SessionEventIdle, pipeline.SessionEventExited, pipeline.SessionEventBlocked)
	b, eng := newSessionBridge([]pipeline.Definition{def}, openGuard())

	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityWaitingInput))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityActive))

	if got := len(eng.all()); got != 0 {
		t.Fatalf("triggers = %d, want 0", got)
	}
}

func TestSessionTriggerCarriesSessionSubject(t *testing.T) {
	ctx := context.Background()
	def := sessionDefOn("onIdle", pipeline.SessionEventIdle)
	b, eng := newSessionBridge([]pipeline.Definition{def}, openGuard())

	b.process(ctx, sessionEventCDC(testSession, domain.ActivityActive))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))

	reqs := eng.all()
	if len(reqs) != 1 {
		t.Fatalf("triggers = %d, want 1", len(reqs))
	}
	req := reqs[0]
	if req.Definition.ID != def.ID || req.Event != string(pipeline.SessionEventIdle) {
		t.Fatalf("request = %+v", req)
	}
	want := pipeline.Subject{Kind: pipeline.SubjectSession, ProjectID: testProject, SessionID: testSession}
	if req.Subject != want {
		t.Fatalf("subject = %+v, want %+v", req.Subject, want)
	}
}

func TestSessionFanOutAcrossDefinitions(t *testing.T) {
	ctx := context.Background()
	b, eng := newSessionBridge([]pipeline.Definition{
		sessionDefOn("a", pipeline.SessionEventIdle),
		sessionDefOn("b", pipeline.SessionEventIdle, pipeline.SessionEventExited),
		sessionDefOn("c", pipeline.SessionEventExited),
		prDefOn("pronly", pipeline.PREventUpdated),
	}, openGuard())

	b.process(ctx, sessionEventCDC(testSession, domain.ActivityActive))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))

	if got := len(eng.all()); got != 2 {
		t.Fatalf("triggers = %d, want 2 (a and b)", got)
	}
	if got := eng.countFor("a", string(pipeline.SessionEventIdle)); got != 1 {
		t.Fatalf("a idle = %d, want 1", got)
	}
	if got := eng.countFor("b", string(pipeline.SessionEventIdle)); got != 1 {
		t.Fatalf("b idle = %d, want 1", got)
	}
}

// ---------------------------------------------------------------------------
// Loop guard
// ---------------------------------------------------------------------------

func TestPipelineSpawnedSessionsAreIgnored(t *testing.T) {
	// A pipeline agent going idle must not fire session pipelines, or every run
	// spawns the next one forever.
	ctx := context.Background()
	guard := openGuard()
	guard.spawned["s-pipeline"] = true
	b, eng := newSessionBridge([]pipeline.Definition{sessionDefOn("onIdle", pipeline.SessionEventIdle)}, guard)

	b.process(ctx, sessionEventCDC("s-pipeline", domain.ActivityActive))
	b.process(ctx, sessionEventCDC("s-pipeline", domain.ActivityIdle))
	b.process(ctx, sessionEventCDC("s-human", domain.ActivityActive))
	b.process(ctx, sessionEventCDC("s-human", domain.ActivityIdle))

	reqs := eng.all()
	if len(reqs) != 1 {
		t.Fatalf("triggers = %d, want 1 (the human session only)", len(reqs))
	}
	if reqs[0].Subject.SessionID != "s-human" {
		t.Fatalf("triggered for %q, want s-human", reqs[0].Subject.SessionID)
	}
}

func TestSessionGuardErrorSkipsTheSession(t *testing.T) {
	// Unknown provenance fails safe: no run rather than a possible loop.
	ctx := context.Background()
	guard := openGuard()
	guard.err = errors.New("store down")
	b, eng := newSessionBridge([]pipeline.Definition{sessionDefOn("onIdle", pipeline.SessionEventIdle)}, guard)

	b.process(ctx, sessionEventCDC(testSession, domain.ActivityActive))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))

	if got := len(eng.all()); got != 0 {
		t.Fatalf("triggers = %d, want 0 when the loop guard cannot answer", got)
	}
}

func TestSessionBridgeRefusesToStartWithoutLoopGuard(t *testing.T) {
	bcast := cdc.NewBroadcaster()
	log, buf := logSink()
	b := NewSessionBridge(SessionConfig{
		Broadcaster: bcast,
		Defs:        &fakeDefs{},
		Engines:     fakeProvider{eng: &fakeEngine{}},
		Logger:      log,
	})

	b.Start(context.Background())
	t.Cleanup(b.Stop)

	if got := bcast.SubscriberCount(); got != 0 {
		t.Fatalf("subscribers = %d, want 0 without a loop guard", got)
	}
	if !strings.Contains(buf.String(), "loop guard") {
		t.Fatalf("refusal was not logged: %s", buf.String())
	}
}

func TestSessionGuardNotConsultedWhenNoDefinitionSubscribes(t *testing.T) {
	// The guard is a store read per event, so it only runs once a definition
	// actually wants this event.
	ctx := context.Background()
	guard := openGuard()
	b, _ := newSessionBridge([]pipeline.Definition{sessionDefOn("onExit", pipeline.SessionEventExited)}, guard)

	b.process(ctx, sessionEventCDC(testSession, domain.ActivityActive))
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))

	if guard.calls != 0 {
		t.Fatalf("loop guard calls = %d, want 0", guard.calls)
	}
}

// ---------------------------------------------------------------------------
// Queue discipline
// ---------------------------------------------------------------------------

func TestSessionEnqueueIgnoresOtherEventTypes(t *testing.T) {
	b, _ := newSessionBridge([]pipeline.Definition{sessionDefOn("onIdle", pipeline.SessionEventIdle)}, openGuard())

	b.enqueue(cdc.Event{Type: cdc.EventPRUpdated, ProjectID: testProject})
	b.enqueue(cdc.Event{Type: cdc.EventSessionCreated, ProjectID: testProject})

	if got := len(b.queue); got != 0 {
		t.Fatalf("queued = %d, want 0 for non session_updated events", got)
	}
}

func TestSessionEnqueueDropsWhenQueueFull(t *testing.T) {
	log, buf := logSink()
	b := NewSessionBridge(SessionConfig{
		Broadcaster: cdc.NewBroadcaster(),
		Defs:        &fakeDefs{},
		Engines:     fakeProvider{eng: &fakeEngine{}},
		Spawned:     openGuard(),
		Logger:      log,
	})

	for i := 0; i < queueCap+5; i++ {
		b.enqueue(sessionEventCDC(testSession, domain.ActivityIdle))
	}

	if got := len(b.queue); got != queueCap {
		t.Fatalf("queued = %d, want %d (buffer cap)", got, queueCap)
	}
	if !strings.Contains(buf.String(), "dropping") {
		t.Fatalf("overflow was not logged: %s", buf.String())
	}
}

func TestSessionBridgeDeliversThroughBroadcaster(t *testing.T) {
	bcast := cdc.NewBroadcaster()
	eng := &fakeEngine{}
	b := NewSessionBridge(SessionConfig{
		Broadcaster: bcast,
		Defs:        &fakeDefs{byProject: map[domain.ProjectID][]pipeline.Definition{testProject: {sessionDefOn("onIdle", pipeline.SessionEventIdle)}}},
		Engines:     fakeProvider{eng: eng},
		Spawned:     openGuard(),
	})
	b.Start(context.Background())
	t.Cleanup(b.Stop)

	bcast.Publish(sessionEventCDC(testSession, domain.ActivityActive))
	bcast.Publish(sessionEventCDC(testSession, domain.ActivityIdle))

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if eng.count(string(pipeline.SessionEventIdle)) == 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("idle trigger not observed within the deadline (async delivery failed)")
}

func TestSessionProcessIgnoresIncompleteEvents(t *testing.T) {
	ctx := context.Background()
	b, eng := newSessionBridge([]pipeline.Definition{sessionDefOn("onIdle", pipeline.SessionEventIdle)}, openGuard())

	noProject := sessionEventCDC(testSession, domain.ActivityIdle)
	noProject.ProjectID = ""
	b.process(ctx, noProject)

	badPayload := sessionEventCDC(testSession, domain.ActivityIdle)
	badPayload.Payload = []byte("not json")
	b.process(ctx, badPayload)

	noID := cdc.Event{Seq: 2, ProjectID: testProject, Type: cdc.EventSessionUpdated, Payload: []byte(`{"activity":"idle"}`)}
	b.process(ctx, noID)

	// None of the above may have seeded prev either, so a real transition still
	// needs its own first sighting.
	b.process(ctx, sessionEventCDC(testSession, domain.ActivityIdle))

	if got := len(eng.all()); got != 0 {
		t.Fatalf("triggers = %d, want 0", got)
	}
}

func TestSessionStopWithoutStartIsSafe(t *testing.T) {
	b, _ := newSessionBridge([]pipeline.Definition{sessionDefOn("onIdle", pipeline.SessionEventIdle)}, openGuard())
	b.Stop()
}
