package review

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	destroyed     string
	destroyBefore bool
	created       bool
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
