package engine

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/triggers"
)

// defaultSweepInterval is how often the reaper looks for kept sessions past the
// 24h TTL. Hourly: the bound is a day, so nothing is gained by looking sooner.
const defaultSweepInterval = time.Hour

// Supervisor owns one Engine per project. It is the single wiring seam the
// daemon constructs, so the whole subsystem stays behind AO_PIPELINES at one
// call site, and it is the lookup the trigger bridges and the HTTP service use
// to reach a project's engine.
//
// It also owns the shared concurrency table. Keeping it here rather than in an
// engine means two projects that somehow resolve the same key (the same repo
// registered twice, say) still serialize against each other.
type Supervisor struct {
	cfg SupervisorConfig

	concurrency *ConcurrencyTable

	mu      sync.Mutex
	engines map[domain.ProjectID]*Engine
	started bool
	reaping bool

	sweepQuit chan struct{}
	sweepWG   sync.WaitGroup
}

// ProjectLister enumerates the projects to instantiate engines for. Satisfied
// by *storage/sqlite/store.Store.
type ProjectLister interface {
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
}

// SupervisorConfig constructs a Supervisor. Store, Executors, Workspaces,
// Projects and BaseDir are required; the rest default.
type SupervisorConfig struct {
	Store       Store
	Executors   executors.StageExecutor
	Workspaces  executors.WorkspaceProvisioner
	Sessions    SessionDisposer
	Messenger   executors.SessionMessenger
	Credentials Credentials
	Projects    ProjectLister
	// Orphans is the reaper the supervisor owns: every engine hands it the
	// sessions their kill-on rules spared, and the supervisor's sweep ticker
	// enforces the 24h TTL. Nil means no reaper, which is a test wiring.
	Orphans *OrphanRegistry
	// BaseDir is the run-folder root, <AO_DATA_DIR>/pipelines.
	BaseDir      string
	Logger       *slog.Logger
	Clock        func() time.Time
	TickInterval time.Duration
	// SweepInterval is how often the reaper runs. Defaults to
	// defaultSweepInterval; tests shorten it.
	SweepInterval time.Duration
}

// NewSupervisor builds a Supervisor. It starts no engines; call Start.
func NewSupervisor(cfg SupervisorConfig) *Supervisor {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.SweepInterval <= 0 {
		cfg.SweepInterval = defaultSweepInterval
	}
	return &Supervisor{
		cfg:         cfg,
		concurrency: &ConcurrencyTable{},
		engines:     map[domain.ProjectID]*Engine{},
		sweepQuit:   make(chan struct{}),
	}
}

// Start instantiates and starts one engine per known project. A single
// project's hydrate failure is logged and skipped rather than sinking daemon
// boot: that project can still get an engine later through For, and an engine
// with no definitions simply idles.
func (s *Supervisor) Start(ctx context.Context) error {
	projects, err := s.cfg.Projects.ListProjects(ctx)
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
			s.cfg.Logger.Error("pipeline engine start failed", "project", pid, "err", err)
			continue
		}
		s.engines[pid] = eng
	}
	s.startReaper()
	return nil
}

// startReaper launches the sweep ticker. Called with s.mu held.
func (s *Supervisor) startReaper() {
	if s.cfg.Orphans == nil || s.reaping {
		return
	}
	s.reaping = true
	s.sweepWG.Add(1)
	go s.reap()
}

// reap sweeps past-TTL kept sessions until Stop. It is a slow loop on purpose:
// the bound is 24h, so hourly granularity is plenty and a busy daemon never
// notices it.
func (s *Supervisor) reap() {
	defer s.sweepWG.Done()
	ticker := time.NewTicker(s.cfg.SweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.sweepQuit:
			return
		case <-ticker.C:
			s.cfg.Orphans.Sweep(context.Background(), s.now())
		}
	}
}

// now is the supervisor's clock, the same seam the engines take.
func (s *Supervisor) now() time.Time {
	if s.cfg.Clock != nil {
		return s.cfg.Clock()
	}
	return time.Now().UTC()
}

// Stop stops every engine. Safe to call once; later lookups error.
func (s *Supervisor) Stop(ctx context.Context) error {
	s.mu.Lock()
	engines := s.engines
	s.engines = map[domain.ProjectID]*Engine{}
	s.started = false
	stopReaper := s.reaping
	s.reaping = false
	s.mu.Unlock()

	if stopReaper {
		close(s.sweepQuit)
		s.sweepWG.Wait()
	}

	for _, eng := range engines {
		_ = eng.Stop(ctx)
	}
	return nil
}

// For returns the engine for a project, lazily creating and starting one for a
// project registered after Start, so a trigger for a new project is never
// silently dropped.
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
		Store:        s.cfg.Store,
		Executors:    s.cfg.Executors,
		Workspaces:   s.cfg.Workspaces,
		Sessions:     s.cfg.Sessions,
		Orphans:      s.cfg.Orphans,
		Messenger:    s.cfg.Messenger,
		Credentials:  s.cfg.Credentials,
		BaseDir:      s.cfg.BaseDir,
		Concurrency:  s.concurrency,
		StartQueued:  s.startQueued,
		Logger:       s.cfg.Logger,
		Clock:        s.cfg.Clock,
		TickInterval: s.cfg.TickInterval,
	})
}

// startQueued starts a trigger that just took its concurrency key from a run
// that settled. It routes by the trigger's own project, because the table is
// shared and the waiting trigger need not belong to the engine that released
// the key.
//
// It runs on a goroutine the releasing engine owns, never on that engine's
// actor, so posting onto any mailbox from here is safe.
func (s *Supervisor) startQueued(pt pendingTrigger) {
	ctx := context.Background()
	eng, err := s.For(ctx, domain.ProjectID(pt.Subject.ProjectID))
	if err != nil {
		s.cfg.Logger.Warn("pipeline queued trigger dropped: no engine",
			"project", pt.Subject.ProjectID, "pipeline", pt.Definition.Name, "err", err)
		return
	}
	key := keyFor(pt.Definition, pt.Subject)
	eng.do(func() { eng.startTrigger(pt, key) })
}

// Provider adapts the supervisor to the trigger bridges' EngineProvider port.
// The bridges declare that port next to themselves so the dependency points one
// way; this is the other end of it.
type Provider struct{ sup *Supervisor }

// Engines returns the bridges' view of the supervisor.
func (s *Supervisor) Engines() triggers.EngineProvider { return Provider{sup: s} }

var _ triggers.EngineProvider = Provider{}

// For resolves (and lazily starts) a project's engine.
func (p Provider) For(ctx context.Context, projectID domain.ProjectID) (triggers.Engine, error) {
	eng, err := p.sup.For(ctx, projectID)
	if err != nil {
		// Return an explicit nil so the caller never gets a non-nil interface
		// wrapping a nil pointer.
		return nil, err
	}
	return eng, nil
}

// RunReader is the read surface the HTTP service uses for a run the engine may
// still be holding. The store is the record, so this is only used where the
// caller needs the engine's live view.
type RunReader interface {
	Run(id pipeline.RunID) (pipeline.RunState, bool)
}

var _ RunReader = (*Engine)(nil)
