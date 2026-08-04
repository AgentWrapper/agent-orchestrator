package review

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/reviewer/greptile"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeReviewer struct {
	gotInv ports.ReviewInvocation
}

func (f *fakeReviewer) ReviewCommand(_ context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	f.gotInv = inv
	return ports.ReviewCommandSpec{Argv: []string{"greptile", "review"}}, nil
}
func (f *fakeReviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	f.gotInv = inv
	return inv.Prompt, nil
}

type fakePreLaunchReviewer struct {
	fakeReviewer
	prelaunched bool
	gotPre      ports.ReviewInvocation
}

type fakeOneShotReviewer struct {
	fakeReviewer
	result ports.ReviewResult
}

func (f *fakeOneShotReviewer) ParseReviewResult([]byte) (ports.ReviewResult, error) {
	return f.result, nil
}

func (f *fakePreLaunchReviewer) PreLaunch(_ context.Context, inv ports.ReviewInvocation) error {
	f.prelaunched = true
	f.gotPre = inv
	return nil
}

type fakeCancellableReviewer struct {
	fakeReviewer
	cancelled  bool
	cancelErr  error
	mode       ports.ReviewCancelMode
	interrupts int
}

func (f *fakeCancellableReviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	f.cancelled = true
	if f.cancelErr != nil {
		return ports.ReviewCancelSpec{}, f.cancelErr
	}
	mode := f.mode
	if mode == "" {
		mode = ports.ReviewCancelInterrupt
	}
	return ports.ReviewCancelSpec{Mode: mode, Interrupts: f.interrupts}, nil
}

type fakeReviewerForPreflight struct {
	CommandErr error
	Argv       []string
	Auth       ports.AgentAuthStatus
	AuthErr    error
}

func (f *fakeReviewerForPreflight) ReviewCommand(_ context.Context, _ ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	if f.CommandErr != nil {
		return ports.ReviewCommandSpec{}, f.CommandErr
	}
	return ports.ReviewCommandSpec{Argv: f.Argv}, nil
}

func (f *fakeReviewerForPreflight) ReviewMessage(_ context.Context, _ ports.ReviewInvocation) (string, error) {
	return "", nil
}

func (f *fakeReviewerForPreflight) AuthStatus(context.Context) (ports.AgentAuthStatus, error) {
	return f.Auth, f.AuthErr
}

type fakeReviewerResolver struct {
	reviewer ports.Reviewer
	ok       bool
}

func (f fakeReviewerResolver) Reviewer(domain.ReviewerHarness) (ports.Reviewer, bool) {
	return f.reviewer, f.ok
}

type fakeRuntime struct {
	createCfg     ports.RuntimeConfig
	sentMsg       string
	sentMsgs      []string
	sentTo        string
	alive         bool
	aliveErr      error
	interrupt     string
	interrupts    int
	destroyed     string
	destroyBefore bool
	created       bool
}

type fakeTerminalRuntime struct{ fakeRuntime }

func (f *fakeTerminalRuntime) Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	if len(cfg.Argv) == 3 && cfg.Argv[1] == "review-terminal" {
		_ = os.WriteFile(greptile.TerminalResultPath(cfg.Argv[2]), []byte(`{"complete":true,"results":[{"runId":"run-terminal","prUrl":"https://github.com/o/r/pull/1","targetSha":"sha1","verdict":"approved","body":"Looks good."}]}`), 0o600)
	}
	return f.fakeRuntime.Create(ctx, cfg)
}

func (f *fakeTerminalRuntime) GetOutput(context.Context, ports.RuntimeHandle, int) (string, error) {
	return "", nil
}

func (f *fakeRuntime) Create(_ context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	f.createCfg = cfg
	f.created = true
	return ports.RuntimeHandle{ID: string(cfg.SessionID)}, nil
}
func (f *fakeRuntime) Destroy(_ context.Context, handle ports.RuntimeHandle) error {
	f.destroyed = handle.ID
	if !f.created {
		f.destroyBefore = true
	}
	return nil
}
func (f *fakeRuntime) IsAlive(_ context.Context, _ ports.RuntimeHandle) (bool, error) {
	return f.alive, f.aliveErr
}
func (f *fakeRuntime) Interrupt(_ context.Context, handle ports.RuntimeHandle) error {
	f.interrupt = handle.ID
	f.interrupts++
	return nil
}
func (f *fakeRuntime) SendMessage(_ context.Context, handle ports.RuntimeHandle, msg string) error {
	f.sentTo = handle.ID
	f.sentMsg = msg
	f.sentMsgs = append(f.sentMsgs, msg)
	return nil
}

