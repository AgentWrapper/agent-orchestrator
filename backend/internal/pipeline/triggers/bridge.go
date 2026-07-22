// Package triggers is the T6 pipeline trigger bridge: it subscribes to the CDC
// event bus, turns PR change events into stage trigger events, and drives the
// per-project pipeline engines to start (or cancel-and-rearm) runs.
//
// The CDC broadcaster delivers events synchronously on its poller goroutine and
// must not be blocked (spec §4b, cdc.Broadcaster.Subscribe contract), so the
// subscribe callback only enqueues; a single owned worker goroutine drains the
// queue and does all store reads and (blocking) engine calls. Engine methods are
// called only from that worker goroutine, never from an ObservationSink or an
// executor, so the engine actor mailbox never deadlocks.
//
// Merge-ready and merged are derived on the TRANSITION into their state, using a
// per-PR previous-state map, matching the old TypeScript lifecycle-status
// decision (a PR first seen already in the state counts as a transition). The
// engine reducer's loop-key guard makes duplicate TRIGGER_FIRED safe, so the
// bridge fires freely and lets the reducer dedup.
package triggers

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/engine"
)

// queueCap bounds the hand-off buffer between the poller goroutine and the
// bridge worker. PR events arrive at SCM-poll cadence (seconds apart), so this
// is never pressured in practice; an overflow is logged and dropped rather than
// blocking the poller.
//
// ponytail: fixed drop-on-full buffer. Swap for an unbounded queue only if a
// real workload ever overflows it (it won't at PR-event rates).
const queueCap = 256

// Definitions lists a project's pipeline definitions. Satisfied by
// *storage/sqlite/store.Store.
type Definitions interface {
	ListPipelineDefinitions(ctx context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error)
}

// PRFactsReader reads the facts of one exact PR by url (the PR named in a CDC
// payload). Satisfied by *storage/sqlite/store.Store.
type PRFactsReader interface {
	GetPRFactsByURL(ctx context.Context, url string) (domain.PRFacts, bool, error)
}

// Engine is the subset of *engine.Engine the bridge drives.
type Engine interface {
	TriggerRun(req engine.TriggerRequest) (pipeline.RunID, error)
	Dispatch(event pipeline.Event)
}

// EngineProvider resolves (and lazily starts) the engine for a project.
// Satisfied by an adapter over *engine.Supervisor.
type EngineProvider interface {
	For(ctx context.Context, projectID domain.ProjectID) (Engine, error)
}

// Config constructs a Bridge. Broadcaster, Defs, PRs, and Engines are required;
// Logger and Clock default.
type Config struct {
	Broadcaster *cdc.Broadcaster
	Defs        Definitions
	PRs         PRFactsReader
	Engines     EngineProvider
	Logger      *slog.Logger
	// Clock stamps the events the bridge dispatches. Defaults to time.Now().UTC.
	Clock func() time.Time
}

// prSnapshot is the bridge's memory of a PR's last-seen derivation inputs, used
// to detect transitions (merge-ready / merged) and head-SHA changes.
type prSnapshot struct {
	mergeReady bool
	merged     bool
	headSHA    string
}

// Bridge subscribes to CDC PR events and triggers pipeline runs.
type Bridge struct {
	broadcaster *cdc.Broadcaster
	defs        Definitions
	prs         PRFactsReader
	engines     EngineProvider
	log         *slog.Logger
	now         func() time.Time

	queue  chan cdc.Event
	unsub  func()
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// prev is owned exclusively by the worker goroutine; no lock needed. Keyed
	// by PR url so a stacked-PR session tracks each PR independently.
	prev map[string]prSnapshot
}

// New builds a Bridge. It does not subscribe or start any goroutine; call Start.
func New(cfg Config) *Bridge {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	clock := cfg.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	return &Bridge{
		broadcaster: cfg.Broadcaster,
		defs:        cfg.Defs,
		prs:         cfg.PRs,
		engines:     cfg.Engines,
		log:         log,
		now:         clock,
		queue:       make(chan cdc.Event, queueCap),
		prev:        map[string]prSnapshot{},
	}
}

// Start subscribes to the broadcaster and launches the worker goroutine. The
// worker runs until Stop (or ctx cancellation).
func (b *Bridge) Start(ctx context.Context) {
	wctx, cancel := context.WithCancel(ctx)
	b.cancel = cancel
	b.unsub = b.broadcaster.Subscribe(b.enqueue)
	b.wg.Add(1)
	go b.run(wctx)
}

// Stop unsubscribes from the broadcaster (no new events), stops the worker, and
// waits for it to drain. Idempotent-safe when Start was called; a nil/unstarted
// Bridge Stop is a no-op.
func (b *Bridge) Stop() {
	if b == nil || b.cancel == nil {
		return
	}
	b.unsub()
	b.cancel()
	b.wg.Wait()
}

// enqueue runs on the poller goroutine: it must not block. It keeps only PR
// events and hands them to the worker via the buffered queue, dropping (with a
// log) if the buffer is somehow full.
func (b *Bridge) enqueue(e cdc.Event) {
	if e.Type != cdc.EventPRCreated && e.Type != cdc.EventPRUpdated {
		return
	}
	select {
	case b.queue <- e:
	default:
		b.log.Warn("pipeline trigger bridge: event queue full, dropping", "seq", e.Seq, "type", e.Type)
	}
}

