package executors

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// fakeProcess is a subprocess that never runs: the test decides when it exits,
// what it wrote, and observes whether it was killed.
type fakeProcess struct {
	done chan struct{}
	pgid int

	mu     sync.Mutex
	result CommandResult
	kills  int
}

func newFakeProcess() *fakeProcess { return &fakeProcess{done: make(chan struct{}), pgid: 4242} }

func (p *fakeProcess) Done() <-chan struct{} { return p.done }

func (p *fakeProcess) PGID() int { return p.pgid }

func (p *fakeProcess) Result() CommandResult {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.result
}

func (p *fakeProcess) Kill() {
	p.mu.Lock()
	p.kills++
	p.mu.Unlock()
}

func (p *fakeProcess) killCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.kills
}

// exit settles the process with the given result and closes Done.
func (p *fakeProcess) exit(res CommandResult) {
	p.mu.Lock()
	p.result = res
	p.mu.Unlock()
	close(p.done)
}

// fakeRunner records the spec it was started with and hands the test the log
// sink the executor bound to it, so the test can push output through the same
// path a real subprocess would.
type fakeRunner struct {
	sink  LogSink
	spec  CommandSpec
	child *fakeProcess
	err   error
}

func (r *fakeRunner) Start(_ context.Context, spec CommandSpec) (CommandProcess, error) {
	r.spec = spec
	if r.err != nil {
		return nil, r.err
	}
	return r.child, nil
}

// newFakeExecutor wires a CommandExecutor onto a single fake runner.
func newFakeExecutor(t *testing.T) (*CommandExecutor, *fakeRunner) {
	t.Helper()
	runner := &fakeRunner{child: newFakeProcess()}
	exec := NewCommandExecutor(func(sink LogSink) CommandRunner {
		runner.sink = sink
		return runner
	})
	return exec, runner
}

// startInput builds a minimal command-stage start input rooted in a temp dir.
func startInput(t *testing.T) StartInput {
	t.Helper()
	dir := t.TempDir()
	folder, err := pipeline.CreateRunFolder(dir, "proj-1", "run-1", []byte("stages: []\n"))
	if err != nil {
		t.Fatalf("CreateRunFolder: %v", err)
	}
	return StartInput{
		ProjectID:     "proj-1",
		RunID:         "run-1",
		RunDir:        folder.Dir,
		Stage:         pipeline.Stage{ID: "publish", Executor: pipeline.ExecutorCommand, Run: "echo hi"},
		Attempt:       1,
		Subject:       pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "proj-1"},
		WorkspacePath: filepath.Join(dir, "tree"),
		Env:           map[string]string{"AO_RUN_ID": "run-1", "AO_STAGE": "publish", "GH_TOKEN": "ambient"},
		LogPath:       folder.LogPath("publish"),
	}
}

func TestCommandStartSpec(t *testing.T) {
	exec, runner := newFakeExecutor(t)
	in := startInput(t)

	if _, err := exec.Start(context.Background(), in); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if runner.spec.Dir != in.WorkspacePath {
		t.Errorf("cwd = %q, want the stage workspace %q", runner.spec.Dir, in.WorkspacePath)
	}
	if got := runner.spec.Env["AO_RUN_ID"]; got != "run-1" {
		t.Errorf("AO_RUN_ID = %q, want run-1", got)
	}
	if got := runner.spec.Env["AO_STAGE"]; got != "publish" {
		t.Errorf("AO_STAGE = %q, want publish", got)
	}
	// The whole `run:` block is handed to a shell so env interpolation works
	// without an expression language (spec section 12.3).
	if want := "echo hi"; runner.spec.Args[len(runner.spec.Args)-1] != want {
		t.Errorf("args = %v, want the run block %q last", runner.spec.Args, want)
	}
}

func TestCommandCredentialsOnlyWhenProvidedAndWin(t *testing.T) {
	exec, runner := newFakeExecutor(t)
	in := startInput(t)

	if _, err := exec.Start(context.Background(), in); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got, ok := runner.spec.Env["APPLE_KEY"]; ok {
		t.Errorf("APPLE_KEY = %q, want absent when no credentials are provided", got)
	}
	if got := runner.spec.Env["GH_TOKEN"]; got != "ambient" {
		t.Errorf("GH_TOKEN = %q, want the ambient value untouched", got)
	}

	exec, runner = newFakeExecutor(t)
	in = startInput(t)
	in.Credentials = map[string]string{"APPLE_KEY": "secret", "GH_TOKEN": "credential"}
	if _, err := exec.Start(context.Background(), in); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := runner.spec.Env["APPLE_KEY"]; got != "secret" {
		t.Errorf("APPLE_KEY = %q, want secret", got)
	}
	if got := runner.spec.Env["GH_TOKEN"]; got != "credential" {
		t.Errorf("GH_TOKEN = %q, want the credential to win the collision", got)
	}
}