func launchSpec() LaunchSpec {
	return LaunchSpec{
		RunID: "run-1", BatchID: "batch-1", WorkerID: "mer-1", Harness: domain.ReviewerClaudeCode,
		WorkspacePath: "/ws/mer-1", PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha1",
	}
}

func newTestLauncher(t *testing.T, reviewer ports.Reviewer, rt reviewerRuntime) Launcher {
	t.Helper()
	return NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, rt, t.TempDir())
}

func TestLauncherSpawnReturnsStableHandle(t *testing.T) {
	reviewer := &fakeReviewer{}
	rt := &fakeRuntime{}
	dataDir := t.TempDir()
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, rt, dataDir)

	handle, err := l.Spawn(context.Background(), launchSpec())
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if handle != "review-mer-1" {
		t.Fatalf("handle = %q, want review-mer-1", handle)
	}
	if rt.createCfg.WorkspacePath != "/ws/mer-1" || len(rt.createCfg.Argv) == 0 || rt.createCfg.Argv[0] != "greptile" {
		t.Fatalf("create cfg = %+v", rt.createCfg)
	}
	// No environment is used to carry review identity.
	if len(rt.createCfg.Env) != 0 {
		t.Fatalf("expected no env, got %v", rt.createCfg.Env)
	}
	if reviewer.gotInv.RunID != "run-1" || reviewer.gotInv.TargetSHA != "sha1" || reviewer.gotInv.ReviewerID != "review-mer-1" {
		t.Fatalf("invocation = %+v", reviewer.gotInv)
	}
	if !strings.HasPrefix(reviewer.gotInv.Prompt, reviewerTaskMessagePrefix) || reviewer.gotInv.SystemPrompt != "" || reviewer.gotInv.SystemPromptFile == "" || reviewer.gotInv.TaskPromptFile == "" {
		t.Fatalf("hidden prompt invocation = %+v", reviewer.gotInv)
	}
	promptRoot := filepath.Join(dataDir, "prompts", "mer-1", "reviewer")
	taskPath := filepath.Join(promptRoot, "requests", "batch-1", "run-1", "task.md")
	if reviewer.gotInv.TaskPromptFile != taskPath || reviewer.gotInv.TaskPromptRoot != promptRoot {
		t.Fatalf("task prompt file = %q", reviewer.gotInv.TaskPromptFile)
	}
	task, err := os.ReadFile(taskPath)
	if err != nil {
		t.Fatalf("read task prompt: %v", err)
	}
	if !strings.Contains(string(task), "https://github.com/o/r/pull/1") || strings.Contains(reviewer.gotInv.Prompt, "https://github.com/o/r/pull/1") {
		t.Fatalf("task file = %q, visible prompt = %q", task, reviewer.gotInv.Prompt)
	}
	system, err := os.ReadFile(reviewer.gotInv.SystemPromptFile)
	if err != nil {
		t.Fatalf("read system prompt: %v", err)
	}
	if !strings.Contains(string(system), "Code reviewer role") || !strings.Contains(string(system), "exact file path in that request") || strings.Contains(string(system), filepath.ToSlash(taskPath)) {
		t.Fatalf("system prompt = %q", system)
	}
}

