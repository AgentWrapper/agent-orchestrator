package engine

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
)

// Supervisor owns one Engine per project. It is the single wiring seam the
// daemon constructs (so T11 can gate the whole subsystem behind AO_PIPELINES at
// one call site), and the lookup other subsystems (T6 triggers, T7 API) use to
// reach a project's engine.
type Supervisor struct {
	store        Store
	execs        *executors.Set
	projects     ProjectLister
	sink         ObservationSink
	log          *slog.Logger
	clock        func() time.Time
	tickInterval time.Duration

	mu      sync.Mutex
	engines map[domain.ProjectID]*Engine
	started bool
}

// ProjectLister enumerates the projects to instantiate engines for. Satisfied by
// *storage/sqlite/store.Store.
type ProjectLister interface {
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
}

// SupervisorConfig constructs a Supervisor. Store, Executors, and Projects are
// required; the rest default.
type SupervisorConfig struct {
	Store        Store
	Executors    *executors.Set
	Projects     ProjectLister
	Sink         ObservationSink
	Logger       *slog.Logger
	Clock        func() time.Time
	TickInterval time.Duration
}

// NewSupervisor builds a Supervisor. It starts no engines; call Start.
func NewSupervisor(cfg SupervisorConfig) *Supervisor {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Supervisor{
		store:        cfg.Store,
		execs:        cfg.Executors,
		projects:     cfg.Projects,
		sink:         cfg.Sink,
		log:          log,
		clock:        cfg.Clock,
		tickInterval: cfg.TickInterval,
		engines:      map[domain.ProjectID]*Engine{},
	}
}

// Start instantiates and starts one engine per known project. A single project's
// hydrate failure is logged and skipped rather than sinking daemon boot; the
// project can still get an engine later via For. Engines with no definitions or
// triggers are harmless (they just idle).
func (s *Supervisor) Start(ctx context.Context) error {
	projects, err := s.projects.ListProjects(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.started = true
	for _, p := range projects {
		pid := domain.ProjectID(p.ID)
		if _, ok := s.engines[pid]; ok {
			continue
		}
		eng := s.newEngine(pid)
		if err := eng.Start(ctx); err != nil {
			s.log.Error("pipeline engine start failed", "project", pid, "err", err)
			continue
		}
		s.engines[pid] = eng
	}
	return nil
}

// Stop stops every engine. Safe to call once; subsequent lookups return an error.
func (s *Supervisor) Stop(ctx context.Context) error {
	s.mu.Lock()
	engines := s.engines
	s.engines = map[domain.ProjectID]*Engine{}
	s.started = false
	s.mu.Unlock()

	for _, eng := range engines {
		_ = eng.Stop(ctx)
	}
	return nil
}

// For returns the engine for a project, lazily creating and starting one if the
// project was registered after Start (so triggers for new projects are not
// silently dropped). Errors if the supervisor is stopped or hydrate fails.
func (s *Supervisor) For(ctx context.Context, projectID domain.ProjectID) (*Engine, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.started {
		return nil, errors.New("pipeline engine supervisor not started")
	}
	if eng, ok := s.engines[projectID]; ok {
		return eng, nil
	}
	eng := s.newEngine(projectID)
	if err := eng.Start(ctx); err != nil {
		return nil, err
	}
	s.engines[projectID] = eng
	return eng, nil
}

func (s *Supervisor) newEngine(pid domain.ProjectID) *Engine {
	return New(Config{
		ProjectID:    pid,
		Store:        s.store,
		Executors:    s.execs,
		Sink:         s.sink,
		Logger:       s.log,
		Clock:        s.clock,
		TickInterval: s.tickInterval,
	})
}