func TestCommandTeesBothStreamsToLogFile(t *testing.T) {
	exec, runner := newFakeExecutor(t)
	in := startInput(t)

	h, err := exec.Start(context.Background(), in)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	runner.sink.Write("stdout", []byte("out line\n"))
	runner.sink.Write("stderr", []byte("err line\n"))
	runner.child.exit(CommandResult{ExitCode: 0})
	if _, err := exec.Poll(context.Background(), h); err != nil {
		t.Fatalf("Poll: %v", err)
	}

	raw, err := os.ReadFile(in.LogPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	for _, want := range []string{"out line", "err line"} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("log %q missing %q", raw, want)
		}
	}

	tailer, ok := h.(OutputTailer)
	if !ok {
		t.Fatalf("handle %T does not expose an output tail", h)
	}
	text, truncated := tailer.OutputTail()
	if !strings.Contains(text, "out line") || !strings.Contains(text, "err line") {
		t.Errorf("tail = %q, want both streams", text)
	}
	if truncated {
		t.Error("tail reported truncated for a two-line stage")
	}
}

func TestCommandOutputTailIsCapped(t *testing.T) {
	exec, runner := newFakeExecutor(t)
	in := startInput(t)

	h, err := exec.Start(context.Background(), in)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	chunk := strings.Repeat("x", 8<<10)
	total := 0
	for i := 0; i < 12; i++ { // 96 KiB, past the 64 KiB tail cap
		runner.sink.Write("stdout", []byte(chunk))
		total += len(chunk)
	}
	runner.child.exit(CommandResult{ExitCode: 0})
	if _, err := exec.Poll(context.Background(), h); err != nil {
		t.Fatalf("Poll: %v", err)
	}

	text, truncated := h.(OutputTailer).OutputTail()
	if len(text) != stageTailCapBytes {
		t.Errorf("tail is %d bytes, want the %d byte cap", len(text), stageTailCapBytes)
	}
	if !truncated {
		t.Error("tail did not report truncation past the cap")
	}
	info, err := os.Stat(in.LogPath)
	if err != nil {
		t.Fatalf("stat log: %v", err)
	}
	if info.Size() != int64(total) {
		t.Errorf("log file is %d bytes, want the full %d byte stream", info.Size(), total)
	}
}

func TestCommandPollRunningThenExit(t *testing.T) {
	exec, runner := newFakeExecutor(t)
	in := startInput(t)

	h, err := exec.Start(context.Background(), in)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	got, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got.State != PollRunning {
		t.Fatalf("state = %q, want running", got.State)
	}

	runner.child.exit(CommandResult{ExitCode: 3})
	got, err = exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	// Exit status is the outcome: the executor reports the code, the driver maps
	// it (spec section 6.1). No stdout envelope is parsed.
	if got.State != PollExited || got.ExitCode != 3 {
		t.Errorf("poll = %+v, want exited with code 3", got)
	}
}

func TestCommandPollReportsSpawnFailureAsNonZero(t *testing.T) {
	exec, runner := newFakeExecutor(t)
	in := startInput(t)

	h, err := exec.Start(context.Background(), in)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	runner.child.exit(CommandResult{ExitCode: 0, Err: os.ErrPermission})
	got, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got.State != PollExited {
		t.Fatalf("state = %q, want exited", got.State)
	}
	if got.ExitCode == 0 {
		t.Error("a wait failure reported exit code 0, which the driver would read as success")
	}
	if got.Reason == "" {
		t.Error("a wait failure carried no reason")
	}
}

func TestCommandCancelAndInterruptKillTheProcessGroup(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*CommandExecutor, Handle) error
	}{
		// Interrupt is Cancel for a command stage: there is no session to keep
		// alive, so a deadline kill and a run cancellation do the same thing.
		{"cancel", func(e *CommandExecutor, h Handle) error { return e.Cancel(context.Background(), h) }},
		{"interrupt", func(e *CommandExecutor, h Handle) error { return e.Interrupt(context.Background(), h) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exec, runner := newFakeExecutor(t)
			h, err := exec.Start(context.Background(), startInput(t))
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			if err := tc.call(exec, h); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			if got := runner.child.killCount(); got != 1 {
				t.Fatalf("kills = %d, want 1", got)
			}
			// Idempotent: the reducer can cancel a stage that already settled.
			runner.child.exit(CommandResult{Signal: "killed"})
			if _, err := exec.Poll(context.Background(), h); err != nil {
				t.Fatalf("Poll after %s: %v", tc.name, err)
			}
			if err := tc.call(exec, h); err != nil {
				t.Fatalf("second %s: %v", tc.name, err)
			}
		})
	}
}

