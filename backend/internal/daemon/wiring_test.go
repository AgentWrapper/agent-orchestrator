package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/runtimeselect"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	telemetryadapter "github.com/aoagents/agent-orchestrator/backend/internal/adapters/telemetry"
	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// TestWiring_WriteFlowsToBroadcaster exercises the real boot path end to end:
// a lifecycle write -> sqlite -> DB trigger -> change_log -> CDC poller ->
// broadcaster, through the same cdc.Source implementation the daemon uses.
func TestWiring_WriteFlowsToBroadcaster(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	lcm := lifecycle.New(store, nil)

	bcast := cdc.NewBroadcaster()
	poller := cdc.NewPoller(store, bcast, cdc.PollerConfig{})
	if err := poller.SeekToHead(ctx); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var got []cdc.Event
	bcast.Subscribe(func(e cdc.Event) { mu.Lock(); got = append(got, e); mu.Unlock() })

	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "mer", Path: "/repo/mer"}); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "mer", Kind: domain.KindWorker,
		Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()},
	})
	if err != nil {
		t.Fatal(err)
	}
	// A real transition through the engine, which writes the row and fires the
	// activity_state/is_terminated CDC trigger.
	if err := lcm.ApplyActivitySignal(ctx, rec.ID, ports.ActivitySignal{Valid: true, State: domain.ActivityActive, Timestamp: time.Now()}); err != nil {
		t.Fatal(err)
	}

	if err := poller.Poll(ctx); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	var sawSession bool
	for _, e := range got {
		if e.SessionID == string(rec.ID) {
			sawSession = true
		}
	}
	if !sawSession {
		t.Fatalf("expected a change_log event for %s to reach the broadcaster, got %d events", rec.ID, len(got))
	}
}

// TestWiring_AgentResolverResolvesRealAdapters asserts buildAgentResolver wires a
// real registry-backed per-session resolver: each harness resolves to the
// matching registered adapter, while empty and unknown harnesses miss.
func TestWiring_AgentResolverResolvesRealAdapters(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	resolver, err := buildAgentResolver("", log) // empty default → claude-code
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		harness domain.AgentHarness
		wantID  string
	}{
		{domain.HarnessClaudeCode, "claude-code"},
		{domain.HarnessCodex, "codex"},
		{domain.HarnessCodexFugu, "codex-fugu"},
		{domain.HarnessOpenCode, "opencode"},
		{domain.HarnessGrok, "grok"},
		{domain.HarnessCursor, "cursor"},
		{domain.HarnessQwen, "qwen"},
		{domain.HarnessCopilot, "copilot"},
		{domain.HarnessKimi, "kimi"},
		{domain.HarnessDroid, "droid"},
		{domain.HarnessAmp, "amp"},
		{domain.HarnessAgy, "agy"},
		{domain.HarnessCrush, "crush"},
		{domain.HarnessAider, "aider"},
		{domain.HarnessGoose, "goose"},
		{domain.HarnessAuggie, "auggie"},
		{domain.HarnessContinue, "continue"},
		{domain.HarnessDevin, "devin"},
		{domain.HarnessCline, "cline"},
		{domain.HarnessKiro, "kiro"},
		{domain.HarnessKilocode, "kilocode"},
		{domain.HarnessVibe, "vibe"},
		{domain.HarnessPi, "pi"},
		{domain.HarnessAutohand, "autohand"},
	} {
		agent, ok := resolver.Agent(tc.harness)
		if !ok {
			t.Fatalf("resolver has no agent for harness %q", tc.harness)
		}
		described, ok := agent.(adapters.Adapter)
		if !ok {
			t.Fatalf("agent for harness %q is %T, not a registered adapters.Adapter", tc.harness, agent)
		}
		if got := described.Manifest().ID; got != tc.wantID {
			t.Fatalf("harness %q resolved to adapter %q, want %q", tc.harness, got, tc.wantID)
		}
	}
	if _, ok := resolver.Agent("definitely-not-an-agent"); ok {
		t.Fatal("unknown harness resolved to an agent; want a miss")
	}
	if _, ok := resolver.Agent(""); ok {
		t.Fatal("empty harness resolved to an agent; want a miss")
	}
}

