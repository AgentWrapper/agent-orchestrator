package review

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeReviewer struct {
	gotInv           ports.ReviewInvocation
	workingDirectory string
}

func (f fakeReviewer) ReviewPromptReadinessHints(context.Context) (ports.PromptReadinessHints, error) {
	return ports.PromptReadinessHints{}, nil
}

func (f *fakeReviewer) ReviewCommand(_ context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	f.gotInv = inv
	return ports.ReviewCommandSpec{Argv: []string{"greptile", "review"}, WorkingDirectory: f.workingDirectory}, nil
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
	Preflight  func(context.Context, string) error
}

type fakeReviewerWithLaunchSpec struct {
	spec  ports.ReviewCommandSpec
	hints ports.PromptReadinessHints
}

func (f *fakeReviewerWithLaunchSpec) ReviewCommand(context.Context, ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	return f.spec, nil
}
func (f *fakeReviewerWithLaunchSpec) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}
func (f *fakeReviewerWithLaunchSpec) ReviewPromptReadinessHints(context.Context) (ports.PromptReadinessHints, error) {
	return f.hints, nil
}

type fakeRestoringReviewer struct {
	fakeReviewer
	restoreSpec ports.ReviewCommandSpec
	restoreOK   bool
	restored    bool
}

func (f *fakeRestoringReviewer) ReviewRestoreCommand(_ context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, bool, error) {
	f.restored = true
	f.gotInv = inv
	return f.restoreSpec, f.restoreOK, nil
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

func (f *fakeReviewerForPreflight) ReviewPreflight(ctx context.Context, workspacePath string) error {
	if f.Preflight == nil {
		return nil
	}
	return f.Preflight(ctx, workspacePath)
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
	interrupt     string
	interrupts    int
	escaped       string
	escapes       int
	input         string
	destroyed     string
	destroyBefore bool
	created       bool
	output        string
	outputReads   int
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
	return f.alive, nil
}
func (f *fakeRuntime) GetOutput(_ context.Context, _ ports.RuntimeHandle, _ int) (string, error) {
	f.outputReads++
	return f.output, nil
}
func (f *fakeRuntime) Interrupt(_ context.Context, handle ports.RuntimeHandle) error {
	f.interrupt = handle.ID
	f.interrupts++
	return nil
}
func (f *fakeRuntime) Escape(_ context.Context, handle ports.RuntimeHandle) error {
	f.escaped = handle.ID
	f.escapes++
	return nil
}
func (f *fakeRuntime) SendInput(_ context.Context, handle ports.RuntimeHandle, input string) error {
	f.sentTo = handle.ID
	f.input = input
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
	if reviewer.gotInv.RunID != "run-1" || reviewer.gotInv.TargetSHA != "sha1" || reviewer.gotInv.ReviewerID != "review-mer-1" || reviewer.gotInv.DataDir != dataDir {
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

func TestLauncherUsesReviewerNeutralWorkingDirectory(t *testing.T) {
	reviewer := &fakeReviewer{workingDirectory: "/ao/reviewer-runtime/review-mer-1/workspace"}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)

	if _, err := l.Spawn(context.Background(), launchSpec()); err != nil {
		t.Fatal(err)
	}
	if rt.createCfg.WorkspacePath != reviewer.workingDirectory {
		t.Fatalf("runtime working directory = %q, want %q", rt.createCfg.WorkspacePath, reviewer.workingDirectory)
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

func TestLauncherRestoreUsesReviewerRestoreCommand(t *testing.T) {
	reviewer := &fakeRestoringReviewer{
		restoreOK: true,
		restoreSpec: ports.ReviewCommandSpec{
			Argv:           []string{"agent", "resume", "review-mer-1"},
			InitialMessage: "restored task",
		},
	}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)

	if _, err := l.Restore(context.Background(), launchSpec()); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if !reviewer.restored {
		t.Fatal("expected restore command to be requested")
	}
	if got := rt.createCfg.Argv; len(got) != 3 || got[0] != "agent" || got[1] != "resume" || got[2] != "review-mer-1" {
		t.Fatalf("restore argv = %#v", got)
	}
	if rt.sentMsg != "restored task" {
		t.Fatalf("initial message = %q, want restored task", rt.sentMsg)
	}
}

func TestLauncherRestoreFallsBackToFreshCommand(t *testing.T) {
	reviewer := &fakeRestoringReviewer{}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)

	if _, err := l.Restore(context.Background(), launchSpec()); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if !reviewer.restored {
		t.Fatal("expected restore command to be requested")
	}
	if got := rt.createCfg.Argv; len(got) != 2 || got[0] != "greptile" || got[1] != "review" {
		t.Fatalf("fallback argv = %#v", got)
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
	if reviewer.gotPre.ReviewerID != "review-mer-1" || reviewer.gotPre.WorkspacePath != "/ws/mer-1" || reviewer.gotPre.DataDir == "" {
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

func TestLauncherNotifyHonorsCancelledContextBeforePromptWrites(t *testing.T) {
	dataDir := t.TempDir()
	l := NewLauncher(fakeReviewerResolver{reviewer: &fakeReviewer{}, ok: true}, &fakeRuntime{}, dataDir)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := l.Notify(ctx, "review-mer-1", launchSpec())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Notify error = %v, want context cancellation", err)
	}
	if _, statErr := os.Stat(filepath.Join(dataDir, "prompts")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("prompt directory created after cancellation: %v", statErr)
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

func TestLauncherCancelSendsEscapeForPi(t *testing.T) {
	reviewer := &fakeCancellableReviewer{mode: ports.ReviewCancelEscape, interrupts: 1}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)

	if err := l.Cancel(context.Background(), "review-mer-1", domain.ReviewerPi); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if rt.sentTo != "review-mer-1" || rt.input != "\x1b" {
		t.Fatalf("native input = %q to %q, want Escape to review-mer-1", rt.input, rt.sentTo)
	}
	if rt.interrupts != 0 {
		t.Fatalf("Pi cancel sent %d Ctrl-C interrupts", rt.interrupts)
	}
}

func TestLauncherCancelSendsEscapeForKiro(t *testing.T) {
	reviewer := &fakeCancellableReviewer{mode: ports.ReviewCancelEscape}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)
	if err := l.Cancel(context.Background(), "review-mer-1", domain.ReviewerKiro); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if rt.sentTo != "review-mer-1" || rt.input != "\x1b" || rt.interrupts != 0 {
		t.Fatalf("native input = %q to %q, interrupts=%d", rt.input, rt.sentTo, rt.interrupts)
	}
}

func TestLauncherSpawnUsesReviewerWorkingDirectoryAndInitialMessage(t *testing.T) {
	reviewer := &fakeReviewerWithLaunchSpec{spec: ports.ReviewCommandSpec{
		Argv: []string{"kiro-cli", "chat"}, WorkingDirectory: "/ao/reviewer", InitialMessage: "task ref",
	}}
	rt := &fakeRuntime{}
	l := newTestLauncher(t, reviewer, rt)
	if _, err := l.Spawn(context.Background(), launchSpec()); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if rt.createCfg.WorkspacePath != "/ao/reviewer" || rt.sentMsg != "task ref" {
		t.Fatalf("create = %+v, sent = %q", rt.createCfg, rt.sentMsg)
	}
}

func TestLauncherWaitsForReviewerPromptMarkerBeforeInitialMessage(t *testing.T) {
	reviewer := &fakeReviewerWithLaunchSpec{
		spec: ports.ReviewCommandSpec{Argv: []string{"agent"}, InitialMessage: "task ref"},
		hints: ports.PromptReadinessHints{
			Patterns: []string{"READY>"}, PollInterval: time.Millisecond, Timeout: time.Second, Lines: 20,
		},
	}
	rt := &fakeRuntime{output: "banner\nREADY>"}
	l := newTestLauncher(t, reviewer, rt)
	if _, err := l.Spawn(context.Background(), launchSpec()); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if rt.outputReads == 0 || rt.sentMsg != "task ref" {
		t.Fatalf("output reads = %d, sent = %q", rt.outputReads, rt.sentMsg)
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
	called := false
	reviewer := &fakeReviewerForPreflight{
		Argv: []string{"go"},
		Preflight: func(_ context.Context, workspacePath string) error {
			called = true
			if workspacePath != "/ws/mer-1" {
				t.Fatalf("workspace = %q", workspacePath)
			}
			return nil
		},
	}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, &fakeRuntime{}, "")
	if err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1"); err != nil {
		t.Fatalf("Preflight: %v", err)
	}
	if !called {
		t.Fatal("adapter compatibility preflight was not called")
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
	if err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err = %v, want 'not found'", err)
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
	if err := l.Preflight(context.Background(), domain.ReviewerClaudeCode, "/ws/mer-1"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err = %v, want 'not found'", err)
	}
}
