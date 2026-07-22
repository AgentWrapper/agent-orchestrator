package daemon

import (
	"context"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	pipelineengine "github.com/aoagents/agent-orchestrator/backend/internal/pipeline/engine"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/triggers"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// pipelineStack holds the pipeline engine supervisor, the CDC trigger bridge,
// and their teardown. It is the single wiring seam for the pipelines subsystem
// (spec §4b T5/T6): T11 will gate this one constructor call behind the
// AO_PIPELINES flag with no other change.
type pipelineStack struct {
	supervisor *pipelineengine.Supervisor
	bridge     *triggers.Bridge
}

// startPipelineEngine builds the executor set over the session service + store,
// constructs the per-project engine supervisor, starts one engine per known
// project, and starts the CDC trigger bridge over the shared broadcaster. A
// start failure is logged, never fatal: an unhealthy pipeline subsystem must not
// block daemon boot, and idle engines (no definitions, no triggers) are harmless.
func startPipelineEngine(ctx context.Context, store *sqlite.Store, sessions pipelineengine.SessionCommander, bcast *cdc.Broadcaster, log *slog.Logger) *pipelineStack {
	execs := pipelineengine.BuildExecutorSet(sessions, store, log)
	sup := pipelineengine.NewSupervisor(pipelineengine.SupervisorConfig{
		Store:     store,
		Executors: execs,
		Projects:  store,
		Logger:    log,
	})
	if err := sup.Start(ctx); err != nil {
		log.Error("pipeline engine supervisor start failed", "err", err)
	}

	bridge := triggers.New(triggers.Config{
		Broadcaster: bcast,
		Defs:        store,
		PRs:         store,
		Engines:     supervisorEngines{sup: sup},
		Logger:      log,
	})
	bridge.Start(ctx)

	return &pipelineStack{supervisor: sup, bridge: bridge}
}

// supervisorEngines adapts *pipelineengine.Supervisor to triggers.EngineProvider
// by narrowing the concrete *engine.Engine it returns to the bridge's Engine
// interface.
type supervisorEngines struct {
	sup *pipelineengine.Supervisor
}

func (s supervisorEngines) For(ctx context.Context, projectID domain.ProjectID) (triggers.Engine, error) {
	eng, err := s.sup.For(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return eng, nil
}

// Stop stops the trigger bridge first (no new runs), then tears down every
// project engine, cancelling in-flight runs so their session-owned stage
// worktrees are reclaimed (spec §9 note 9).
func (p *pipelineStack) Stop(ctx context.Context) {
	if p == nil {
		return
	}
	p.bridge.Stop()
	if p.supervisor != nil {
		_ = p.supervisor.Stop(ctx)
	}
}