// TestWiring_StartSessionBuildsSessionService asserts the daemon's startSession
// constructs a real controller-facing session service end to end (resolver +
// gitworktree workspace + session manager over the shared store/LCM), which is
// what gets mounted at httpd APIDeps.Sessions.
func TestWiring_StartSessionBuildsSessionService(t *testing.T) {
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	lcm := lifecycle.New(store, nil)
	cfg := config.Config{DataDir: t.TempDir()}

	rt := runtimeselect.New(nil)
	messenger := newSessionMessenger(store, rt, log)
	svc, reviewSvc, lc, err := startSession(cfg, rt, store, lcm, messenger, telemetryadapter.NoopSink{}, newLazyGitHubTracker(log), log)
	if err != nil {
		t.Fatalf("startSession: %v", err)
	}
	if svc == nil {
		t.Fatal("startSession returned nil session service")
	}
	if reviewSvc == nil {
		t.Fatal("startSession returned nil review service")
	}
	if lc == nil {
		t.Fatal("startSession returned nil session lifecycle")
	}
}

// TestStartTrackerIntake_RunsEvenWithoutEnabledProjects is a regression test:
// startTrackerIntake used to scan projects once at call time and skip starting
// the observer loop entirely when none had intake enabled yet. Poll() itself
// already re-reads project config on every tick, so a project enabling
// intake after daemon boot was silently never picked up until a restart. The
// loop must always start; Poll is what decides whether there's work to do.
func TestStartTrackerIntake_RunsEvenWithoutEnabledProjects(t *testing.T) {
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	lcm := lifecycle.New(store, nil)
	cfg := config.Config{DataDir: t.TempDir()}
	rt := runtimeselect.New(nil)
	messenger := newSessionMessenger(store, rt, log)
	svc, _, _, err := startSession(cfg, rt, store, lcm, messenger, telemetryadapter.NoopSink{}, newLazyGitHubTracker(log), log)
	if err != nil {
		t.Fatalf("startSession: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := startTrackerIntake(ctx, store, svc, newLazyGitHubTracker(log), log)

	select {
	case <-done:
		t.Fatal("startTrackerIntake returned an already-closed channel; observer loop did not start")
	case <-time.After(20 * time.Millisecond):
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("observer did not stop after context cancellation")
	}
}

func TestTrackerTokenSourcePrefersAOGitHubToken(t *testing.T) {
	t.Setenv("AO_GITHUB_TOKEN", "ao-token")
	t.Setenv("GITHUB_TOKEN", "github-token")
	token, err := (&trackerTokenSource{}).Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if token != "ao-token" {
		t.Fatalf("token = %q, want AO_GITHUB_TOKEN", token)
	}
}

type captureRuntimeSender struct {
	handle  ports.RuntimeHandle
	message string
}

func (c *captureRuntimeSender) SendMessage(_ context.Context, handle ports.RuntimeHandle, message string) error {
	c.handle = handle
	c.message = message
	return nil
}

// TestWiring_SessionMessengerSendsToRuntimePane asserts the daemon wires ao
// send to the live runtime pane and resolves the handle from the shared store.
func TestWiring_SessionMessengerSendsToRuntimePane(t *testing.T) {
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	runtime := &captureRuntimeSender{}
	messenger := newSessionMessenger(store, runtime, nil)

	ctx := context.Background()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: "/repo/p", RegisteredAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "p", Kind: domain.KindWorker,
		Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "ao-1/terminal_0"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := messenger.Send(ctx, rec.ID, "hello agent"); err != nil {
		t.Fatalf("messenger.Send: %v", err)
	}
	if runtime.handle.ID != "ao-1/terminal_0" {
		t.Fatalf("handle = %q, want ao-1/terminal_0", runtime.handle.ID)
	}
	if runtime.message != "hello agent" {
		t.Fatalf("message = %q, want hello agent", runtime.message)
	}
}

func TestWiring_SessionMessengerWrapsLookupErrors(t *testing.T) {
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	messenger := newSessionMessenger(store, &captureRuntimeSender{}, nil)
	err = messenger.Send(context.Background(), "missing", "hello")
	if !errors.Is(err, sessionmanager.ErrNotFound) {
		t.Fatalf("missing session should wrap ErrNotFound, got %v", err)
	}
}

func TestWiring_SessionMessengerRequiresRuntimeHandle(t *testing.T) {
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: "/repo/p", RegisteredAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "p", Kind: domain.KindWorker,
		Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()},
	})
	if err != nil {
		t.Fatal(err)
	}
	messenger := newSessionMessenger(store, &captureRuntimeSender{}, nil)
	err = messenger.Send(ctx, rec.ID, "hello")
	if !errors.Is(err, sessionmanager.ErrIncompleteHandle) {
		t.Fatalf("missing runtime handle should wrap ErrIncompleteHandle, got %v", err)
	}
}

