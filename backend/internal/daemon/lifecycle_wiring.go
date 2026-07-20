package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/activitydispatch"
	agentregistry "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/reviewer"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/runtimeselect"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/reaper"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	reviewsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/review"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type notificationSink interface {
	Notify(context.Context, ports.NotificationIntent) error
}

// lifecycleStack owns the runtime reaper goroutine started with the lifecycle
// reducer. The reducer itself is only used for wiring observations into storage.
type lifecycleStack struct {
	// LCM is the Lifecycle Manager (the canonical write path). It is exposed so
	// startSession can share the same reducer the reaper drives, rather than
	// standing up a second store+LCM pair that would diverge under writes.
	LCM         *lifecycle.Manager
	reaperDone  <-chan struct{}
	scmDone     <-chan struct{}
	trackerDone <-chan struct{}
}

// startLifecycle constructs the Lifecycle Manager over the store and starts the
// reaper. The goroutine stops when ctx is cancelled; Stop waits for it to drain.
// The messenger is the per-daemon agent messenger the LCM uses to nudge agents
// in response to SCM observations (CI failure, review feedback, merge conflict).
func startLifecycle(ctx context.Context, store *sqlite.Store, runtime ports.Runtime, messenger ports.AgentMessenger, notifier notificationSink, telemetry ports.EventSink, logger *slog.Logger) *lifecycleStack {
	lcm := lifecycle.New(store, messenger, lifecycle.WithNotificationSink(notifier), lifecycle.WithTelemetry(telemetry))
	rp := reaper.New(lcm, store, runtime, reaper.Config{Logger: logger})
	return &lifecycleStack{LCM: lcm, reaperDone: rp.Start(ctx)}
}

// Stop waits for the reaper goroutine to exit. The caller must cancel the ctx
// passed to startLifecycle before calling Stop.
func (l *lifecycleStack) Stop() {
	<-l.reaperDone
	if l.scmDone != nil {
		<-l.scmDone
	}
	if l.trackerDone != nil {
		<-l.trackerDone
	}
}

// sessionLifecycle is the narrow surface of sessionmanager.Manager used for
// boot/shutdown wiring. A minimal interface keeps the daemon testable without
// depending on the concrete manager type.
//
// SaveAndTeardownAll is deliberately ABSENT from this interface so the daemon
// cannot tear down live sessions on shutdown. Sessions survive the daemon exit
// and Reconcile on the next boot adopts them, preserving session IDs. Re-adding
// the method here is a visible, reviewable interface change.
type sessionLifecycle interface {
	Reconcile(ctx context.Context) error
	RestoreAll(ctx context.Context) error
}

// startSession builds the controller-facing session service: a session manager
// over the selected runtime, a per-session gitworktree workspace, the shared
// store + LCM, the per-session agent resolver, and the agent messenger. The
// returned service is mounted at httpd APIDeps.Sessions. It also returns the
// manager so the caller can wire Reconcile into the boot sequence.
func startSession(cfg config.Config, runtime runtimeselect.Runtime, store *sqlite.Store, lcm *lifecycle.Manager, messenger ports.AgentMessenger, telemetry ports.EventSink, log *slog.Logger) (*sessionsvc.Service, reviewsvc.Manager, sessionLifecycle, error) {
	defaultAgent := cfg.Agent
	if defaultAgent == "" {
		defaultAgent = config.DefaultAgent
	}
	agents, err := buildAgentResolver(defaultAgent, log)
	if err != nil {
		return nil, nil, nil, err
	}
	ws, err := gitworktree.New(gitworktree.Options{
		// Per-session worktrees live under the data dir, so a single AO_DATA_DIR
		// override moves all durable per-user state together.
		ManagedRoot: filepath.Join(cfg.DataDir, "worktrees"),
		// Resolve each project's source repo from the projects table, so a
		// session spawned for a registered project materialises its worktree off
		// that repo. Unregistered projects fail loudly.
		RepoResolver: projectRepoResolver{store: store},
	})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("session workspace: %w", err)
	}
	mgr := sessionmanager.New(sessionmanager.Deps{
		Runtime:   runtime,
		Agents:    agents,
		Workspace: ws,
		Store:     store,
		Messenger: messenger,
		Lifecycle: lcm,
		DataDir:   cfg.DataDir,
		Logger:    log,
		// Same resolution the tmux runtime adapter uses (override → PATH →
		// bundled), so the spawn prerequisite gate can never disagree with
		// the binary the runtime would actually exec.
		TmuxResolver: tmux.NewResolver(cfg.TmuxBin, cfg.BundledTmux),
	})
	scmProvider, err := newGitHubSCMProvider(log)
	if err != nil {
		logSCMProviderDisabled(log, err)
	}
	// Build the GitHub tracker, but keep a true nil ports.Tracker interface on
	// failure. newGitHubTracker returns (*github.Tracker)(nil) on ErrNoToken,
	// which Go wraps as a non-nil typed-nil interface — that slips past the
	// `s.tracker == nil` guard in withIssueContext and dereferences nil on the
	// first issue lookup (issue #2685). Assigning the concrete value only on
	// success leaves tracker as a real interface-nil otherwise.
	var tracker ports.Tracker
	if t, err := newGitHubTracker(); err != nil {
		logTrackerDisabled(log, err)
	} else {
		tracker = t
	}
	sessionSvc := sessionsvc.NewWithDeps(sessionsvc.Deps{
		Manager:   mgr,
		Store:     store,
		PRClaimer: store,
		SCM:       scmProvider,
		Tracker:   tracker,
		Telemetry: telemetry,
		// no_signal only makes sense for harnesses whose adapters install
		// activity hooks; the deriver registry is the source of truth for that.
		SignalCapable: activitydispatch.SupportsHarness,
	})
	// Triggering a review spawns a reviewer over the worker's worktree, resolved
	// from the reviewer registry (distinct from the worker agent set). The
	// reviewer posts its review to the PR itself, so the service needs no SCM
	// writer.
	reviewers, err := reviewer.NewResolver()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("reviewer resolver: %w", err)
	}
	reviewEngine := reviewcore.New(reviewcore.Deps{
		Store:    store,
		Sessions: store,
		PRs:      store,
		Projects: store,
		Launcher: reviewcore.NewLauncher(reviewers, runtime),
	})
	reviewSvc := reviewsvc.New(reviewEngine, store, reviewsvc.WithLifecycleReducer(lcm))
	return sessionSvc, reviewSvc, mgr, nil
}

