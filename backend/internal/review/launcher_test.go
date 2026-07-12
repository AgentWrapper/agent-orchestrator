package review

import (
	"context"
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
	return "review run " + inv.RunID, nil
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
	createCfg  ports.RuntimeConfig
	sentMsg    string
	sentTo     string
	alive      bool
	interrupt  string
	interrupts int
}

func (f *fakeRuntime) Create(_ context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	f.createCfg = cfg
	return ports.RuntimeHandle{ID: string(cfg.SessionID)}, nil
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
	return nil
}

func launchSpec() LaunchSpec {
	return LaunchSpec{
		RunID: "run-1", WorkerID: "mer-1", Harness: domain.ReviewerClaudeCode,
		WorkspacePath: "/ws/mer-1", PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha1",
	}
}

func TestLauncherSpawnReturnsStableHandle(t *testing.T) {
	reviewer := &fakeReviewer{}
	rt := &fakeRuntime{}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, rt)

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
}

func TestLauncherSpawnRunsReviewerPreLaunch(t *testing.T) {
	reviewer := &fakePreLaunchReviewer{}
	rt := &fakeRuntime{}
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, rt)

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
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, rt)

	if err := l.Notify(context.Background(), "review-mer-1", launchSpec()); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if rt.sentTo != "review-mer-1" || !strings.Contains(rt.sentMsg, "run-1") {
		t.Fatalf("sent to %q msg %q", rt.sentTo, rt.sentMsg)
	}
}

func TestLauncherAlive(t *testing.T) {
	l := NewLauncher(fakeReviewerResolver{ok: true}, &fakeRuntime{alive: true})
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
	l := NewLauncher(fakeReviewerResolver{reviewer: reviewer, ok: true}, rt)

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
	l := NewLauncher(fakeReviewerResolver{reviewer: &fakeReviewer{}, ok: true}, &fakeRuntime{})

	if err := l.Cancel(context.Background(), "review-mer-1", domain.ReviewerClaudeCode); err == nil || !strings.Contains(err.Error(), "does not support cancellation") {
		t.Fatalf("err = %v, want unsupported cancellation", err)
	}
}

func TestLauncherSpawnNoAdapter(t *testing.T) {
	l := NewLauncher(fakeReviewerResolver{ok: false}, &fakeRuntime{})
	if _, err := l.Spawn(context.Background(), launchSpec()); err == nil || !strings.Contains(err.Error(), "no reviewer adapter") {
		t.Fatalf("err = %v, want no-adapter", err)
	}
}