func TestWiring_SessionMessengerRejectsTerminatedSession(t *testing.T) {
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: "/repo/p", RegisteredAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "p", Kind: domain.KindWorker,
		IsTerminated: true,
		Activity:     domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()},
		Metadata:     domain.SessionMetadata{RuntimeHandleID: "ao-1/terminal_0"},
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime := &captureRuntimeSender{}
	messenger := newSessionMessenger(store, runtime, nil)
	err = messenger.Send(ctx, rec.ID, "hello")
	if !errors.Is(err, sessionmanager.ErrTerminated) {
		t.Fatalf("terminated session should wrap ErrTerminated, got %v", err)
	}
	if runtime.handle.ID != "" || runtime.message != "" {
		t.Fatalf("runtime should not be called for terminated sessions, got handle=%q message=%q", runtime.handle.ID, runtime.message)
	}
}

type captureMessenger struct {
	msgs []capturedMessage
}

type capturedMessage struct {
	id  domain.SessionID
	msg string
}

func (c *captureMessenger) Send(_ context.Context, id domain.SessionID, msg string) error {
	c.msgs = append(c.msgs, capturedMessage{id: id, msg: msg})
	return nil
}

// TestWiring_StartLifecycleThreadsMessengerIntoLCM asserts startLifecycle
// constructs the LCM with a real messenger by driving an SCM observation
// through the wired stack and checking the messenger receives the CI-failure
// nudge — a nil messenger here would silently drop the send inside sendOnce.
func TestWiring_StartLifecycleThreadsMessengerIntoLCM(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	// Cancel must run BEFORE Stop so the reaper goroutine's ctx.Done() fires;
	// Stop is a no-op otherwise. Cleanup is LIFO, so register Stop first.
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: "/repo/p", RegisteredAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "p", Kind: domain.KindWorker,
		Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()},
	})
	if err != nil {
		t.Fatal(err)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	messenger := &captureMessenger{}
	stack := startLifecycle(ctx, store, tmux.New(tmux.Options{}), messenger, nil, nil, log)
	t.Cleanup(stack.Stop)
	t.Cleanup(cancel)

	obs := ports.SCMObservation{
		Fetched: true,
		PR:      ports.SCMPRObservation{URL: "https://github.com/o/r/pull/1", Number: 1, HeadSHA: "c1"},
		CI: ports.SCMCIObservation{
			Summary:      string(domain.CIFailing),
			HeadSHA:      "c1",
			FailedChecks: []ports.SCMCheckObservation{{Name: "build", Status: string(domain.PRCheckFailed), LogTail: "boom"}},
		},
	}
	if err := stack.LCM.ApplySCMObservation(ctx, rec.ID, obs); err != nil {
		t.Fatalf("ApplySCMObservation: %v", err)
	}
	if len(messenger.msgs) != 1 {
		t.Fatalf("want one nudge to flow through the wired messenger, got %d", len(messenger.msgs))
	}
	if messenger.msgs[0].id != rec.ID {
		t.Fatalf("nudge sent to %q, want %q", messenger.msgs[0].id, rec.ID)
	}
}

// TestProjectRepoResolver_ResolvesRegisteredProject asserts the DB-backed repo
// resolver turns a registered project into its on-disk repo path (so spawns
// materialise a worktree), and fails loudly for an unregistered project.
func TestProjectRepoResolver_ResolvesRegisteredProject(t *testing.T) {
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "mer", Path: "/repo/mer", RegisteredAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	r := projectRepoResolver{store: store}
	got, err := r.RepoPath("mer")
	if err != nil {
		t.Fatalf("RepoPath(mer): %v", err)
	}
	if got != "/repo/mer" {
		t.Fatalf("RepoPath(mer) = %q, want /repo/mer", got)
	}
	_, err = r.RepoPath("nope")
	if err == nil {
		t.Fatal("expected an error for an unregistered project")
	}
	// Guard the sentinel wrapping so the HTTP 400 mapping can't silently regress.
	if !errors.Is(err, sessionmanager.ErrProjectNotResolvable) {
		t.Fatalf("unregistered-project error should wrap ErrProjectNotResolvable, got %v", err)
	}
}

// fakeSessionLifecycle records calls to Reconcile and RestoreAll so tests can
// assert the daemon wiring invokes the correct methods without needing a real
// runtime or worktree.
type fakeSessionLifecycle struct {
	reconcileCalled  bool
	restoreAllCalled bool
	reconcileErr     error
	restoreErr       error
}

func (f *fakeSessionLifecycle) Reconcile(_ context.Context) error {
	f.reconcileCalled = true
	return f.reconcileErr
}