func TestLauncherRunsOneShotReviewerWithoutRuntimePane(t *testing.T) {
	reviewer := &fakeOneShotReviewer{result: ports.ReviewResult{
		Verdict: domain.VerdictChangesRequested,
		Body:    "fix the race",
	}}
	rt := &fakeRuntime{}
	completed := make(chan []ReviewCompletion, 1)
	launcher := NewLauncher(
		fakeReviewerResolver{reviewer: reviewer, ok: true},
		rt,
		t.TempDir(),
		WithCompletionHandler(func(_ context.Context, workerID domain.SessionID, completions []ReviewCompletion) {
			if workerID != "mer-1" {
				t.Errorf("worker id = %q", workerID)
			}
			completed <- completions
		}),
	).(*agentLauncher)
	launcher.execute = func(_ context.Context, workspacePath string, command ports.ReviewCommandSpec) ([]byte, []byte, error) {
		if workspacePath != "/ws/repo" {
			t.Errorf("workspace path = %q", workspacePath)
		}
		if got := strings.Join(command.Argv, " "); got != "greptile review" {
			t.Errorf("command = %q", got)
		}
		return []byte(`{"comments":[]}`), nil, nil
	}

	spec := launchSpec()
	spec.Harness = domain.ReviewerGreptile
	spec.ReviewQueue = []ports.ReviewTask{{
		RunID:         "run-1",
		PRURL:         spec.PRURL,
		TargetSHA:     spec.TargetSHA,
		TargetBranch:  "main",
		WorkspacePath: "/ws/repo",
	}}
	handle, err := launcher.Spawn(context.Background(), spec)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if handle != "review-mer-1" {
		t.Fatalf("handle = %q", handle)
	}
	select {
	case completions := <-completed:
		if len(completions) != 1 || completions[0].RunID != "run-1" ||
			completions[0].Verdict != domain.VerdictChangesRequested || completions[0].Body != "fix the race" {
			t.Fatalf("completions = %+v", completions)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for one-shot completion")
	}
	if rt.created {
		t.Fatal("one-shot reviewer unexpectedly created a runtime pane")
	}
}

func TestLauncherRunsGreptileThroughDisplayTerminal(t *testing.T) {
	rt := &fakeTerminalRuntime{}
	completed := make(chan []ReviewCompletion, 1)
	launcher := NewLauncher(
		fakeReviewerResolver{reviewer: greptile.New(), ok: true},
		rt,
		t.TempDir(),
		WithCompletionHandler(func(_ context.Context, _ domain.SessionID, completions []ReviewCompletion) {
			completed <- completions
		}),
	)
	spec := launchSpec()
	spec.Harness = domain.ReviewerGreptile
	spec.ReviewQueue = []ports.ReviewTask{{RunID: "run-terminal", PRURL: spec.PRURL, TargetSHA: spec.TargetSHA, TargetBranch: "main", WorkspacePath: spec.WorkspacePath}}
	handle, err := launcher.Spawn(context.Background(), spec)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if handle != "review-mer-1" || len(rt.createCfg.Argv) != 3 || !filepath.IsAbs(rt.createCfg.Argv[0]) || rt.createCfg.Argv[1] != "review-terminal" {
		t.Fatalf("terminal config = %+v", rt.createCfg)
	}
	if rt.createCfg.TerminalBehavior != ports.TerminalOutputOnly {
		t.Fatalf("terminal behavior = %q, want output-only", rt.createCfg.TerminalBehavior)
	}
	select {
	case completions := <-completed:
		if len(completions) != 1 || completions[0].RunID != "run-terminal" || completions[0].Verdict != domain.VerdictApproved {
			t.Fatalf("completions = %+v", completions)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for terminal completion")
	}
}

func TestLauncherCancelsOneShotReviewer(t *testing.T) {
	reviewer := &fakeOneShotReviewer{}
	rt := &fakeRuntime{}
	started := make(chan struct{})
	completed := make(chan struct{}, 1)
	launcher := NewLauncher(
		fakeReviewerResolver{reviewer: reviewer, ok: true},
		rt,
		t.TempDir(),
		WithCompletionHandler(func(context.Context, domain.SessionID, []ReviewCompletion) {
			completed <- struct{}{}
		}),
	).(*agentLauncher)
	launcher.execute = func(ctx context.Context, _ string, _ ports.ReviewCommandSpec) ([]byte, []byte, error) {
		close(started)
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}

	spec := launchSpec()
	spec.Harness = domain.ReviewerGreptile
	handle, err := launcher.Spawn(context.Background(), spec)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	<-started
	if err := launcher.Cancel(context.Background(), handle, domain.ReviewerGreptile); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	select {
	case <-completed:
		t.Fatal("cancelled one-shot reviewer submitted a completion")
	case <-time.After(50 * time.Millisecond):
	}
	if rt.interrupts != 0 {
		t.Fatalf("runtime interrupts = %d", rt.interrupts)
	}
}

// Spawn must replace any stale pane on the stable per-worker handle before
// creating the new one — otherwise a reviewer-harness switch either collides
// with the old pane's tmux session name or leaves it serving under the old
// harness's sandbox/permissions/env (which are applied only at Create).
func TestLauncherSpawnReplacesStalePane(t *testing.T) {
	reviewer := &fakeReviewer{}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)

	if _, err := l.Spawn(context.Background(), launchSpec()); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if rt.destroyed != "review-mer-1" {
		t.Fatalf("stale pane not destroyed: destroyed=%q, want review-mer-1", rt.destroyed)
	}
	if !rt.destroyBefore {
		t.Fatal("stale pane must be destroyed before the fresh pane is created")
	}
}

func TestLauncherSpawnRunsReviewerPreLaunch(t *testing.T) {
	reviewer := &fakePreLaunchReviewer{}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)

	if _, err := l.Spawn(context.Background(), launchSpec()); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if !reviewer.prelaunched {
		t.Fatal("expected reviewer pre-launch to run")
	}
	if reviewer.gotPre.ReviewerID != "review-mer-1" || reviewer.gotPre.WorkspacePath != "/ws/mer-1" {
		t.Fatalf("prelaunch invocation = %+v", reviewer.gotPre)
	}
	if rt.createCfg.WorkspacePath == "" {
		t.Fatal("runtime should still be created after pre-launch")
	}
}

