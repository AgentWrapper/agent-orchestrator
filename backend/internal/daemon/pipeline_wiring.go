package daemon

import (
	"context"
	"log/slog"

	pipelineengine "github.com/aoagents/agent-orchestrator/backend/internal/pipeline/engine"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// pipelineStack holds the pipeline engine supervisor and its teardown. It is the
// single wiring seam for the pipelines subsystem (spec §4b T5): T11 will gate
// this one constructor call behind the AO_PIPELINES flag with no other change.
type pipelineStack struct {
	supervisor *pipelineengine.Supervisor
}

// startPipelineEngine builds the executor set over the session service + store,
// constructs the per-project engine supervisor, and starts one engine per known
// project. A start failure is logged, never fatal: an unhealthy pipeline
// subsystem must not block daemon boot, and idle engines (no definitions, no
// triggers) are harmless.
func startPipelineEngine(ctx context.Context, store *sqlite.Store, sessions pipelineengine.SessionCommander, log *slog.Logger) *pipelineStack {
	execs := pipelineengine.BuildExecutorSet(sessions, store)
	sup := pipelineengine.NewSupervisor(pipelineengine.SupervisorConfig{
		Store:     store,
		Executors: execs,
		Projects:  store,
		Logger:    log,
	})
	if err := sup.Start(ctx); err != nil {
		log.Error("pipeline engine supervisor start failed", "err", err)
	}
	return &pipelineStack{supervisor: sup}
}

// Stop tears down every project engine, cancelling in-flight runs so their
// session-owned stage worktrees are reclaimed (spec §9 note 9).
func (p *pipelineStack) Stop(ctx context.Context) {
	if p == nil || p.supervisor == nil {
		return
	}
	_ = p.supervisor.Stop(ctx)
}