func (b *Bridge) run(ctx context.Context) {
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

// prPayload is the subset of the CDC pr_created/pr_updated payload the bridge
// needs; the rest of the facts are read authoritatively from the store by url.
type prPayload struct {
	URL     string `json:"url"`
	Session string `json:"session"`
}

func (b *Bridge) process(ctx context.Context, e cdc.Event) {
	var p prPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		b.log.Warn("pipeline trigger bridge: bad pr payload", "seq", e.Seq, "err", err)
		return
	}
	session := e.SessionID
	if session == "" {
		session = p.Session
	}
	if p.URL == "" || session == "" || e.ProjectID == "" {
		return
	}

	facts, ok, err := b.prs.GetPRFactsByURL(ctx, p.URL)
	if err != nil {
		b.log.Warn("pipeline trigger bridge: read pr facts", "url", p.URL, "err", err)
		return
	}
	if !ok {
		return
	}

	projectID := domain.ProjectID(e.ProjectID)
	defs, err := b.defs.ListPipelineDefinitions(ctx, projectID)
	if err != nil {
		b.log.Warn("pipeline trigger bridge: list definitions", "project", projectID, "err", err)
		return
	}
	if len(defs) == 0 {
		return
	}

	eng, err := b.engines.For(ctx, projectID)
	if err != nil {
		b.log.Warn("pipeline trigger bridge: resolve engine", "project", projectID, "err", err)
		return
	}

	prev, seen := b.prev[p.URL]
	cur := prSnapshot{mergeReady: isMergeReady(facts), merged: facts.Merged, headSHA: facts.HeadSHA}

	// Capture PR identity once so every triggered run carries it to its stage
	// executors (agent branch + prompt, command env). Manual runs go through the
	// service path, not the bridge, so this always has real PR facts.
	runCtx := pipeline.RunContext{
		PRNumber:     facts.Number,
		PRURL:        facts.URL,
		SourceBranch: facts.SourceBranch,
		TargetBranch: facts.TargetBranch,
		HeadSHA:      facts.HeadSHA,
		SessionID:    session,
		IsFromFork:   facts.IsFromFork,
	}

	opened := e.Type == cdc.EventPRCreated
	fireOpened := opened
	fireUpdated := !opened
	fireMergeReady := cur.mergeReady && (!seen || !prev.mergeReady)
	fireMerged := cur.merged && (!seen || !prev.merged)
	// A head-SHA change only matters for cancel-and-rearm, which rides the
	// pr.updated trigger. Requires a prior observation with a known SHA.
	shaChanged := seen && prev.headSHA != "" && cur.headSHA != "" && prev.headSHA != cur.headSHA

	for _, def := range defs {
		cfg := def.Config
		cfg.ID = def.ID // the run records the definition it came from

		subsUpdated := defSubscribes(cfg, pipeline.TriggerPRUpdated)
		// New-SHA cancel-and-rearm: terminate the stale in-flight run as outdated
		// and free the loop BEFORE the pr.updated trigger arms a fresh run at the
		// new SHA. Scoped to pr.updated subscribers because the rearm is the
		// pr.updated trigger; the reducer no-ops when no run is in flight.
		if fireUpdated && shaChanged && subsUpdated {
			eng.Dispatch(pipeline.NewSHADetected{Now: b.now(), SessionID: session, PipelineName: cfg.Name, SHA: cur.headSHA, PRURL: runCtx.PRURL})
		}

		b.fireIf(eng, fireOpened && defSubscribes(cfg, pipeline.TriggerPROpened), cfg, runCtx, pipeline.TriggerPROpened)
		b.fireIf(eng, fireUpdated && subsUpdated, cfg, runCtx, pipeline.TriggerPRUpdated)
		b.fireIf(eng, fireMergeReady && defSubscribes(cfg, pipeline.TriggerPRMergeReady), cfg, runCtx, pipeline.TriggerPRMergeReady)
		b.fireIf(eng, fireMerged && defSubscribes(cfg, pipeline.TriggerPRMerged), cfg, runCtx, pipeline.TriggerPRMerged)
	}

	b.prev[p.URL] = cur
}

func (b *Bridge) fireIf(eng Engine, cond bool, cfg pipeline.Pipeline, runCtx pipeline.RunContext, ev pipeline.StageTriggerEvent) {
	if !cond {
		return
	}
	if _, err := eng.TriggerRun(engine.TriggerRequest{
		Pipeline:  cfg,
		SessionID: runCtx.SessionID,
		Trigger:   ev,
		HeadSHA:   runCtx.HeadSHA,
		Context:   runCtx,
	}); err != nil {
		b.log.Warn("pipeline trigger bridge: trigger run", "pipeline", cfg.Name, "trigger", ev, "session", runCtx.SessionID, "err", err)
	}
}

// isMergeReady ports the old lifecycle-status-decisions.ts merge_ready shape
// (spec §4b): the PR is open, CI is not failing, review is approved-or-none, and
// the PR is mergeable.
func isMergeReady(f domain.PRFacts) bool {
	open := !f.Draft && !f.Merged && !f.Closed
	ciNotFailing := f.CI != domain.CIFailing
	reviewOK := f.Review == domain.ReviewApproved || f.Review == domain.ReviewNone || f.Review == ""
	mergeable := f.Mergeability == domain.MergeMergeable
	return open && ciNotFailing && reviewOK && mergeable
}

// defSubscribes reports whether any stage of the pipeline lists ev in its
// trigger.on set.
func defSubscribes(p pipeline.Pipeline, ev pipeline.StageTriggerEvent) bool {
	for _, s := range p.Stages {
		for _, on := range s.Trigger.On {
			if on == ev {
				return true
			}
		}
	}
	return false
}
