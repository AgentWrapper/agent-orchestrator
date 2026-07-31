package triggers

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// SessionSpawnCheck reports whether a session was itself spawned by a pipeline
// run. It is the loop guard, and it is why the session bridge is not a footgun:
// without it, a pipeline agent going idle fires the session pipelines, whose
// agents go idle, forever.
//
// The real implementation reads the PipelineRunID marker written onto session
// metadata at spawn time. That marker lands with the orphan/pipeline session
// metadata work, so this narrow port exists to be implemented then; until it is
// wired, the bridge refuses to start (see Start).
type SessionSpawnCheck interface {
	IsPipelineSpawned(ctx context.Context, sessionID domain.SessionID) (bool, error)
}

// SessionConfig constructs a SessionBridge. Broadcaster, Defs, Engines, and
// Spawned are required; Logger defaults.
type SessionConfig struct {
	Broadcaster *cdc.Broadcaster
	Defs        Definitions
	Engines     EngineProvider
	// Spawned is the loop guard. It is required: a bridge without one does not
	// subscribe at all, because firing session pipelines off pipeline-spawned
	// sessions is worse than firing none.
	Spawned SessionSpawnCheck
	Logger  *slog.Logger
}

// SessionBridge turns CDC session activity changes into pipeline runs with a
// session subject.
type SessionBridge struct {
	defs    Definitions
	engines EngineProvider
	spawned SessionSpawnCheck

	broadcaster *cdc.Broadcaster
	log         *slog.Logger

	queue  chan cdc.Event
	unsub  func()
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// prev is the last activity state seen per session, owned exclusively by the
	// worker goroutine so it needs no lock. It is what makes idle a transition
	// rather than a state: session_updated also fires on renames and preview
	// changes, so the same idle reading arrives repeatedly.
	prev map[string]domain.ActivityState
}

// NewSessionBridge builds a SessionBridge. It does not subscribe or start any
// goroutine; call Start.
func NewSessionBridge(cfg SessionConfig) *SessionBridge {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	return &SessionBridge{
		defs:        cfg.Defs,
		engines:     cfg.Engines,
		spawned:     cfg.Spawned,
		broadcaster: cfg.Broadcaster,
		log:         log,
		queue:       make(chan cdc.Event, queueCap),
		prev:        map[string]domain.ActivityState{},
	}
}

// Start subscribes to the broadcaster and launches the worker goroutine, which
// runs until Stop (or ctx cancellation).
//
// With no loop guard configured, Start logs and does nothing: an inert bridge
// beats one that can start an unbounded chain of runs.
func (b *SessionBridge) Start(ctx context.Context) {
	if b.spawned == nil {
		b.log.Error("pipeline session trigger bridge: no loop guard configured, session triggers disabled")
		return
	}
	wctx, cancel := context.WithCancel(ctx)
	b.cancel = cancel
	b.unsub = b.broadcaster.Subscribe(b.enqueue)
	b.wg.Add(1)
	go b.run(wctx)
}

// Stop unsubscribes (no new events), stops the worker, and waits for it to
// finish. Stop on an unstarted bridge is a no-op.
func (b *SessionBridge) Stop() {
	if b == nil || b.cancel == nil {
		return
	}
	b.unsub()
	b.cancel()
	b.wg.Wait()
}

// enqueue runs on the poller goroutine, so it must not block: it keeps only
// session updates and hands them to the worker, dropping (with a log) if the
// buffer is somehow full.
//
// Only session_updated, never session_created: a brand new session has no
// previous state, so it cannot yet be a transition.
func (b *SessionBridge) enqueue(e cdc.Event) {
	if e.Type != cdc.EventSessionUpdated {
		return
	}
	select {
	case b.queue <- e:
	default:
		b.log.Warn("pipeline session trigger bridge: event queue full, dropping", "seq", e.Seq, "session", e.SessionID)
	}
}

func (b *SessionBridge) run(ctx context.Context) {
	defer b.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case e := <-b.queue:
			b.process(ctx, e)
		}
	}
}