func (f *fakeSessionLifecycle) RestoreAll(_ context.Context) error {
	f.restoreAllCalled = true
	return f.restoreErr
}

// TestWiring_SessionLifecycleInterfaceInvokedByDaemon asserts the
// sessionLifecycle interface is satisfied by *sessionmanager.Manager (compile
// check) and that Reconcile and RestoreAll dispatch correctly through the
// interface, matching what daemon.go wires at boot.
func TestWiring_SessionLifecycleInterfaceInvokedByDaemon(t *testing.T) {
	// Verify *sessionmanager.Manager satisfies the interface at compile time.
	var _ sessionLifecycle = (*sessionmanager.Manager)(nil)

	fake := &fakeSessionLifecycle{}
	ctx := context.Background()

	// Dispatch through the interface variable to exercise the real dispatch
	// path, not just direct struct method calls.
	var sl sessionLifecycle = fake

	if err := sl.Reconcile(ctx); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if !fake.reconcileCalled {
		t.Fatal("Reconcile was not called through the interface")
	}

	if err := sl.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll: %v", err)
	}
	if !fake.restoreAllCalled {
		t.Fatal("RestoreAll was not called through the interface")
	}
}

type fakeOrchestratorProjectLister struct {
	projects []projectsvc.Summary
	err      error
}

func (f fakeOrchestratorProjectLister) List(context.Context) ([]projectsvc.Summary, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.projects, nil
}

type fakeOrchestratorEnsurer struct {
	mu           sync.Mutex
	calls        []domain.ProjectID
	cleanCalls   []domain.ProjectID
	sessions     []domain.Session
	replaced     []domain.Session
	replStatus   domain.SessionStatus
	replActivity domain.Activity
	spawnErr     error
	send         bool
	sendErr      error
	sends        []sentMessage
}

func (f *fakeOrchestratorEnsurer) SpawnOrchestrator(_ context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if clean {
		f.cleanCalls = append(f.cleanCalls, projectID)
	} else {
		f.calls = append(f.calls, projectID)
	}
	if f.spawnErr != nil {
		return domain.Session{}, f.spawnErr
	}
	if clean {
		for i := range f.sessions {
			if f.sessions[i].ProjectID == projectID && f.sessions[i].Kind == domain.KindOrchestrator && !f.sessions[i].IsTerminated {
				f.sessions[i].IsTerminated = true
				f.sessions[i].Activity.State = domain.ActivityExited
			}
		}
		next := domain.Session{
			SessionRecord: domain.SessionRecord{
				ID:        domain.SessionID(string(projectID) + "-orch-replacement"),
				ProjectID: projectID,
				Kind:      domain.KindOrchestrator,
				Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()},
			},
			Status: domain.StatusIdle,
		}
		if f.replActivity.State != "" {
			next.Activity = f.replActivity
		}
		if f.replStatus != "" {
			next.Status = f.replStatus
		}
		f.sessions = append(f.sessions, next)
		f.replaced = append(f.replaced, next)
		return next, nil
	}
	for _, sess := range f.sessions {
		if sess.ProjectID == projectID && sess.Kind == domain.KindOrchestrator && !sess.IsTerminated {
			return sess, nil
		}
	}
	return domain.Session{
		SessionRecord: domain.SessionRecord{
			ID:        domain.SessionID(string(projectID) + "-orch"),
			ProjectID: projectID,
			Kind:      domain.KindOrchestrator,
		},
	}, nil
}

func (f *fakeOrchestratorEnsurer) WakeIdle(_ context.Context, id domain.SessionID, message string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sends = append(f.sends, sentMessage{id: id, message: message})
	return f.send, f.sendErr
}

func (f *fakeOrchestratorEnsurer) seen(projectID domain.ProjectID) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, got := range f.calls {
		if got == projectID {
			return true
		}
	}
	return false
}

type fakeOrchestratorNotifier struct {
	mu      sync.Mutex
	intents []ports.NotificationIntent
	err     error
}

func (f *fakeOrchestratorNotifier) Notify(_ context.Context, intent ports.NotificationIntent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.intents = append(f.intents, intent)
	return f.err
}

type sentMessage struct {
	id      domain.SessionID
	message string
}

