// This file bounds the sessions a pipeline keeps alive.
//
// Kept-alive is the common case on agent failure (no_output, no_signal and
// timed_out all spare the session so a human can see what the agent was doing),
// so without a bound the feature reproduces the exact fifty-stale-worktrees mess
// v2 exists to fix. Two bounds, neither of them reap-on-run-settle: the run
// settles seconds after the stage does, which would kill the session before
// anyone could look at it (spec section 7.3).
//
//   - Cap: 3 kept sessions per pipeline, least recently kept evicted.
//   - TTL: 24h, swept from the supervisor's ticker.
//
// Both are fixed constants (decision D7). The ledger the bounds are computed
// from is the persisted marker on the session rows, not in-process state, so a
// daemon restart does not forget the sessions it is supposed to reap.
package engine

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// The reaper's bounds. Fixed, not configurable (decision D7): configurability is
// a later knob if dogfooding asks for it.
const (
	// MaxOrphanedSessionsPerPipeline is how many kept-alive sessions one pipeline
	// may hold at once. A further keep evicts the least recently kept.
	MaxOrphanedSessionsPerPipeline = 3
	// OrphanTTL is how long a kept-alive session survives before the sweep kills
	// it. This is the bound on the slow leak.
	OrphanTTL = 24 * time.Hour
)

// OrphanSessions is the session-store surface the registry needs: write the
// marker, and read back every session so the cap and the TTL can be computed
// from what is actually persisted. *storage/sqlite/store.Store satisfies it.
type OrphanSessions interface {
	SetSessionPipelineOrphan(ctx context.Context, id domain.SessionID, info *domain.PipelineOrphanInfo, updatedAt time.Time) (bool, error)
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
}

// OrphanRegistry marks the sessions a pipeline kept alive and enforces the two
// bounds on them. Safe for concurrent use: every project's engine shares one.
type OrphanRegistry struct {
	sessions OrphanSessions
	killer   SessionDisposer
	log      *slog.Logger

	// mu serializes the read-then-kill cycles, so two engines keeping a session
	// at the same moment cannot both decide to evict the same one. Kills run
	// under it: Keep is already synchronous on the calling engine's actor, and
	// the only cross-project cost is a short wait.
	mu sync.Mutex
}

// NewOrphanRegistry builds the registry over the session store and the killer.
// A nil registry is legal everywhere and simply keeps every session forever,
// which is what an engine wired without a session store gets.
func NewOrphanRegistry(sessions OrphanSessions, killer SessionDisposer, log *slog.Logger) *OrphanRegistry {
	if log == nil {
		log = slog.Default()
	}
	return &OrphanRegistry{sessions: sessions, killer: killer, log: log}
}

// orphanKey is the cap's grouping key: one budget per pipeline per project, so
// two projects that both define a `pr-review` pipeline do not share three slots.
// The engine builds it from its own project id and the run's pipeline name; the
// registry rebuilds the same key from the persisted marker.
func orphanKey(projectID, pipeline string) string { return projectID + "/" + pipeline }

// Keep marks the session pipeline-orphaned and enforces the cap for its
// pipeline, killing the least recently kept session when the keep pushes the
// pipeline over MaxOrphanedSessionsPerPipeline.
//
// key is the grouping key from orphanKey; info is what the session list renders.
// Failures are logged, never returned: a stage has already settled by the time
// this runs, and the run must not be held up by a session-list side effect.
func (r *OrphanRegistry) Keep(ctx context.Context, key string, info domain.PipelineOrphanInfo, sessionID string) {
	if r == nil || sessionID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	marked, err := r.sessions.SetSessionPipelineOrphan(ctx, domain.SessionID(sessionID), &info, info.KeptAt)
	switch {
	case err != nil:
		r.log.Warn("pipeline orphan marker not written", "session", sessionID, "run", info.RunID, "err", err)
	case !marked:
		r.log.Warn("pipeline orphan marker skipped: session row is gone", "session", sessionID, "run", info.RunID)
	default:
		r.log.Info("pipeline session kept alive",
			"session", sessionID, "run", info.RunID, "stage", info.Stage, "outcome", info.Outcome)
	}

	kept := r.ledger(ctx)
	mine := make([]keptSession, 0, len(kept))
	for _, k := range kept {
		if k.key == key {
			mine = append(mine, k)
		}
	}
	for len(mine) > MaxOrphanedSessionsPerPipeline {
		evicted := mine[0]
		mine = mine[1:]
		r.log.Info("pipeline orphan evicted: pipeline is over its kept-session cap",
			"session", evicted.sessionID, "pipeline", key, "cap", MaxOrphanedSessionsPerPipeline)
		r.kill(ctx, evicted.sessionID)
	}
}

// Sweep kills every kept session past OrphanTTL. It runs from the supervisor's
// ticker, so the bound holds for sessions this process never kept itself.
func (r *OrphanRegistry) Sweep(ctx context.Context, now time.Time) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	cutoff := now.Add(-OrphanTTL)
	for _, kept := range r.ledger(ctx) {
		// A marker with no timestamp cannot be aged, and killing a session on a
		// fact we do not have is the wrong direction: the cap still bounds it.
		if kept.keptAt.IsZero() || kept.keptAt.After(cutoff) {
			continue
		}
		r.log.Info("pipeline orphan reaped: past its 24h TTL",
			"session", kept.sessionID, "pipeline", kept.key, "keptAt", kept.keptAt)
		r.kill(ctx, kept.sessionID)
	}
}

// keptSession is one row of the ledger.
type keptSession struct {
	sessionID string
	key       string
	keptAt    time.Time
}

// ledger reads the currently kept sessions, oldest keep first. Terminated rows
// are not kept sessions: a session killed by hand, by an eviction or by a
// previous sweep has already left, and counting it would evict a live session in
// its place. An unreadable store yields no ledger, which kills nothing.
func (r *OrphanRegistry) ledger(ctx context.Context) []keptSession {
	rows, err := r.sessions.ListAllSessions(ctx)
	if err != nil {
		r.log.Warn("pipeline orphan ledger unreadable, bounds not enforced this pass", "err", err)
		return nil
	}
	out := make([]keptSession, 0, len(rows))
	for _, rec := range rows {
		if rec.IsTerminated || rec.Metadata.PipelineOrphan == nil {
			continue
		}
		marker := rec.Metadata.PipelineOrphan
		out = append(out, keptSession{
			sessionID: string(rec.ID),
			key:       orphanKey(string(rec.ProjectID), marker.Pipeline),
			keptAt:    marker.KeptAt,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].keptAt.Equal(out[j].keptAt) {
			return out[i].sessionID < out[j].sessionID
		}
		return out[i].keptAt.Before(out[j].keptAt)
	})
	return out
}

// kill tears a reaped session down. Best-effort: a session already gone is not
// an error, and a failure here must not stop the rest of the sweep.
func (r *OrphanRegistry) kill(ctx context.Context, sessionID string) {
	if r.killer == nil {
		r.log.Warn("pipeline orphan not killed: no session seam wired", "session", sessionID)
		return
	}
	if err := r.killer.Kill(ctx, sessionID); err != nil {
		r.log.Warn("pipeline orphan kill", "session", sessionID, "err", err)
	}
}