// sessionPayload is the subset of the CDC session_updated payload the bridge
// needs. The activity state is the payload's own reading, which is the value
// the change was captured for.
type sessionPayload struct {
	ID       string `json:"id"`
	Activity string `json:"activity"`
}

// process handles one session update on the worker goroutine.
func (b *SessionBridge) process(ctx context.Context, e cdc.Event) {
	var p sessionPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		b.log.Warn("pipeline session trigger bridge: bad session payload", "seq", e.Seq, "err", err)
		return
	}
	sessionID := e.SessionID
	if sessionID == "" {
		sessionID = p.ID
	}
	if sessionID == "" || e.ProjectID == "" {
		return
	}

	ev, ok := b.transition(sessionID, domain.ActivityState(p.Activity))
	if !ok {
		return
	}

	projectID := domain.ProjectID(e.ProjectID)
	defs, err := b.defs.ListPipelineDefinitions(ctx, projectID)
	if err != nil {
		b.log.Warn("pipeline session trigger bridge: list definitions", "project", projectID, "err", err)
		return
	}
	matching := make([]pipeline.Definition, 0, len(defs))
	for _, def := range defs {
		if subscribesSession(def.Config, ev) {
			matching = append(matching, def)
		}
	}
	if len(matching) == 0 {
		return
	}

	// The loop guard costs a read, so it runs only once a definition actually
	// wants this event. An unanswerable guard skips the session: no run is the
	// fail-safe answer when provenance is unknown.
	spawned, err := b.spawned.IsPipelineSpawned(ctx, domain.SessionID(sessionID))
	if err != nil {
		b.log.Warn("pipeline session trigger bridge: loop guard read failed, skipping session",
			"session", sessionID, "err", err)
		return
	}
	if spawned {
		b.log.Debug("pipeline session trigger bridge: ignoring pipeline-spawned session",
			"session", sessionID, "event", ev)
		return
	}

	eng, err := b.engines.For(ctx, projectID)
	if err != nil {
		b.log.Warn("pipeline session trigger bridge: resolve engine", "project", projectID, "err", err)
		return
	}

	subject := pipeline.Subject{
		Kind:      pipeline.SubjectSession,
		ProjectID: e.ProjectID,
		SessionID: sessionID,
	}
	for _, def := range matching {
		if _, err := eng.TriggerRun(TriggerRequest{Definition: def, Event: string(ev), Subject: subject}); err != nil {
			b.log.Warn("pipeline session trigger bridge: trigger run",
				"pipeline", def.Name, "event", ev, "session", sessionID, "err", err)
		}
	}
}

// transition records the new activity state and reports the trigger event this
// change represents, if any. It fires only when the state actually changed and
// the new state is one of the three the spec names, so a session holding at idle
// fires once and not on every subsequent update.
//
// A first sighting never fires: the bridge has not observed a transition, only
// a state. That matters after a daemon restart, where the first update for an
// already-idle session is usually a rename or an `ao preview`, and firing there
// would start a run nothing asked for. The cost is that a session already idle
// when the bridge starts waits for its next real transition.
func (b *SessionBridge) transition(sessionID string, cur domain.ActivityState) (pipeline.SessionEvent, bool) {
	prev, seen := b.prev[sessionID]
	b.prev[sessionID] = cur
	if !seen || prev == cur {
		return "", false
	}
	return sessionEventFor(cur)
}

// sessionEventFor maps an activity state onto its trigger event. Only the three
// states spec section 4 names have one: active is the absence of an event, and
// waiting_input deliberately has none, so an agent parked at an empty prompt
// does not start pipelines behind the user.
func sessionEventFor(s domain.ActivityState) (pipeline.SessionEvent, bool) {
	switch s {
	case domain.ActivityIdle:
		return pipeline.SessionEventIdle, true
	case domain.ActivityExited:
		return pipeline.SessionEventExited, true
	case domain.ActivityBlocked:
		return pipeline.SessionEventBlocked, true
	default:
		return "", false
	}
}

// subscribesSession reports whether the pipeline's `on.session` list contains
// ev.
func subscribesSession(p pipeline.Pipeline, ev pipeline.SessionEvent) bool {
	for _, on := range p.On.Session {
		if on == ev {
			return true
		}
	}
	return false
}