func TestStartOrchestratorSupervisorEnsuresEveryProject(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}, {ID: "ao"}}}
	ensurer := &fakeOrchestratorEnsurer{}
	done := startOrchestratorSupervisor(ctx, projects, ensurer, nil, time.Millisecond, slog.New(slog.NewTextHandler(io.Discard, nil)))

	deadline := time.After(2 * time.Second)
	for {
		if ensurer.seen("mer") && ensurer.seen("ao") {
			cancel()
			<-done
			return
		}
		select {
		case <-deadline:
			t.Fatalf("supervisor did not ensure both projects, calls=%v", ensurer.calls)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestEnsureOrchestratorsSuppressesCanceledContextWarnings(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var logBuf strings.Builder
	projects := fakeOrchestratorProjectLister{err: context.Canceled}
	ensureOrchestrators(ctx, projects, &fakeOrchestratorEnsurer{}, nil, newOrchestratorWakeTracker(), time.Now(), slog.New(slog.NewTextHandler(&logBuf, nil)))

	if got := logBuf.String(); got != "" {
		t.Fatalf("canceled supervisor should not warn, got log %q", got)
	}
}

func TestEnsureOrchestratorsWakesIdleWaitingOrchestrator(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{
		ID: "mer",
		Config: domain.ProjectConfig{
			Orchestrator: domain.RoleOverride{WakeInterval: "15m"},
		},
	}}}
	sessions := &fakeOrchestratorEnsurer{send: true, sessions: []domain.Session{{
		SessionRecord: domain.SessionRecord{
			ID:            "mer-orch",
			ProjectID:     "mer",
			Kind:          domain.KindOrchestrator,
			Harness:       domain.HarnessClaudeCode,
			FirstSignalAt: now.Add(-17 * time.Minute),
			Activity: domain.Activity{
				State:          domain.ActivityWaitingInput,
				LastActivityAt: now.Add(-16 * time.Minute),
			},
		},
	}}}

	ensureOrchestrators(context.Background(), projects, sessions, nil, newOrchestratorWakeTracker(), now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.sends) != 1 {
		t.Fatalf("sends = %#v, want one wake", sessions.sends)
	}
	if sessions.sends[0].id != "mer-orch" || !strings.Contains(strings.ToLower(sessions.sends[0].message), "continue your supervision loop") {
		t.Fatalf("wake send = %#v, want supervision nudge to mer-orch", sessions.sends[0])
	}
}

func TestEnsureOrchestratorsWakesIdleOrchestrator(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{
		ID: "mer",
		Config: domain.ProjectConfig{
			Orchestrator: domain.RoleOverride{WakeInterval: "15m"},
		},
	}}}
	sessions := &fakeOrchestratorEnsurer{send: true, sessions: []domain.Session{{
		SessionRecord: domain.SessionRecord{
			ID:            "mer-orch",
			ProjectID:     "mer",
			Kind:          domain.KindOrchestrator,
			Harness:       domain.HarnessCodex,
			FirstSignalAt: now.Add(-17 * time.Minute),
			Activity: domain.Activity{
				State:          domain.ActivityIdle,
				LastActivityAt: now.Add(-16 * time.Minute),
			},
		},
	}}}

	ensureOrchestrators(context.Background(), projects, sessions, nil, newOrchestratorWakeTracker(), now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.sends) != 1 {
		t.Fatalf("sends = %#v, want one wake", sessions.sends)
	}
}

func TestEnsureOrchestratorsDoesNotWakeHooklessHarness(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{send: true, sessions: []domain.Session{{
		SessionRecord: domain.SessionRecord{
			ID:            "mer-orch",
			ProjectID:     "mer",
			Kind:          domain.KindOrchestrator,
			Harness:       domain.HarnessAider,
			FirstSignalAt: now.Add(-17 * time.Minute),
			Activity: domain.Activity{
				State:          domain.ActivityIdle,
				LastActivityAt: now.Add(-1 * time.Hour),
			},
		},
	}}}

	ensureOrchestrators(context.Background(), projects, sessions, nil, newOrchestratorWakeTracker(), now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.sends) != 0 {
		t.Fatalf("hookless orchestrator must not be woken, sends=%#v", sessions.sends)
	}
}

func TestEnsureOrchestratorsDoesNotWakeBeforeFirstSignal(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{send: true, sessions: []domain.Session{{
		SessionRecord: domain.SessionRecord{
			ID:        "mer-orch",
			ProjectID: "mer",
			Kind:      domain.KindOrchestrator,
			Harness:   domain.HarnessClaudeCode,
			Activity: domain.Activity{
				State:          domain.ActivityIdle,
				LastActivityAt: now.Add(-1 * time.Hour),
			},
		},
	}}}

	ensureOrchestrators(context.Background(), projects, sessions, nil, newOrchestratorWakeTracker(), now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.sends) != 0 {
		t.Fatalf("sends = %#v, want no wake before first observed activity signal", sessions.sends)
	}
}