func TestLauncherNotifySendsMessageToHandle(t *testing.T) {
	reviewer := &fakeReviewer{}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)

	if err := l.Notify(context.Background(), "review-mer-1", launchSpec()); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if rt.sentTo != "review-mer-1" || !strings.HasPrefix(rt.sentMsg, reviewerTaskMessagePrefix) {
		t.Fatalf("sent to %q msg %q", rt.sentTo, rt.sentMsg)
	}
	if strings.Contains(reviewer.gotInv.Prompt, reviewer.gotInv.PRURL) || reviewer.gotInv.SystemPromptFile == "" || reviewer.gotInv.TaskPromptFile == "" {
		t.Fatalf("visible invocation = %+v", reviewer.gotInv)
	}
}

func TestLauncherNotifyKeepsEarlierTaskReferenceImmutable(t *testing.T) {
	reviewer := &fakeReviewer{}
	rt := &fakeRuntime{}
	dataDir := t.TempDir()
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, rt, dataDir)

	first := launchSpec()
	if err := l.Notify(context.Background(), "review-mer-1", first); err != nil {
		t.Fatalf("first Notify: %v", err)
	}
	second := launchSpec()
	second.BatchID = "batch-2"
	second.RunID = "run-2"
	second.PRURL = "https://github.com/o/r/pull/2"
	second.TargetSHA = "sha2"
	if err := l.Notify(context.Background(), "review-mer-1", second); err != nil {
		t.Fatalf("second Notify: %v", err)
	}

	promptRoot := filepath.Join(dataDir, "prompts", "mer-1", "reviewer")
	firstPath := filepath.Join(promptRoot, "requests", "batch-1", "run-1", "task.md")
	secondPath := filepath.Join(promptRoot, "requests", "batch-2", "run-2", "task.md")
	if len(rt.sentMsgs) != 2 || !strings.Contains(rt.sentMsgs[0], filepath.ToSlash(firstPath)) || !strings.Contains(rt.sentMsgs[1], filepath.ToSlash(secondPath)) {
		t.Fatalf("review messages = %#v", rt.sentMsgs)
	}
	firstTask, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatalf("read first task: %v", err)
	}
	secondTask, err := os.ReadFile(secondPath)
	if err != nil {
		t.Fatalf("read second task: %v", err)
	}
	if !strings.Contains(string(firstTask), first.PRURL) || strings.Contains(string(firstTask), second.PRURL) {
		t.Fatalf("first task changed after second notification: %q", firstTask)
	}
	if !strings.Contains(string(secondTask), second.PRURL) || strings.Contains(string(secondTask), first.PRURL) {
		t.Fatalf("second task = %q", secondTask)
	}
}

func TestLauncherAlive(t *testing.T) {
	l := NewLauncher(fakeReviewerResolver{ok: true}, &fakeRuntime{alive: true}, t.TempDir())
	if ok, _ := l.Alive(context.Background(), "review-mer-1"); !ok {
		t.Fatal("want alive true")
	}
	if ok, _ := l.Alive(context.Background(), ""); ok {
		t.Fatal("empty handle should not be alive")
	}
}

