// Package triggers turns change events into pipeline runs. It holds the two
// event sources v2 ships: the PR bridge (this file) and the session bridge
// (sessionbridge.go). A trigger names a subject, and the subject is what the
// run is about (spec section 4).
//
// Both bridges share one shape, ported from v1 because it is proven: the CDC
// broadcaster delivers events synchronously on its poller goroutine and must
// not be blocked (cdc.Broadcaster.Subscribe contract), so the subscribe
// callback only filters and enqueues onto a buffered channel, and one owned
// worker goroutine does every store read and every (blocking) engine call.
// Engine methods are therefore only ever called from that worker, never from
// the poller, so the engine actor mailbox cannot deadlock against it.
//
// Both bridges also detect transitions rather than states: a PR that stays
// merge-ready across ten polls fires once, and so does a session that stays
// idle. The bridges hold that memory themselves, in a map owned exclusively by
// the worker goroutine, so neither needs a lock and neither depends on the
// engine deduplicating for it.
//
// The engine seam (Engine, EngineProvider, TriggerRequest) is declared here
// rather than in the engine package: these bridges are the callers, and
// declaring the port next to the caller keeps the dependency pointing one way.
// The engine actor implements it.
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

// queueCap bounds the hand-off buffer between the CDC poller goroutine and a
// bridge worker. PR and session events arrive at poll cadence (100ms, a handful
// of rows), so this is never pressured in practice; an overflow is logged and
// dropped rather than blocking the poller.
//
// ponytail: fixed drop-on-full buffer. Swap for an unbounded queue only if a
// real workload ever overflows it.
const queueCap = 256

// Definitions lists a project's pipeline definitions. Satisfied by
// *storage/sqlite/store.Store.
type Definitions interface {
	ListPipelineDefinitions(ctx context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error)
}

// TriggerRequest is one run a bridge asks the engine to start.
//
// Event is the trigger event as the definition writes it, a pipeline.PREvent or
// a pipeline.SessionEvent. It is a plain string because both families ride this
// one seam, and the engine only records it.
type TriggerRequest struct {
	Definition pipeline.Definition
	Event      string
	Subject    pipeline.Subject
}

// Engine is the subset of the per-project engine actor a bridge drives.
type Engine interface {
	TriggerRun(req TriggerRequest) (pipeline.RunID, error)
}

// EngineProvider resolves (and lazily starts) the engine for a project.
// Satisfied by an adapter over the engine supervisor.
type EngineProvider interface {
	For(ctx context.Context, projectID domain.ProjectID) (Engine, error)
}

// PRReader reads the facts of one exact PR by url: the PR named in a CDC
// payload, not the session's display PR. Satisfied by
// *storage/sqlite/store.Store.
//
// Two reads because neither query is complete on its own: the facts row carries
// fork provenance and the merge-readiness inputs, while the PR row carries the
// repo, the branches, and the session tracking it. Both are primary-key reads
// at PR-event rates, so the cost is noise.
type PRReader interface {
	GetPRFactsByURL(ctx context.Context, url string) (domain.PRFacts, bool, error)
	GetPR(ctx context.Context, url string) (domain.PullRequest, bool, error)
}

// PRConfig constructs a PRBridge. Broadcaster, Defs, PRs, and Engines are
// required; Logger defaults.
type PRConfig struct {
	Broadcaster *cdc.Broadcaster
	Defs        Definitions
	PRs         PRReader
	Engines     EngineProvider
	Logger      *slog.Logger
}

// prSnapshot is the bridge's memory of one PR's last-seen derivation inputs,
// which is what makes merge-ready and merged transitions rather than states.
type prSnapshot struct {
	mergeReady bool
	merged     bool
}

// PRBridge turns CDC PR events into pipeline runs with a PR subject.
type PRBridge struct {
	defs    Definitions
	prs     PRReader
	engines EngineProvider

	broadcaster *cdc.Broadcaster
	log         *slog.Logger

	queue  chan cdc.Event
	unsub  func()
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// prev is owned exclusively by the worker goroutine, so it needs no lock.
	// Keyed by PR url so a stacked-PR session tracks each PR independently.
	prev map[string]prSnapshot
}

// NewPRBridge builds a PRBridge. It does not subscribe or start any goroutine;
// call Start.
func NewPRBridge(cfg PRConfig) *PRBridge {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	return &PRBridge{
		defs:        cfg.Defs,
		prs:         cfg.PRs,
		engines:     cfg.Engines,
		broadcaster: cfg.Broadcaster,
		log:         log,
		queue:       make(chan cdc.Event, queueCap),
		prev:        map[string]prSnapshot{},
	}
}

// Start subscribes to the broadcaster and launches the worker goroutine, which
// runs until Stop (or ctx cancellation).
func (b *PRBridge) Start(ctx context.Context) {
	wctx, cancel := context.WithCancel(ctx)
	b.cancel = cancel
	b.unsub = b.broadcaster.Subscribe(b.enqueue)
	b.wg.Add(1)
	go b.run(wctx)
}

// Stop unsubscribes (no new events), stops the worker, and waits for it to
// finish. Stop on an unstarted bridge is a no-op.
func (b *PRBridge) Stop() {
	if b == nil || b.cancel == nil {
		return
	}
	b.unsub()
	b.cancel()
	b.wg.Wait()
}