func TestEnsureOrchestratorsDoesNotWakeBlockedOrchestrator(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{sessions: []domain.Session{{
		SessionRecord: domain.SessionRecord{
			ID:            "mer-orch",
			ProjectID:     "mer",
			Kind:          domain.KindOrchestrator,
			Harness:       domain.HarnessClaudeCode,
			FirstSignalAt: now.Add(-2 * time.Hour),
			Activity: domain.Activity{
				State:          domain.ActivityBlocked,
				LastActivityAt: now.Add(-1 * time.Hour),
			},
		},
	}}}

	ensureOrchestrators(context.Background(), projects, sessions, nil, newOrchestratorWakeTracker(), now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.sends) != 0 {
		t.Fatalf("blocked orchestrator must not be woken, sends=%#v", sessions.sends)
	}
	if len(sessions.cleanCalls) != 0 {
		t.Fatalf("blocked orchestrator must not be replaced, cleanCalls=%#v", sessions.cleanCalls)
	}
}

func TestEnsureOrchestratorsReplacesStaleNoSignalOrchestrator(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{sessions: []domain.Session{{
		SessionRecord: domain.SessionRecord{
			ID:        "mer-orch",
			ProjectID: "mer",
			Kind:      domain.KindOrchestrator,
			Harness:   domain.HarnessCodex,
			Activity: domain.Activity{
				State:          domain.ActivityIdle,
				LastActivityAt: now.Add(-orchestratorUnhealthyReplacementThreshold - time.Minute),
			},
		},
		Status: domain.StatusNoSignal,
	}}}
	notifier := &fakeOrchestratorNotifier{}

	ensureOrchestrators(context.Background(), projects, sessions, notifier, newOrchestratorWakeTracker(), now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.cleanCalls) != 1 || sessions.cleanCalls[0] != "mer" {
		t.Fatalf("clean replacements = %#v, want one for mer", sessions.cleanCalls)
	}
	if len(sessions.sends) != 0 {
		t.Fatalf("replaced no_signal orchestrator should not also receive wake, sends=%#v", sessions.sends)
	}
	if len(notifier.intents) != 1 {
		t.Fatalf("notifications = %#v, want one replacement notification", notifier.intents)
	}
	if got := notifier.intents[0]; got.Type != domain.NotificationOrchestratorReplaced || got.SessionID != "mer-orch-replacement" || got.ProjectID != "mer" {
		t.Fatalf("notification = %#v, want orchestrator replacement for new session", got)
	}
}

func TestEnsureOrchestratorsReplacesExitedOrchestratorRow(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{sessions: []domain.Session{{
		SessionRecord: domain.SessionRecord{
			ID:        "mer-orch",
			ProjectID: "mer",
			Kind:      domain.KindOrchestrator,
			Harness:   domain.HarnessCodex,
			Activity: domain.Activity{
				State:          domain.ActivityExited,
				LastActivityAt: now.Add(-orchestratorUnhealthyReplacementThreshold - time.Minute),
			},
		},
		Status: domain.StatusIdle,
	}}}

	ensureOrchestrators(context.Background(), projects, sessions, nil, newOrchestratorWakeTracker(), now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.cleanCalls) != 1 || sessions.cleanCalls[0] != "mer" {
		t.Fatalf("clean replacements = %#v, want exited orchestrator replaced", sessions.cleanCalls)
	}
}

func TestEnsureOrchestratorsCapsReplacementStormAndNotifies(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	staleActivity := domain.Activity{
		State:          domain.ActivityIdle,
		LastActivityAt: now.Add(-orchestratorUnhealthyReplacementThreshold - time.Minute),
	}
	sessions := &fakeOrchestratorEnsurer{
		replStatus:   domain.StatusNoSignal,
		replActivity: staleActivity,
		sessions: []domain.Session{{
			SessionRecord: domain.SessionRecord{
				ID:        "mer-orch",
				ProjectID: "mer",
				Kind:      domain.KindOrchestrator,
				Harness:   domain.HarnessCodex,
				Activity:  staleActivity,
			},
			Status: domain.StatusNoSignal,
		}},
	}
	notifier := &fakeOrchestratorNotifier{}
	tracker := newOrchestratorWakeTracker()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	for i := 0; i < orchestratorMaxReplacementsPerWindow+2; i++ {
		ensureOrchestrators(context.Background(), projects, sessions, notifier, tracker, now.Add(time.Duration(i)*time.Minute), log)
	}

	if len(sessions.cleanCalls) != orchestratorMaxReplacementsPerWindow {
		t.Fatalf("clean replacements = %d, want cap %d", len(sessions.cleanCalls), orchestratorMaxReplacementsPerWindow)
	}
	if len(notifier.intents) != orchestratorMaxReplacementsPerWindow+1 {
		t.Fatalf("notifications = %#v, want one per replacement plus one cap alert", notifier.intents)
	}
	if got := notifier.intents[len(notifier.intents)-1]; got.Type != domain.NotificationOrchestratorReplacementCapped {
		t.Fatalf("last notification = %#v, want replacement cap alert", got)
	}
}