func TestLauncherCancelUsesReviewerCancelMode(t *testing.T) {
	reviewer := &fakeCancellableReviewer{interrupts: 2}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)

	if err := l.Cancel(context.Background(), "review-mer-1", domain.ReviewerClaudeCode); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !reviewer.cancelled {
		t.Fatal("expected reviewer cancel hook to run")
	}
	if rt.interrupt != "review-mer-1" {
		t.Fatalf("interrupt handle = %q, want review-mer-1", rt.interrupt)
	}
	if rt.interrupts != 2 {
		t.Fatalf("interrupt count = %d, want 2", rt.interrupts)
	}
}

func TestLauncherCancelRequiresReviewerSupport(t *testing.T) {
	l := newTestLauncher(t, &fakeReviewer{}, &fakeRuntime{})

	if err := l.Cancel(context.Background(), "review-mer-1", domain.ReviewerClaudeCode); err == nil || !strings.Contains(err.Error(), "does not support cancellation") {
		t.Fatalf("err = %v, want unsupported cancellation", err)
	}
}

func TestLauncherSpawnNoAdapter(t *testing.T) {
	l := NewLauncher(fakeReviewerResolver{ok: false}, &fakeRuntime{}, t.TempDir())
	if _, err := l.Spawn(context.Background(), launchSpec()); err == nil || !strings.Contains(err.Error(), "no reviewer adapter") {
		t.Fatalf("err = %v, want no-adapter", err)
	}
}

func TestLauncherPreflightResolvesAdapter(t *testing.T) {
	reviewer := &fakeReviewerForPreflight{Argv: []string{"go"}}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, &fakeRuntime{}, "")
	if err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1"); err != nil {
		t.Fatalf("Preflight: %v", err)
	}
}

func TestLauncherPreflightRejectsUnauthenticatedReviewer(t *testing.T) {
	reviewer := &fakeReviewerForPreflight{Argv: []string{"go"}, Auth: ports.AgentAuthStatusUnauthorized}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, &fakeRuntime{}, "")
	err := l.Preflight(context.Background(), domain.ReviewerGreptile, "/ws/mer-1")
	if err == nil || !errors.Is(err, ports.ErrReviewerNotAuthenticated) {
		t.Fatalf("err = %v, want reviewer auth sentinel", err)
	}
	for _, want := range []string{"Greptile CLI is not authenticated", "greptile login", "retry"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %q, want %q", err, want)
		}
	}
}

func TestLauncherPreflightNoAdapter(t *testing.T) {
	l := NewLauncher(fakeReviewerResolver{ok: false}, &fakeRuntime{}, "")
	if err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1"); err == nil || !strings.Contains(err.Error(), "no reviewer adapter") {
		t.Fatalf("err = %v, want 'no reviewer adapter'", err)
	}
}

func TestLauncherPreflightReviewCommandError(t *testing.T) {
	reviewer := &fakeReviewerForPreflight{CommandErr: errors.New("reviewer unavailable")}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, &fakeRuntime{}, "")
	if err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1"); err == nil || !strings.Contains(err.Error(), "reviewer unavailable") {
		t.Fatalf("err = %v, want containing 'reviewer unavailable'", err)
	}
}

func TestLauncherPreflightEmptyArgv(t *testing.T) {
	reviewer := &fakeReviewerForPreflight{}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, &fakeRuntime{}, "")
	if err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1"); err == nil || !strings.Contains(err.Error(), "empty command") {
		t.Fatalf("err = %v, want 'empty command'", err)
	}
}

func TestLauncherPreflightBinaryNotFound(t *testing.T) {
	reviewer := &fakeReviewerForPreflight{Argv: []string{"this-binary-does-not-exist-12345"}}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, &fakeRuntime{}, "")
	err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1")
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err = %v, want 'not found'", err)
	}
	if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
		t.Fatalf("err = %v, want ErrAgentBinaryNotFound", err)
	}
}

func TestLauncherPreflightGreptileMissingIsActionable(t *testing.T) {
	reviewer := &fakeReviewerForPreflight{Argv: []string{"greptile-binary-does-not-exist-12345"}}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, &fakeRuntime{}, "")
	err := l.Preflight(context.Background(), domain.ReviewerGreptile, "/ws/mer-1")
	if err == nil || !errors.Is(err, ports.ErrAgentBinaryNotFound) {
		t.Fatalf("err = %v, want missing-binary sentinel", err)
	}
	for _, want := range []string{"Greptile CLI is not installed", "greptile login", "retry"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %q, want %q", err, want)
		}
	}
}