func TestCommandRejectsAgentStage(t *testing.T) {
	exec, _ := newFakeExecutor(t)
	in := startInput(t)
	in.Stage.Executor = pipeline.ExecutorAgent
	if _, err := exec.Start(context.Background(), in); err == nil {
		t.Fatal("Start accepted an agent stage")
	}
}

func TestCommandRequiresWorkspaceAndLogPath(t *testing.T) {
	exec, _ := newFakeExecutor(t)
	in := startInput(t)
	in.WorkspacePath = ""
	if _, err := exec.Start(context.Background(), in); err == nil {
		t.Error("Start accepted an empty workspace path")
	}

	exec, _ = newFakeExecutor(t)
	in = startInput(t)
	in.LogPath = ""
	if _, err := exec.Start(context.Background(), in); err == nil {
		t.Error("Start accepted an empty log path")
	}
}

// TestCommandThroughRealRunner covers what a fake runner cannot: the process
// environment survives the merge, the real log file gets both streams, and a
// non-zero exit arrives faithfully.
func TestCommandThroughRealRunner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the run block is executed through sh")
	}
	t.Setenv("AO_TEST_PROCESS_ENV", "inherited")

	in := startInput(t)
	if err := os.MkdirAll(in.WorkspacePath, 0o750); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	in.Stage.Run = "printf '%s %s %s\\n' \"$AO_TEST_PROCESS_ENV\" \"$AO_RUN_ID\" \"$PWD\"; echo boom >&2; exit 7"

	exec := NewCommandExecutor(NewOSRunner)
	h, err := exec.Start(context.Background(), in)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	var got Poll
	for {
		got, err = exec.Poll(context.Background(), h)
		if err != nil {
			t.Fatalf("Poll: %v", err)
		}
		if got.State != PollRunning {
			break
		}
	}
	if got.State != PollExited || got.ExitCode != 7 {
		t.Fatalf("poll = %+v, want exited with code 7", got)
	}

	raw, err := os.ReadFile(in.LogPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	log := string(raw)
	for _, want := range []string{"inherited", "run-1", in.WorkspacePath, "boom"} {
		if !strings.Contains(log, want) {
			t.Errorf("log %q missing %q", log, want)
		}
	}
}

// stubExecutor records which of its methods the Set routed to it.
type stubExecutor struct {
	handle  Handle
	polls   int
	cancels int
}

func (s *stubExecutor) Start(context.Context, StartInput) (Handle, error) { return s.handle, nil }

func (s *stubExecutor) Poll(context.Context, Handle) (Poll, error) {
	s.polls++
	return Poll{State: PollRunning}, nil
}

func (s *stubExecutor) Cancel(context.Context, Handle) error {
	s.cancels++
	return nil
}

func (s *stubExecutor) Interrupt(ctx context.Context, h Handle) error { return s.Cancel(ctx, h) }

func TestSetRoutesHandleBackToItsOwner(t *testing.T) {
	command := &stubExecutor{handle: &commandHandle{}}
	agent := &stubExecutor{handle: &commandHandle{}}
	set := &Set{Agent: agent, Command: command}

	in := startInput(t)
	h, err := set.Start(context.Background(), in)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := set.Poll(context.Background(), h); err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if err := set.Cancel(context.Background(), h); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if command.polls != 1 || command.cancels != 1 {
		t.Errorf("command executor saw %d polls and %d cancels, want 1 each", command.polls, command.cancels)
	}
	if agent.polls != 0 || agent.cancels != 0 {
		t.Errorf("agent executor was routed a command stage's handle")
	}

	in.Stage.Executor = pipeline.ExecutorAgent
	if _, err := set.Start(context.Background(), in); err != nil {
		t.Fatalf("agent Start: %v", err)
	}

	// A kind with no executor wired is an error, not a nil-handle panic.
	if _, err := (&Set{Command: command}).Start(context.Background(), in); err == nil {
		t.Error("Set started an agent stage with no agent executor")
	}
	// A foreign handle is rejected rather than dereferenced.
	if _, err := set.Poll(context.Background(), &commandHandle{}); err == nil {
		t.Error("Set polled a handle it did not create")
	}
}