func TestEnsureOrchestratorsThrottlesRepeatedWake(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{
		send: true,
		sessions: []domain.Session{{
			SessionRecord: domain.SessionRecord{
				ID:            "mer-orch",
				ProjectID:     "mer",
				Kind:          domain.KindOrchestrator,
				Harness:       domain.HarnessClaudeCode,
				FirstSignalAt: now.Add(-2 * time.Hour),
				Activity: domain.Activity{
					State:          domain.ActivityWaitingInput,
					LastActivityAt: now.Add(-1 * time.Hour),
				},
			},
		}},
	}
	wakes := newOrchestratorWakeTracker()

	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(30*time.Second), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(16*time.Minute), slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.sends) != 2 {
		t.Fatalf("sends = %#v, want initial wake and post-interval wake", sessions.sends)
	}
}

func TestEnsureOrchestratorsDoesNotThrottleSuppressedWake(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{
		send: false,
		sessions: []domain.Session{{
			SessionRecord: domain.SessionRecord{
				ID:            "mer-orch",
				ProjectID:     "mer",
				Kind:          domain.KindOrchestrator,
				Harness:       domain.HarnessClaudeCode,
				FirstSignalAt: now.Add(-2 * time.Hour),
				Activity: domain.Activity{
					State:          domain.ActivityWaitingInput,
					LastActivityAt: now.Add(-1 * time.Hour),
				},
			},
		}},
	}
	wakes := newOrchestratorWakeTracker()

	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if !wakes.projects["mer"].lastWake.IsZero() {
		t.Fatalf("suppressed wake stamped lastWake = %s, want zero", wakes.projects["mer"].lastWake)
	}
}

func TestEnsureOrchestratorsThrottlesFailedWakeAttempt(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{
		sendErr: errors.New("pane write failed"),
		sessions: []domain.Session{{
			SessionRecord: domain.SessionRecord{
				ID:            "mer-orch",
				ProjectID:     "mer",
				Kind:          domain.KindOrchestrator,
				Harness:       domain.HarnessClaudeCode,
				FirstSignalAt: now.Add(-2 * time.Hour),
				Activity: domain.Activity{
					State:          domain.ActivityWaitingInput,
					LastActivityAt: now.Add(-1 * time.Hour),
				},
			},
		}},
	}
	wakes := newOrchestratorWakeTracker()

	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(30*time.Second), slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.sends) != 1 {
		t.Fatalf("sends = %#v, want failed wake attempt throttled", sessions.sends)
	}
	if wakes.projects["mer"].lastWake.IsZero() {
		t.Fatal("failed wake attempt did not stamp lastWake")
	}
}

func TestEnsureOrchestratorsFailedWakeDoesNotConsumeUnansweredCap(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{
		sendErr: errors.New("pane write failed"),
		sessions: []domain.Session{{
			SessionRecord: domain.SessionRecord{
				ID:            "mer-orch",
				ProjectID:     "mer",
				Kind:          domain.KindOrchestrator,
				Harness:       domain.HarnessClaudeCode,
				FirstSignalAt: now.Add(-2 * time.Hour),
				Activity: domain.Activity{
					State:          domain.ActivityWaitingInput,
					LastActivityAt: now.Add(-1 * time.Hour),
				},
			},
		}},
	}
	wakes := newOrchestratorWakeTracker()

	for i := 0; i < orchestratorMaxUnansweredWakeSends+1; i++ {
		ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(time.Duration(i)*16*time.Minute), slog.New(slog.NewTextHandler(io.Discard, nil)))
	}

	if len(sessions.sends) != orchestratorMaxUnansweredWakeSends+1 {
		t.Fatalf("failed wake attempts = %#v, want attempts to continue past unanswered-send cap", sessions.sends)
	}
	if got := wakes.projects["mer"].unanswered; got != 0 {
		t.Fatalf("failed wake unanswered count = %d, want 0", got)
	}

	sessions.sendErr = nil
	sessions.send = true
	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(time.Duration(orchestratorMaxUnansweredWakeSends+1)*16*time.Minute), slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.sends) != orchestratorMaxUnansweredWakeSends+2 {
		t.Fatalf("recovered wake attempts = %#v, want delivered wake after failures", sessions.sends)
	}
	if got := wakes.projects["mer"].unanswered; got != 1 {
		t.Fatalf("delivered wake unanswered count = %d, want 1", got)
	}
}