// enqueue runs on the poller goroutine, so it must not block: it keeps only PR
// events and hands them to the worker, dropping (with a log) if the buffer is
// somehow full.
func (b *PRBridge) enqueue(e cdc.Event) {
	if e.Type != cdc.EventPRCreated && e.Type != cdc.EventPRUpdated {
		return
	}
	select {
	case b.queue <- e:
	default:
		b.log.Warn("pipeline pr trigger bridge: event queue full, dropping", "seq", e.Seq, "type", e.Type)
	}
}

func (b *PRBridge) run(ctx context.Context) {
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
// needs. Every other fact is re-read from the store by url, so a stale payload
// cannot produce a stale run.
type prPayload struct {
	URL     string `json:"url"`
	Session string `json:"session"`
}

// process handles one PR event on the worker goroutine.
func (b *PRBridge) process(ctx context.Context, e cdc.Event) {
	var p prPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		b.log.Warn("pipeline pr trigger bridge: bad pr payload", "seq", e.Seq, "err", err)
		return
	}
	// No session requirement: a PR subject may have no local session and that is
	// first-class (spec section 4). The project is required, because definitions
	// are per project.
	if p.URL == "" || e.ProjectID == "" {
		return
	}

	facts, ok, err := b.prs.GetPRFactsByURL(ctx, p.URL)
	if err != nil {
		b.log.Warn("pipeline pr trigger bridge: read pr facts", "url", p.URL, "err", err)
		return
	}
	if !ok {
		return
	}
	row, ok, err := b.prs.GetPR(ctx, p.URL)
	if err != nil {
		b.log.Warn("pipeline pr trigger bridge: read pr", "url", p.URL, "err", err)
		return
	}
	if !ok {
		return
	}

	projectID := domain.ProjectID(e.ProjectID)
	defs, err := b.defs.ListPipelineDefinitions(ctx, projectID)
	if err != nil {
		b.log.Warn("pipeline pr trigger bridge: list definitions", "project", projectID, "err", err)
		return
	}
	if len(defs) == 0 {
		return
	}

	events := b.transition(e.Type, p.URL, facts)

	eng, err := b.engines.For(ctx, projectID)
	if err != nil {
		b.log.Warn("pipeline pr trigger bridge: resolve engine", "project", projectID, "err", err)
		return
	}

	session := string(row.SessionID)
	if session == "" {
		session = e.SessionID
	}
	subject := pipeline.Subject{
		Kind:      pipeline.SubjectPR,
		ProjectID: e.ProjectID,
		SessionID: session,
		PR: &pipeline.PRRef{
			Number:     facts.Number,
			Repo:       row.Repo,
			URL:        facts.URL,
			HeadSHA:    facts.HeadSHA,
			HeadBranch: row.SourceBranch,
			BaseBranch: row.TargetBranch,
			FromFork:   fromFork(facts.IsFromFork),
		},
	}

	for _, def := range defs {
		for _, ev := range events {
			if !subscribesPR(def.Config, ev) {
				continue
			}
			if _, err := eng.TriggerRun(TriggerRequest{Definition: def, Event: string(ev), Subject: subject}); err != nil {
				b.log.Warn("pipeline pr trigger bridge: trigger run",
					"pipeline", def.Name, "event", ev, "url", p.URL, "err", err)
			}
		}
	}
}

// transition derives which PR events this change represents and records the new
// snapshot. `created` and `updated` come straight from the CDC event type;
// `merge-ready` and `merged` fire on the transition INTO their state, so a PR
// that holds there does not re-fire on every poll. A PR first seen already in
// the state counts as a transition, so a pipeline armed after the fact still
// runs.
//
// New-SHA cancel-and-rearm is not here: in v2 that is
// `concurrency.cancel-in-progress` on the `updated` trigger, decided by the
// engine's concurrency table, not by the bridge.
func (b *PRBridge) transition(evType cdc.EventType, url string, facts domain.PRFacts) []pipeline.PREvent {
	prev, seen := b.prev[url]
	cur := prSnapshot{mergeReady: isMergeReady(facts), merged: facts.Merged}
	b.prev[url] = cur

	events := make([]pipeline.PREvent, 0, 3)
	if evType == cdc.EventPRCreated {
		events = append(events, pipeline.PREventCreated)
	} else {
		events = append(events, pipeline.PREventUpdated)
	}
	if cur.mergeReady && (!seen || !prev.mergeReady) {
		events = append(events, pipeline.PREventMergeReady)
	}
	if cur.merged && (!seen || !prev.merged) {
		events = append(events, pipeline.PREventMerged)
	}
	return events
}

// isMergeReady ports the v1 derivation as-is: the PR is open, CI is not
// failing, review is approved-or-none, and the PR is mergeable.
func isMergeReady(f domain.PRFacts) bool {
	open := !f.Draft && !f.Merged && !f.Closed
	ciNotFailing := f.CI != domain.CIFailing
	reviewOK := f.Review == domain.ReviewApproved || f.Review == domain.ReviewNone || f.Review == ""
	mergeable := f.Mergeability == domain.MergeMergeable
	return open && ciNotFailing && reviewOK && mergeable
}

// fromFork collapses the tri-state fork provenance for the subject. Unknown
// (nil) is treated as a fork, which is the fail-safe direction: the identity
// only rule then withholds credentials from the run rather than handing them to
// a PR whose provenance nobody established (spec section 8).
func fromFork(v *bool) bool { return v == nil || *v }

// subscribesPR reports whether the pipeline's `on.pr` list contains ev.
func subscribesPR(p pipeline.Pipeline, ev pipeline.PREvent) bool {
	for _, on := range p.On.PR {
		if on == ev {
			return true
		}
	}
	return false
}
