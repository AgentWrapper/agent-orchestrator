// Package drain implements the fleet-pause drain sweep. On a paused project it
// terminates workers as they reach a terminal/idle state, leaving mid-flight
// work untouched, and emits a telemetry signal when a project finishes
// draining. It deliberately lives outside the reaper (which is fact-only by
// contract) and drives termination through the session service's clean Kill
// path, so no zombie tmux is left behind.
package drain

import (
	"context"
	"log/slog"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

// DefaultTickInterval matches the reaper cadence: the drain sweep is a
// liveness-driven follow-up to reaping, so the same 5s beat is appropriate.
const DefaultTickInterval = 5 * time.Second

// Store is the durable read surface the sweeper needs.
type Store interface {
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
	GetFleetPaused(ctx context.Context) (bool, error)
}

// Sessions is the session-service surface: the drain-aware read model (for the
// derived per-session Status) and the clean Kill path.
type Sessions interface {
	List(ctx context.Context, filter sessionsvc.ListFilter) ([]domain.Session, error)
	Kill(ctx context.Context, id domain.SessionID) (bool, error)
}

// Sweeper terminates drainable workers of paused projects and signals when a
// project finishes draining.
type Sweeper struct {
	store     Store
	sessions  Sessions
	telemetry ports.EventSink
	logger    *slog.Logger
	clock     func() time.Time
	tick      time.Duration
	// hadLive tracks paused projects observed with live workers, so the
	// drain-complete signal fires exactly once on the transition to zero.
	hadLive map[domain.ProjectID]bool
}

// Config carries optional collaborators.
type Config struct {
	Telemetry ports.EventSink
	Logger    *slog.Logger
	Clock     func() time.Time
	Tick      time.Duration
}

// New builds a drain sweeper.
func New(store Store, sessions Sessions, cfg Config) *Sweeper {
	s := &Sweeper{
		store:     store,
		sessions:  sessions,
		telemetry: cfg.Telemetry,
		logger:    cfg.Logger,
		clock:     cfg.Clock,
		tick:      cfg.Tick,
		hadLive:   make(map[domain.ProjectID]bool),
	}
	if s.logger == nil {
		s.logger = slog.Default()
	}
	if s.clock == nil {
		s.clock = time.Now
	}
	if s.tick <= 0 {
		s.tick = DefaultTickInterval
	}
	return s
}

// Start runs the sweep on the shared poll loop.
func (s *Sweeper) Start(ctx context.Context) <-chan struct{} {
	return observe.StartPollLoop(ctx, s.tick, s.Tick, s.logger, "fleet drain")
}

// Tick runs one synchronous drain pass across all paused projects.
func (s *Sweeper) Tick(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.store == nil || s.sessions == nil {
		return nil
	}
	fleetPaused, err := s.store.GetFleetPaused(ctx)
	if err != nil {
		return err
	}
	projects, err := s.store.ListProjects(ctx)
	if err != nil {
		return err
	}
	for _, project := range projects {
		if err := ctx.Err(); err != nil {
			return err
		}
		id := domain.ProjectID(project.ID)
		if !project.Paused && !fleetPaused {
			// Running: forget any drain tracking so a later pause starts fresh.
			delete(s.hadLive, id)
			continue
		}
		s.drainProject(ctx, id)
	}
	return nil
}

// drainProject terminates drainable workers for one paused project and emits
// the drain-complete signal when it reaches zero live workers.
func (s *Sweeper) drainProject(ctx context.Context, id domain.ProjectID) {
	sessions, err := s.sessions.List(ctx, sessionsvc.ListFilter{ProjectID: id})
	if err != nil {
		s.logger.Warn("fleet drain: list sessions failed", "project", id, "err", err)
		return
	}
	live, drained := 0, 0
	for _, sess := range sessions {
		if sess.Kind != domain.KindWorker || sess.IsTerminated {
			continue
		}
		if !drainable(sess.Status) {
			live++ // still working / has an open PR / waiting on the user
			continue
		}
		killed, err := s.sessions.Kill(ctx, sess.ID)
		switch {
		case err != nil:
			s.logger.Warn("fleet drain: kill worker failed", "project", id, "session", sess.ID, "err", err)
			live++ // still present; retry next tick
		case killed:
			drained++
		default:
			live++ // kill was a no-op (e.g. dirty worktree preserved); still present
		}
	}
	if live > 0 {
		s.hadLive[id] = true
		return
	}
	// Zero live workers. Signal completion once, when this project had live
	// workers on a prior tick or we terminated the last of them just now.
	if s.hadLive[id] || drained > 0 {
		s.emitDrainComplete(ctx, id, drained)
	}
	delete(s.hadLive, id)
}

// drainable reports whether a worker has reached a confirmed terminal/idle
// state and can be reclaimed: reported idle, or a merged PR with nothing left
// open. Anything actively working, holding an open PR, or waiting on the user is
// left alone (use --hard to terminate those immediately).
//
// StatusNoSignal is deliberately NOT drainable: it means the activity hook has
// never reported for the current spawn, so AO cannot tell whether the agent is
// idle or still executing behind a broken hook pipeline. Terminating it on an
// ordinary pause would violate the promise that in-flight work may finish; a
// hard pause is the escape hatch for those.
func drainable(status domain.SessionStatus) bool {
	switch status {
	case domain.StatusIdle, domain.StatusMerged:
		return true
	default:
		return false
	}
}

func (s *Sweeper) emitDrainComplete(ctx context.Context, id domain.ProjectID, drained int) {
	s.logger.Info("fleet drain: project drained", "project", id, "drained", drained)
	if s.telemetry == nil {
		return
	}
	projectID := id
	s.telemetry.Emit(ctx, ports.TelemetryEvent{
		Name:       "ao.fleet.drain_complete",
		Source:     "fleet_drain",
		OccurredAt: s.clock().UTC(),
		Level:      ports.TelemetryLevelInfo,
		ProjectID:  &projectID,
		Payload:    map[string]any{"drained_workers": drained},
	})
}