func TestEnsureOrchestratorsFailedWakePreservesDeliveredWakeCap(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{
		send: true,
		sessions: []domain.Session{{
			SessionRecord: domain.SessionRecord{
				ID:            "mer-orch",
				ProjectID:     "mer",
				Kind:          domain.KindOrchestrator,
				Harness:       domain.HarnessClaudeCode,
				FirstSignalAt: now.Add(-2 * time.Hour),
				Activity: domain.Activity{
					State:          domain.ActivityWaitingInput,
					LastActivityAt: now.Add(-1 * time.Hour),
				},
			},
		}},
	}
	wakes := newOrchestratorWakeTracker()

	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(16*time.Minute), slog.New(slog.NewTextHandler(io.Discard, nil)))

	sessions.sendErr = errors.New("pane write failed")
	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(32*time.Minute), slog.New(slog.NewTextHandler(io.Discard, nil)))

	sessions.sendErr = nil
	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(48*time.Minute), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(64*time.Minute), slog.New(slog.NewTextHandler(io.Discard, nil)))

	if len(sessions.sends) != orchestratorMaxUnansweredWakeSends+1 {
		t.Fatalf("wake attempts = %#v, want two delivered, one failed, one delivered, then cap", sessions.sends)
	}
	if got := wakes.projects["mer"].unanswered; got != orchestratorMaxUnansweredWakeSends {
		t.Fatalf("delivered wake unanswered count = %d, want cap %d", got, orchestratorMaxUnansweredWakeSends)
	}
}

func TestEnsureOrchestratorsStopsAfterUnansweredWakeLimit(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{
		send: true,
		sessions: []domain.Session{{
			SessionRecord: domain.SessionRecord{
				ID:            "mer-orch",
				ProjectID:     "mer",
				Kind:          domain.KindOrchestrator,
				Harness:       domain.HarnessClaudeCode,
				FirstSignalAt: now.Add(-2 * time.Hour),
				Activity: domain.Activity{
					State:          domain.ActivityWaitingInput,
					LastActivityAt: now.Add(-1 * time.Hour),
				},
			},
		}},
	}
	wakes := newOrchestratorWakeTracker()
	var logBuf strings.Builder
	log := slog.New(slog.NewTextHandler(&logBuf, nil))

	for i := 0; i < orchestratorMaxUnansweredWakeSends+2; i++ {
		ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(time.Duration(i)*16*time.Minute), log)
	}

	if len(sessions.sends) != orchestratorMaxUnansweredWakeSends {
		t.Fatalf("sends = %#v, want capped at %d unanswered wakes", sessions.sends, orchestratorMaxUnansweredWakeSends)
	}
	if got := logBuf.String(); !strings.Contains(got, "wake retry limit reached") {
		t.Fatalf("log = %q, want retry-limit warning", got)
	}
}

func TestEnsureOrchestratorsPrunesStaleWakeMemo(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{sessions: []domain.Session{{
		SessionRecord: domain.SessionRecord{
			ID:            "mer-orch",
			ProjectID:     "mer",
			Kind:          domain.KindOrchestrator,
			Harness:       domain.HarnessClaudeCode,
			FirstSignalAt: now.Add(-time.Minute),
			Activity:      domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
		},
	}}}
	wakes := newOrchestratorWakeTracker()
	wakes.projects["stale-project"] = orchestratorWakeState{lastWake: now}

	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if _, ok := wakes.projects["stale-project"]; ok {
		t.Fatalf("stale wake memo was not pruned: %#v", wakes.projects)
	}
}

func TestEnsureOrchestratorsKeepsWakeMemoOnEnsureError(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	projects := fakeOrchestratorProjectLister{projects: []projectsvc.Summary{{ID: "mer"}}}
	sessions := &fakeOrchestratorEnsurer{spawnErr: errors.New("temporary project resolve failure")}
	wakes := newOrchestratorWakeTracker()
	wakes.projects["mer"] = orchestratorWakeState{lastWake: now}

	ensureOrchestrators(context.Background(), projects, sessions, nil, wakes, now.Add(30*time.Second), slog.New(slog.NewTextHandler(io.Discard, nil)))

	if wakes.projects["mer"].lastWake.IsZero() {
		t.Fatal("wake memo for project with transient ensure error was pruned")
	}
}
