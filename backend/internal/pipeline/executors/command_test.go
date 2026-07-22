package executors

import (
	"context"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// fakeProcess is a CommandProcess whose result is pre-set; Done is already
// closed so Poll sees it as finished immediately.
type fakeProcess struct {
	res    CommandResult
	killed bool
	done   chan struct{}
}

func newFakeProcess(res CommandResult) *fakeProcess {
	ch := make(chan struct{})
	close(ch)
	return &fakeProcess{res: res, done: ch}
}

func (p *fakeProcess) Done() <-chan struct{} { return p.done }
func (p *fakeProcess) Result() CommandResult { return p.res }
func (p *fakeProcess) Kill()                 { p.killed = true }

// fakeRunner records the spec it was asked to start and returns a scripted
// process. startErr forces Start to fail. started reports whether a subprocess
// was ever requested, so fork-gate tests can assert no spawn happened.
type fakeRunner struct {
	res      CommandResult
	startErr error
	started  bool
	lastSpec CommandSpec
	proc     *fakeProcess
}

func (r *fakeRunner) Start(_ context.Context, spec CommandSpec) (CommandProcess, error) {
	r.started = true
	r.lastSpec = spec
	if r.startErr != nil {
		return nil, r.startErr
	}
	r.proc = newFakeProcess(r.res)
	return r.proc, nil
}

// fakeCommandSessions returns a scripted linked session.
type fakeCommandSessions struct {
	session CommandSession
	exists  bool
	err     error
}

func (s *fakeCommandSessions) Get(_ context.Context, _ string) (CommandSession, bool, error) {
	return s.session, s.exists, s.err
}

func commandStage() pipeline.Stage {
	return pipeline.Stage{
		Name:     "typecheck",
		Executor: pipeline.StageExecutor{Kind: pipeline.ExecutorCommand, Command: "tsc-shim"},
	}
}

func runCommand(t *testing.T, runner CommandRunner, sessions CommandSessions, in StartInput) Outcome {
	t.Helper()
	exec := NewCommandExecutor(runner, sessions)
	h, err := exec.Start(context.Background(), in)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	out, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	return out
}

func baseCommandInput() StartInput {
	return StartInput{
		PipelineName:    "ci",
		RunID:           "run-1",
		StageRunID:      "sr-1",
		Stage:           commandStage(),
		LinkedSessionID: "sess-1",
	}
}

func TestCommand_ForkGateSkipsWithoutSpawn(t *testing.T) {
	for _, fork := range []ForkStatus{ForkYes, ForkUnknown} {
		runner := &fakeRunner{}
		sessions := &fakeCommandSessions{
			exists:  true,
			session: CommandSession{WorkspacePath: "/ws", Fork: fork, PRNumber: 7},
		}
		out := runCommand(t, runner, sessions, baseCommandInput())

		if runner.started {
			t.Fatalf("fork=%v: a subprocess must NEVER be spawned when the fork gate blocks", fork)
		}
		if out.Status != OutcomeCompleted || out.Verdict != pipeline.VerdictNeutral {
			t.Fatalf("fork=%v: want completed/neutral skip, got %s/%s", fork, out.Status, out.Verdict)
		}
		if len(out.Observations) != 1 || out.Observations[0].Name != forkSkipObservation {
			t.Fatalf("fork=%v: expected a fork-skip observation, got %+v", fork, out.Observations)
		}
	}
}

func TestCommand_ForkAllowedRuns(t *testing.T) {
	runner := &fakeRunner{res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded"}`}}
	sessions := &fakeCommandSessions{
		exists:  true,
		session: CommandSession{WorkspacePath: "/ws", Fork: ForkYes, PRNumber: 7},
	}
	in := baseCommandInput()
	in.AllowForkPRs = true
	out := runCommand(t, runner, sessions, in)

	if !runner.started {
		t.Fatal("allowForkPRs=true must let the fork PR run")
	}
	if out.Status != OutcomeCompleted || out.Verdict != pipeline.VerdictPass {
		t.Fatalf("want completed/pass, got %s/%s", out.Status, out.Verdict)
	}
}

func TestCommand_NonForkRuns(t *testing.T) {
	runner := &fakeRunner{res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded","verdict":"pass"}`}}
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	out := runCommand(t, runner, sessions, baseCommandInput())
	if !runner.started || out.Status != OutcomeCompleted {
		t.Fatalf("non-fork PR should run: started=%v status=%s", runner.started, out.Status)
	}
}

func TestCommand_EnvIncludesPipelineAndPRBlock(t *testing.T) {
	runner := &fakeRunner{res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded"}`}}
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	in := baseCommandInput()
	in.Context = pipeline.RunContext{
		PRNumber: 12, PRURL: "https://x/pull/12", SourceBranch: "feat",
		TargetBranch: "main", HeadSHA: "deadbeef",
	}
	// Stage env must win on collision, and its own keys survive the merge.
	in.Stage.Executor.Env = map[string]string{"AO_PR_NUMBER": "override", "CUSTOM": "1"}

	runCommand(t, runner, sessions, in)

	env := runner.lastSpec.Env
	want := map[string]string{
		"AO_PIPELINE_RUN_ID": "run-1",
		"AO_PIPELINE_STAGE":  "typecheck",
		"AO_PR_URL":          "https://x/pull/12",
		"AO_PR_BRANCH":       "feat",
		"AO_PR_BASE_BRANCH":  "main",
		"AO_PR_HEAD_SHA":     "deadbeef",
		"AO_PR_NUMBER":       "override", // stage env wins
		"CUSTOM":             "1",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%q] = %q, want %q", k, env[k], v)
		}
	}
}

func TestCommand_EnvOmitsUnsetPRValues(t *testing.T) {
	runner := &fakeRunner{res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded"}`}}
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	// A manual run: no PR context, so no AO_PR_* keys, but the pipeline keys stay.
	runCommand(t, runner, sessions, baseCommandInput())

	env := runner.lastSpec.Env
	if env["AO_PIPELINE_RUN_ID"] != "run-1" || env["AO_PIPELINE_STAGE"] != "typecheck" {
		t.Fatalf("pipeline env keys must always be present, got %+v", env)
	}
	for _, k := range []string{"AO_PR_NUMBER", "AO_PR_URL", "AO_PR_BRANCH", "AO_PR_BASE_BRANCH", "AO_PR_HEAD_SHA"} {
		if _, ok := env[k]; ok {
			t.Errorf("unset PR value must be omitted, but %q is present", k)
		}
	}
}

func TestCommand_ExitCodeSemantics(t *testing.T) {
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	cases := []struct {
		name     string
		res      CommandResult
		want     OutcomeStatus
		verdict  pipeline.Verdict
		errMatch string
	}{
		{"nonzero exit fails", CommandResult{ExitCode: 1, Stderr: "tsc blew up"}, OutcomeFailed, "", "exited with code 1"},
		{"signal fails", CommandResult{Signal: "killed"}, OutcomeFailed, "", "signal killed"},
		// Exit-code fallback: bare commands with no JSON envelope succeed on exit 0.
		{"empty stdout + exit 0 -> pass", CommandResult{ExitCode: 0, Stdout: "  "}, OutcomeCompleted, pipeline.VerdictPass, ""},
		{"non-envelope stdout + exit 0 -> pass", CommandResult{ExitCode: 0, Stdout: "All checks passed."}, OutcomeCompleted, pipeline.VerdictPass, ""},
		{"broken json + exit 0 -> pass", CommandResult{ExitCode: 0, Stdout: "{not json"}, OutcomeCompleted, pipeline.VerdictPass, ""},
		{"non-envelope object + exit 0 -> pass", CommandResult{ExitCode: 0, Stdout: "{}"}, OutcomeCompleted, pipeline.VerdictPass, ""},
		{"non-envelope + exit 2 -> fail", CommandResult{ExitCode: 2, Stdout: "3 problems", Stderr: "lint failed"}, OutcomeFailed, "", "exited with code 2"},
		{"bad outcome enum fails", CommandResult{ExitCode: 0, Stdout: `{"outcome":"weird"}`}, OutcomeFailed, "", "failed validation"},
		{"outcome=failed fails with reason", CommandResult{ExitCode: 0, Stdout: `{"outcome":"failed","reason":"3 type errors"}`}, OutcomeFailed, "", "3 type errors"},
		{"succeeded -> pass", CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded"}`}, OutcomeCompleted, pipeline.VerdictPass, ""},
		{"neutral -> neutral", CommandResult{ExitCode: 0, Stdout: `{"outcome":"neutral"}`}, OutcomeCompleted, pipeline.VerdictNeutral, ""},
		{"explicit verdict wins", CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded","verdict":"fail"}`}, OutcomeCompleted, pipeline.VerdictFail, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runner := &fakeRunner{res: tc.res}
			out := runCommand(t, runner, sessions, baseCommandInput())
			if out.Status != tc.want {
				t.Fatalf("want %s, got %s (%s)", tc.want, out.Status, out.ErrorMessage)
			}
			if tc.verdict != "" && out.Verdict != tc.verdict {
				t.Errorf("want verdict %s, got %s", tc.verdict, out.Verdict)
			}
			if tc.errMatch != "" && !strings.Contains(out.ErrorMessage, tc.errMatch) {
				t.Errorf("want error containing %q, got %q", tc.errMatch, out.ErrorMessage)
			}
		})
	}
}

func TestCommand_SelfSkipObservation(t *testing.T) {
	runner := &fakeRunner{res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"skipped","reason":"nothing to do"}`}}
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	out := runCommand(t, runner, sessions, baseCommandInput())
	if out.Status != OutcomeCompleted || out.Verdict != pipeline.VerdictNeutral {
		t.Fatalf("skipped should be completed/neutral, got %s/%s", out.Status, out.Verdict)
	}
	if len(out.Observations) != 1 || out.Observations[0].Name != "command_stage_self_skipped" {
		t.Fatalf("expected a self-skip observation, got %+v", out.Observations)
	}
}

func TestCommand_ArtifactsPassThrough(t *testing.T) {
	runner := &fakeRunner{res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded","artifacts":[{"kind":"finding","filePath":"a.go","startLine":1,"endLine":1,"title":"t","description":"d","category":"c","severity":"warning","confidence":0.8}]}`}}
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	out := runCommand(t, runner, sessions, baseCommandInput())
	if len(out.Artifacts) != 1 || out.Artifacts[0].FilePath != "a.go" {
		t.Fatalf("artifacts should pass through, got %+v", out.Artifacts)
	}
}

func TestCommand_UnknownSessionFails(t *testing.T) {
	runner := &fakeRunner{}
	sessions := &fakeCommandSessions{exists: false}
	out := runCommand(t, runner, sessions, baseCommandInput())
	if out.Status != OutcomeFailed || runner.started {
		t.Fatalf("unknown session should fail without spawn, got %s started=%v", out.Status, runner.started)
	}
}

func TestCommand_NoWorkspaceFails(t *testing.T) {
	runner := &fakeRunner{}
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "", Fork: ForkNo}}
	out := runCommand(t, runner, sessions, baseCommandInput())
	if out.Status != OutcomeFailed || runner.started {
		t.Fatalf("no workspace should fail without spawn, got %s started=%v", out.Status, runner.started)
	}
	if !strings.Contains(out.ErrorMessage, "workspace") {
		t.Errorf("unexpected message: %s", out.ErrorMessage)
	}
}