// runtimeMessageSender is the narrow part of the concrete runtime needed by
// ao send. Both tmux.Runtime and conpty.Runtime implement this via SendMessage.
type runtimeMessageSender interface {
	SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error
}

// runtimeMessenger sends the user's message directly to the session's live
// runtime pane. The HTTP controller has already validated and sanitized the
// message body; this adapter only resolves the stored runtime handle.
type runtimeMessenger struct {
	store   *sqlite.Store
	runtime runtimeMessageSender
}

func (m runtimeMessenger) Send(ctx context.Context, id domain.SessionID, message string) error {
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("session %s: %w", id, sessionmanager.ErrNotFound)
	}
	if rec.IsTerminated {
		return fmt.Errorf("session %s: %w", id, sessionmanager.ErrTerminated)
	}
	handleID := rec.Metadata.RuntimeHandleID
	if handleID == "" {
		return fmt.Errorf("session %s: %w", id, sessionmanager.ErrIncompleteHandle)
	}
	return m.runtime.SendMessage(ctx, ports.RuntimeHandle{ID: handleID}, message)
}

// newSessionMessenger assembles the per-daemon agent messenger. For now, ao
// send is intentionally minimal: submit the message to the live runtime pane.
func newSessionMessenger(store *sqlite.Store, runtime runtimeMessageSender, _ *slog.Logger) ports.AgentMessenger {
	return runtimeMessenger{store: store, runtime: runtime}
}

// buildAgentRegistry returns a registry populated with the agent adapters the
// daemon ships, keyed by manifest id. Registration only fails on an
// empty/duplicate id — a programmer error, not a runtime condition.
// The shipped adapter list lives in the adapters/agent/registry package
// (registry.Constructors). Adding a new harness is a one-line edit there.
func buildAgentRegistry() (*adapters.Registry, error) {
	return agentregistry.Build()
}

// agentRegistry adapts the generic adapter Registry to ports.AgentResolver: it
// maps a session's harness onto the registered adapter of the same id and
// asserts that adapter drives an agent. Empty harnesses are invalid at the
// session manager boundary and deliberately do not resolve here.
type agentRegistry struct {
	reg *adapters.Registry
}

var _ ports.AgentResolver = agentRegistry{}

func (a agentRegistry) Agent(harness domain.AgentHarness) (ports.Agent, bool) {
	adapter, ok := a.reg.Get(string(harness))
	if !ok {
		return nil, false
	}
	agent, ok := adapter.(ports.Agent)
	return agent, ok
}

// buildAgentResolver constructs the per-session agent resolver the Session
// Manager consumes (sessionmanager.Deps.Agents): a registry of the shipped
// adapters. It still validates AO_AGENT at startup for compatibility with the
// config surface, but worker/orchestrator spawns must provide a resolved
// harness before calling Agent.
func buildAgentResolver(defaultAgent string, log *slog.Logger) (ports.AgentResolver, error) {
	if defaultAgent == "" {
		defaultAgent = config.DefaultAgent
	}
	reg, err := buildAgentRegistry()
	if err != nil {
		return nil, err
	}
	resolver := agentRegistry{reg: reg}
	if _, ok := resolver.Agent(domain.AgentHarness(defaultAgent)); !ok {
		return nil, fmt.Errorf("configured default agent %q is not a registered adapter", defaultAgent)
	}
	ids := make([]string, 0)
	for _, mf := range reg.Manifests() {
		ids = append(ids, mf.ID)
	}
	log.Info("built per-session agent resolver", "default", defaultAgent, "registered", ids)
	return resolver, nil
}

// projectRepoResolver resolves a project's on-disk repo path from the projects
// table so gitworktree can materialise per-session worktrees off it. It replaces
// the empty StaticRepoResolver the daemon used before (which failed every
// lookup), turning a registered project into a spawnable one.
type projectRepoResolver struct{ store *sqlite.Store }

var _ gitworktree.RepoResolver = projectRepoResolver{}

func (r projectRepoResolver) RepoPath(projectID domain.ProjectID) (string, error) {
	rec, ok, err := r.store.GetProject(context.Background(), string(projectID))
	if err != nil {
		return "", fmt.Errorf("look up project %q: %w", projectID, err)
	}
	if !ok {
		return "", fmt.Errorf("no project registered with id %q — add one with `ao project add`: %w", projectID, sessionmanager.ErrProjectNotResolvable)
	}
	if !rec.ArchivedAt.IsZero() {
		return "", fmt.Errorf("project %q is archived: %w", projectID, sessionmanager.ErrProjectNotResolvable)
	}
	if rec.Path == "" {
		return "", fmt.Errorf("project %q has no repo path on record: %w", projectID, sessionmanager.ErrProjectNotResolvable)
	}
	return rec.Path, nil
}