func writeRecoveryRequest(t *testing.T, dataDir string) (ports.ReviewTask, string) {
	t.Helper()
	task := ports.ReviewTask{RunID: "run-recover", PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha-recover", TargetBranch: "main", WorkspacePath: "/ws/repo"}
	spec := LaunchSpec{RunID: task.RunID, BatchID: "batch-recover", WorkerID: "mer-1", Harness: domain.ReviewerGreptile}
	path, err := terminalRequestPath(dataDir, spec, 1)
	if err != nil {
		t.Fatalf("terminalRequestPath: %v", err)
	}
	if _, err := greptile.New().PrepareTerminalRequest(path, []ports.ReviewTask{task}); err != nil {
		t.Fatalf("PrepareTerminalRequest: %v", err)
	}
	return task, path
}

func TestTerminalRequestPathUsesDurableBatchAndRunIdentity(t *testing.T) {
	first, err := terminalRequestPath("C:\\ao-data", LaunchSpec{RunID: "run-1", BatchID: "batch-1", WorkerID: "worker-1"}, 99)
	if err != nil {
		t.Fatalf("first path: %v", err)
	}
	second, err := terminalRequestPath("C:\\ao-data", LaunchSpec{RunID: "run-2", BatchID: "batch-1", WorkerID: "worker-1"}, 1)
	if err != nil {
		t.Fatalf("second path: %v", err)
	}
	if first == second || !strings.Contains(first, filepath.Join("batch-1", "run-1.json")) || !strings.Contains(second, filepath.Join("batch-1", "run-2.json")) {
		t.Fatalf("paths = %q, %q", first, second)
	}
	if _, err := terminalRequestPath("C:\\ao-data", LaunchSpec{RunID: "../old", BatchID: "batch-1", WorkerID: "worker-1"}, 1); err == nil {
		t.Fatal("unsafe run id was accepted")
	}
}

func TestLauncherRecoversCompleteGreptileSidecarOnce(t *testing.T) {
	dataDir := t.TempDir()
	task, path := writeRecoveryRequest(t, dataDir)
	resultPath := greptile.TerminalResultPath(path)
	if err := os.WriteFile(resultPath, []byte(`{"complete":true,"results":[{"runId":"run-recover","prUrl":"https://github.com/o/r/pull/1","targetSha":"sha-recover","verdict":"approved","body":"recovered"}]}`), 0o600); err != nil {
		t.Fatalf("write result: %v", err)
	}
	completed := make(chan []ReviewCompletion, 2)
	launcher := NewLauncher(fakeReviewerResolver{reviewer: greptile.New(), ok: true}, &fakeTerminalRuntime{}, dataDir, WithCompletionHandler(func(_ context.Context, _ domain.SessionID, completions []ReviewCompletion) {
		completed <- completions
	})).(TerminalReviewRecoverer)
	if err := launcher.RecoverTerminalReviews(context.Background()); err != nil {
		t.Fatalf("RecoverTerminalReviews: %v", err)
	}
	select {
	case completions := <-completed:
		if len(completions) != 1 || completions[0].RunID != task.RunID || completions[0].Body != "recovered" {
			t.Fatalf("completions = %+v", completions)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for recovered completion")
	}
	// A second explicit probe in the same daemon must not feed the same
	// sidecar to the completion handler twice.
	if err := launcher.RecoverTerminalReviews(context.Background()); err != nil {
		t.Fatalf("second RecoverTerminalReviews: %v", err)
	}
	select {
	case duplicate := <-completed:
		t.Fatalf("duplicate completion = %+v", duplicate)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestLauncherRecoversLiveGreptileTerminalAndResumesPolling(t *testing.T) {
	dataDir := t.TempDir()
	_, path := writeRecoveryRequest(t, dataDir)
	rt := &fakeTerminalRuntime{}
	rt.alive = true
	completed := make(chan []ReviewCompletion, 1)
	launcher := NewLauncher(fakeReviewerResolver{reviewer: greptile.New(), ok: true}, rt, dataDir, WithCompletionHandler(func(_ context.Context, _ domain.SessionID, completions []ReviewCompletion) {
		completed <- completions
	})).(TerminalReviewRecoverer)
	if err := launcher.RecoverTerminalReviews(context.Background()); err != nil {
		t.Fatalf("RecoverTerminalReviews: %v", err)
	}
	if err := os.WriteFile(greptile.TerminalResultPath(path), []byte(`{"complete":true,"results":[{"runId":"run-recover","prUrl":"https://github.com/o/r/pull/1","targetSha":"sha-recover","verdict":"approved","body":"resumed"}]}`), 0o600); err != nil {
		t.Fatalf("write result: %v", err)
	}
	select {
	case completions := <-completed:
		if len(completions) != 1 || completions[0].Body != "resumed" {
			t.Fatalf("completions = %+v", completions)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for resumed completion")
	}
}

func TestLauncherRecoverySkipsInactiveStaleRequest(t *testing.T) {
	dataDir := t.TempDir()
	_, _ = writeRecoveryRequest(t, dataDir)
	rt := &fakeTerminalRuntime{}
	launcher := NewLauncher(
		fakeReviewerResolver{reviewer: greptile.New(), ok: true},
		rt,
		dataDir,
		WithTerminalReviewActive(func(context.Context, domain.SessionID, []string) (bool, error) { return false, nil }),
	).(*agentLauncher)
	if err := launcher.RecoverTerminalReviews(context.Background()); err != nil {
		t.Fatalf("RecoverTerminalReviews: %v", err)
	}
	if alive, handled := launcher.oneShotAlive("review-mer-1"); handled || alive {
		t.Fatalf("stale request registered a watcher: alive=%v handled=%v", alive, handled)
	}
}

func TestLauncherRecoveryFailsWhenGreptileRuntimeIsGone(t *testing.T) {
	dataDir := t.TempDir()
	task, _ := writeRecoveryRequest(t, dataDir)
	completed := make(chan []ReviewCompletion, 1)
	launcher := NewLauncher(fakeReviewerResolver{reviewer: greptile.New(), ok: true}, &fakeTerminalRuntime{}, dataDir, WithCompletionHandler(func(_ context.Context, _ domain.SessionID, completions []ReviewCompletion) {
		completed <- completions
	})).(TerminalReviewRecoverer)
	if err := launcher.RecoverTerminalReviews(context.Background()); err != nil {
		t.Fatalf("RecoverTerminalReviews: %v", err)
	}
	select {
	case completions := <-completed:
		if len(completions) != 1 || completions[0].RunID != task.RunID || !strings.Contains(completions[0].Err.Error(), "ended before publishing") {
			t.Fatalf("completions = %+v", completions)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for dead-runtime failure")
	}
}

func TestLauncherRecoveryLeavesTransientLivenessProbeUnresolved(t *testing.T) {
	dataDir := t.TempDir()
	_, _ = writeRecoveryRequest(t, dataDir)
	rt := &fakeTerminalRuntime{}
	rt.aliveErr = errors.New("runtime probe unavailable")
	completed := make(chan []ReviewCompletion, 1)
	launcher := NewLauncher(fakeReviewerResolver{reviewer: greptile.New(), ok: true}, rt, dataDir, WithCompletionHandler(func(_ context.Context, _ domain.SessionID, completions []ReviewCompletion) {
		completed <- completions
	})).(TerminalReviewRecoverer)
	if err := launcher.RecoverTerminalReviews(context.Background()); err == nil {
		t.Fatal("expected transient probe error")
	}
	select {
	case completion := <-completed:
		t.Fatalf("transient probe produced completion = %+v", completion)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestLauncherCancelGreptileAfterRestartDestroysTerminal(t *testing.T) {
	rt := &fakeTerminalRuntime{}
	l := NewLauncher(fakeReviewerResolver{reviewer: greptile.New(), ok: true}, rt, t.TempDir())
	if err := l.Cancel(context.Background(), "review-mer-1", domain.ReviewerGreptile); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if rt.destroyed != "review-mer-1" {
		t.Fatalf("destroyed handle = %q, want review-mer-1", rt.destroyed)
	}
	if rt.interrupts != 0 {
		t.Fatalf("runtime interrupts = %d, want 0", rt.interrupts)
	}
}

func TestRunTerminalBatchHonorsPersistedDeadline(t *testing.T) {
	task := ports.ReviewTask{RunID: "run-timeout", PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha-timeout", WorkspacePath: "/ws/repo"}
	completed := make(chan []ReviewCompletion, 1)
	l := NewLauncher(fakeReviewerResolver{reviewer: greptile.New(), ok: true}, &fakeTerminalRuntime{}, t.TempDir(), WithCompletionHandler(func(_ context.Context, _ domain.SessionID, completions []ReviewCompletion) {
		completed <- completions
	})).(*agentLauncher)
	l.runTerminalBatch(context.Background(), "review-mer-1", 1, LaunchSpec{WorkerID: "mer-1"}, greptile.New(), filepath.Join(t.TempDir(), "missing.result.json"), []ports.ReviewTask{task}, time.Now().Add(25*time.Millisecond))
	select {
	case completions := <-completed:
		if len(completions) != 1 || !strings.Contains(completions[0].Err.Error(), "did not publish") {
			t.Fatalf("completions = %+v", completions)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for persisted deadline")
	}
}

func TestTerminalCompletionsRejectMismatchedPRIdentity(t *testing.T) {
	task := ports.ReviewTask{RunID: "run-1", PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha-1"}
	completions := terminalCompletions([]ports.ReviewTask{task}, ports.TerminalReviewResult{
		Complete: true,
		Results:  []ports.TerminalReviewItem{{RunID: "run-1", PRURL: "https://github.com/o/r/pull/2", TargetSHA: "sha-1", Verdict: domain.VerdictApproved}},
	})
	if len(completions) != 1 || completions[0].Err == nil || !strings.Contains(completions[0].Err.Error(), "PR does not match") {
		t.Fatalf("completions = %+v, want PR identity failure", completions)
	}
}

func TestLauncherCleansOnlyOldConsumedTerminalPairs(t *testing.T) {
	dataDir := t.TempDir()
	task, path := writeRecoveryRequest(t, dataDir)
	resultPath := greptile.TerminalResultPath(path)
	old := time.Now().Add(-terminalReviewRetention - time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatalf("age request: %v", err)
	}
	if err := os.Chtimes(resultPath, old, old); err != nil {
		t.Fatalf("age result: %v", err)
	}
	l := NewLauncher(fakeReviewerResolver{reviewer: greptile.New(), ok: true}, &fakeTerminalRuntime{}, dataDir, WithTerminalReviewConsumed(func(_ context.Context, _ domain.SessionID, runIDs []string) bool {
		return len(runIDs) == 1 && runIDs[0] == task.RunID
	})).(*agentLauncher)
	if err := l.maybeCleanupTerminalReview(resultPath, "mer-1", []ports.ReviewTask{task}); err != nil {
		t.Fatalf("maybeCleanupTerminalReview: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("request still exists, stat err = %v", err)
	}
	if _, err := os.Stat(resultPath); !os.IsNotExist(err) {
		t.Fatalf("result still exists, stat err = %v", err)
	}
}

func TestLauncherRetainsOldUnconsumedTerminalPair(t *testing.T) {
	dataDir := t.TempDir()
	task, path := writeRecoveryRequest(t, dataDir)
	resultPath := greptile.TerminalResultPath(path)
	old := time.Now().Add(-terminalReviewRetention - time.Hour)
	_ = os.Chtimes(path, old, old)
	_ = os.Chtimes(resultPath, old, old)
	l := NewLauncher(fakeReviewerResolver{reviewer: greptile.New(), ok: true}, &fakeTerminalRuntime{}, dataDir, WithTerminalReviewConsumed(func(context.Context, domain.SessionID, []string) bool { return false })).(*agentLauncher)
	if err := l.maybeCleanupTerminalReview(resultPath, "mer-1", []ports.ReviewTask{task}); err != nil {
		t.Fatalf("maybeCleanupTerminalReview: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("unconsumed request was removed: %v", err)
	}
	if _, err := os.Stat(resultPath); err != nil {
		t.Fatalf("unconsumed result was removed: %v", err)
	}
}

func TestLauncherPreflightSkipsEnvPrefix(t *testing.T) {
	reviewer := &fakeReviewerForPreflight{Argv: []string{"env", "OPENCODE_CONFIG_CONTENT=cfg", "go"}}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, &fakeRuntime{}, "")
	if err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1"); err != nil {
		t.Fatalf("Preflight: %v", err)
	}
}

func TestLauncherPreflightEnvPrefixWithMissingBinary(t *testing.T) {
	reviewer := &fakeReviewerForPreflight{Argv: []string{"env", "KEY=val", "nonexistent-binary-999"}}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, &fakeRuntime{}, "")
	err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1")
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err = %v, want 'not found'", err)
	}
	if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
		t.Fatalf("err = %v, want ErrAgentBinaryNotFound", err)
	}
}