func TestCommand_SpawnErrorFails(t *testing.T) {
	runner := &fakeRunner{startErr: context.DeadlineExceeded}
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	out := runCommand(t, runner, sessions, baseCommandInput())
	if out.Status != OutcomeFailed {
		t.Fatalf("spawn error should fail, got %s", out.Status)
	}
}

func TestCommand_CwdResolution(t *testing.T) {
	runner := &fakeRunner{res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded"}`}}
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	in := baseCommandInput()
	in.Stage.Executor.Cwd = "sub/dir"
	runCommand(t, runner, sessions, in)
	if runner.lastSpec.Dir != "/ws/sub/dir" {
		t.Errorf("want cwd /ws/sub/dir, got %q", runner.lastSpec.Dir)
	}
}

func TestCommand_CwdEscapeRejected(t *testing.T) {
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	for _, bad := range []string{"../escape", "/abs", "a/../../b", "C:\\win"} {
		runner := &fakeRunner{}
		in := baseCommandInput()
		in.Stage.Executor.Cwd = bad
		out := runCommand(t, runner, sessions, in)
		if out.Status != OutcomeFailed || runner.started {
			t.Errorf("cwd %q should be rejected without spawn, got %s started=%v", bad, out.Status, runner.started)
		}
	}
}

func TestCommand_RunningThenDone(t *testing.T) {
	// A process whose Done channel is still open reports running until closed.
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	proc := &fakeProcess{res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded"}`}, done: make(chan struct{})}
	runner := &openProcRunner{proc: proc}
	exec := NewCommandExecutor(runner, sessions)
	h, err := exec.Start(context.Background(), baseCommandInput())
	if err != nil {
		t.Fatal(err)
	}
	out, _ := exec.Poll(context.Background(), h)
	if out.Status != OutcomeRunning {
		t.Fatalf("want running while process is live, got %s", out.Status)
	}
	close(proc.done)
	out, _ = exec.Poll(context.Background(), h)
	if out.Status != OutcomeCompleted {
		t.Fatalf("want completed after exit, got %s", out.Status)
	}
}

func TestCommand_CancelKills(t *testing.T) {
	sessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	proc := &fakeProcess{res: CommandResult{}, done: make(chan struct{})}
	runner := &openProcRunner{proc: proc}
	exec := NewCommandExecutor(runner, sessions)
	h, _ := exec.Start(context.Background(), baseCommandInput())
	if err := exec.Cancel(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	if !proc.killed {
		t.Error("cancel should kill the running process")
	}
}

// openProcRunner returns a process whose Done channel the test controls.
type openProcRunner struct{ proc *fakeProcess }

func (r *openProcRunner) Start(_ context.Context, _ CommandSpec) (CommandProcess, error) {
	return r.proc, nil
}
