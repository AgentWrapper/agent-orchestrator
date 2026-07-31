package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree"
	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/engine"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/triggers"
	pipelinesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// pipelineStack is the single wiring seam for the pipelines subsystem: the
// per-project engine supervisor plus the CDC trigger bridges. It is built only
// when AO_PIPELINES resolves on, so everything below it stays inert otherwise.
type pipelineStack struct {
	supervisor    *engine.Supervisor
	prBridge      *triggers.PRBridge
	sessionBridge *triggers.SessionBridge
	svc           *pipelinesvc.Service
}

// pipelineDeps is what the pipelines stack needs from the rest of the daemon.
type pipelineDeps struct {
	Store       *sqlite.Store
	Sessions    engine.SessionCommander
	Runtime     engine.RuntimeInterrupter
	Broadcaster *cdc.Broadcaster
	DataDir     string
}

// startPipelineEngine wires and starts the pipelines subsystem. A failure to
// build it is logged and the stack comes back nil, which leaves every
// /api/v1/pipelines route answering 501: an experimental subsystem must never
// be able to sink daemon boot.
func startPipelineEngine(ctx context.Context, deps pipelineDeps, log *slog.Logger) *pipelineStack {
	stack, err := buildPipelineStack(ctx, deps, log)
	if err != nil {
		log.Error("pipelines: engine not started", "err", err)
		return nil
	}
	log.Info("pipelines v2: engine started")
	return stack
}

// buildPipelineStack assembles the run folder root, the pipeline-scoped
// worktree adapter, the executor set over the session seams, the supervisor and
// the PR trigger bridge.
func buildPipelineStack(ctx context.Context, deps pipelineDeps, log *slog.Logger) (*pipelineStack, error) {
	// Run folders, and the worktrees inside them, live under the data dir, so a
	// single AO_DATA_DIR override moves all durable state together and nothing
	// lands in an OS-default application-data location.
	baseDir := filepath.Join(deps.DataDir, "pipelines")

	// The worktree adapter is rooted at the pipelines base dir because run and
	// stage trees live inside the run folder, and the adapter refuses any path
	// outside its managed root.
	trees, err := gitworktree.New(gitworktree.Options{
		ManagedRoot:  baseDir,
		RepoResolver: projectRepoResolver{store: deps.Store},
	})
	if err != nil {
		return nil, fmt.Errorf("pipeline workspaces: %w", err)
	}

	sessions := engine.NewSessionAdapter(deps.Sessions, deps.Store, deps.Runtime, log)
	workspaces := executors.NewWorkspaceResolver(trees, sessions.SessionWorkspaces(), engine.NewCheckoutAdapter(deps.Store))
	credentials := engine.NewCredentialAdapter(deps.Store)

	// The reaper bounds the sessions the kill-on rule spares: cap 3 per pipeline,
	// 24h TTL. Its ledger is the marker on the session rows, so the bounds hold
	// for sessions a previous daemon kept alive too.
	orphans := engine.NewOrphanRegistry(deps.Store, sessions, log)

	// The service is built first because it is the agent executor's signal
	// reader, and it gets its engines last, once the supervisor those executors
	// feed exists. That is the whole cycle, broken at the one seam where late
	// binding is harmless: nothing serves a request until wiring returns.
	svc := pipelinesvc.New(deps.Store, pipelinesvc.WithCredentials(credentials))
	execs := engine.BuildExecutorSet(sessions, svc)

	supervisor := engine.NewSupervisor(engine.SupervisorConfig{
		Store:       deps.Store,
		Executors:   execs,
		Workspaces:  workspaces,
		Sessions:    sessions,
		Orphans:     orphans,
		Messenger:   sessions,
		Credentials: credentials,
		Projects:    deps.Store,
		BaseDir:     baseDir,
		Logger:      log,
	})
	if err := supervisor.Start(ctx); err != nil {
		return nil, fmt.Errorf("pipeline supervisor: %w", err)
	}

	// The PR bridge turns CDC pull-request events into runs with a PR subject.
	prBridge := triggers.NewPRBridge(triggers.PRConfig{
		Broadcaster: deps.Broadcaster,
		Defs:        deps.Store,
		PRs:         deps.Store,
		Engines:     supervisor.Engines(),
		Logger:      log,
	})
	prBridge.Start(ctx)

	// The session bridge turns session activity transitions into runs. Its loop
	// guard is the session adapter, which reads the pipeline-spawned marker every
	// pipeline session now carries: without it a pipeline agent going idle would
	// fire the session pipelines, whose agents go idle, forever.
	sessionBridge := triggers.NewSessionBridge(triggers.SessionConfig{
		Broadcaster: deps.Broadcaster,
		Defs:        deps.Store,
		Engines:     supervisor.Engines(),
		Spawned:     sessions,
		Logger:      log,
	})
	sessionBridge.Start(ctx)

	svc.SetEngines(pipelinesvc.SupervisorEngines(supervisor))

	return &pipelineStack{supervisor: supervisor, prBridge: prBridge, sessionBridge: sessionBridge, svc: svc}, nil
}

// Manager is the service the HTTP API and the lifecycle merge gate mount. A nil
// stack yields a nil Manager, which is the 501 path.
func (p *pipelineStack) Manager() pipelinesvc.Manager {
	if p == nil || p.svc == nil {
		return nil
	}
	return p.svc
}

// Stop tears the stack down: bridges first, so no new trigger arrives while the
// engines are stopping. Nil-safe, so callers need no extra guard.
func (p *pipelineStack) Stop(ctx context.Context) {
	if p == nil {
		return
	}
	if p.prBridge != nil {
		p.prBridge.Stop()
	}
	if p.sessionBridge != nil {
		p.sessionBridge.Stop()
	}
	if p.supervisor != nil {
		_ = p.supervisor.Stop(ctx)
	}
}
