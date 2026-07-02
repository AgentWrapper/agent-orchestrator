package tmux

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// -- fakeRunner test seam --

type fakeRunner struct {
	calls   []runnerCall
	outputs [][]byte
	err     error
}

type runnerCall struct {
	env  []string
	name string
	args []string
}

func (f *fakeRunner) Run(_ context.Context, env []string, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, runnerCall{env: append([]string(nil), env...), name: name, args: append([]string(nil), args...)})
	var out []byte
	if len(f.outputs) > 0 {
		out = f.outputs[0]
		f.outputs = f.outputs[1:]
	}
	if f.err != nil {
		return out, f.err
	}
	return out, nil
}

// -- helpers --

func newTestRuntime(chunkSize int) (*Runtime, *fakeRunner) {
	fr := &fakeRunner{}
	r := New(Options{Binary: "tmux-test", Timeout: time.Second, Shell: "/bin/sh", ChunkSize: chunkSize})
	r.runner = fr
	r.enterDelay = 0 // tests must not pay the real 300ms pre-Enter pause
	return r, fr
}

// -- Options / New tests --

func TestNewDefaultsToPortableShell(t *testing.T) {
	t.Setenv("SHELL", "")
	r := New(Options{})
	if got := r.shell; got != "/bin/sh" {
		t.Fatalf("default shell = %q, want /bin/sh", got)
	}
}

func TestNewPicksUpShellFromEnv(t *testing.T) {
	t.Setenv("SHELL", "/bin/zsh")
	r := New(Options{})
	if got := r.shell; got != "/bin/zsh" {
		t.Fatalf("shell = %q, want /bin/zsh", got)
	}
}

// -- command builder tests --

func TestCommandBuilders(t *testing.T) {
	if got, want := newSessionArgs("sess-1", "/tmp/ws", "/bin/sh", `echo hi; exec "${SHELL:-/bin/sh}" -i`),
		[]string{"new-session", "-d", "-s", "sess-1", "-x", "220", "-y", "50", "-c", "/tmp/ws", "/bin/sh", "-c", `echo hi; exec "${SHELL:-/bin/sh}" -i`}; !reflect.DeepEqual(got, want) {
		t.Fatalf("newSessionArgs = %#v, want %#v", got, want)
	}
	// set-option uses pane-targeting (no = prefix).
	if got, want := setStatusOffArgs("sess-1"), []string{"set-option", "-t", "sess-1", "status", "off"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("setStatusOffArgs = %#v, want %#v", got, want)
	}
	if got, want := setMouseOnArgs("sess-1"), []string{"set-option", "-t", "sess-1", "mouse", "on"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("setMouseOnArgs = %#v, want %#v", got, want)
	}
	// kill-session and has-session use exact-match prefix =.
	if got, want := killSessionArgs("sess-1"), []string{"kill-session", "-t", "=sess-1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("killSessionArgs = %#v, want %#v", got, want)
	}
	if got, want := hasSessionArgs("sess-1"), []string{"has-session", "-t", "=sess-1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("hasSessionArgs = %#v, want %#v", got, want)
	}
	if got, want := sendKeysLiteralArgs("sess-1", "hello"), []string{"send-keys", "-t", "sess-1", "-l", "hello"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sendKeysLiteralArgs = %#v, want %#v", got, want)
	}
	if got, want := sendEnterArgs("sess-1"), []string{"send-keys", "-t", "sess-1", "Enter"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sendEnterArgs = %#v, want %#v", got, want)
	}
	if got, want := capturePaneArgs("sess-1", 10), []string{"capture-pane", "-t", "sess-1", "-p", "-S", "-10"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("capturePaneArgs = %#v, want %#v", got, want)
	}
}

// -- session name sanitization --

func TestSessionNameSanitizesSpecialChars(t *testing.T) {
	got, err := tmuxSessionName("repo/issue#42.1")
	if err != nil {
		t.Fatalf("tmuxSessionName: %v", err)
	}
	if !sessionIDPattern.MatchString(got) {
		t.Fatalf("sanitized id %q fails pattern", got)
	}
	if !strings.HasPrefix(got, "repo-issue-42-1-") {
		t.Fatalf("sanitized id = %q, want readable prefix", got)
	}
	if got == "repo/issue#42.1" {
		t.Fatal("sanitized id still contains raw unsafe characters")
	}
}

func TestSessionNamePassesThroughShortConforming(t *testing.T) {
	if got := SessionName("myproj-1"); got != "myproj-1" {
		t.Fatalf("SessionName = %q, want unchanged", got)
	}
}

func TestSessionNameMatchesCreateNaming(t *testing.T) {
	long := domain.SessionID(strings.Repeat("x", 60) + "-1")
	viaCreate, err := tmuxSessionName(long)
	if err != nil {
		t.Fatalf("tmuxSessionName: %v", err)
	}
	if got := SessionName(string(long)); got != viaCreate {
		t.Fatalf("SessionName = %q, but Create uses %q", got, viaCreate)
	}
	if SessionName(string(long)) == string(long) {
		t.Fatal("expected long id to be sanitised to a different name")
	}
}

// -- env key validation --

func TestCreateRejectsInvalidEnvKeys(t *testing.T) {
	r, fr := newTestRuntime(0)
	_ = fr
	_, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"echo", "hi"},
		Env:           map[string]string{"BAD KEY": "x"},
	})
	if err == nil || !strings.Contains(err.Error(), "invalid env key") {
		t.Fatalf("Create err = %v, want invalid env key", err)
	}
}

// -- Create tests --

func TestCreateIssuesNewSessionAndStatusOff(t *testing.T) {
	// new-session, set-option status, set-option mouse, has-session (exit 0 = alive)
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, nil, nil, nil}

	h, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"echo", "hi"},
		Env:           map[string]string{"AO_SESSION_ID": "sess-1"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if h.ID != "sess-1" {
		t.Fatalf("handle ID = %q, want sess-1", h.ID)
	}
	// Expect 4 calls: new-session, set-option status, set-option mouse, has-session.
	if len(fr.calls) != 4 {
		t.Fatalf("calls = %d, want 4", len(fr.calls))
	}

	// Call 0: new-session
	if got := fr.calls[0].args[0]; got != "new-session" {
		t.Fatalf("call[0] = %q, want new-session", got)
	}
	// Check -s <id>, -c <cwd> are present.
	joined := strings.Join(fr.calls[0].args, " ")
	if !strings.Contains(joined, "-s sess-1") {
		t.Fatalf("new-session args missing -s sess-1: %v", fr.calls[0].args)
	}
	if !strings.Contains(joined, "-c /tmp/ws") {
		t.Fatalf("new-session args missing -c /tmp/ws: %v", fr.calls[0].args)
	}
	// Ensure -x and -y are set.
	if !strings.Contains(joined, "-x 220") || !strings.Contains(joined, "-y 50") {
		t.Fatalf("new-session args missing -x/-y: %v", fr.calls[0].args)
	}

	// Call 1: set-option status off (plain target, pane-targeting does not use =).
	if got, want := fr.calls[1].args, setStatusOffArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[1] = %#v, want %#v", got, want)
	}

	// Call 2: set-option mouse on (enables wheel-scroll of the pane).
	if got, want := fr.calls[2].args, setMouseOnArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[2] = %#v, want %#v", got, want)
	}

	// Call 3: has-session (IsAlive, uses exact-match target =sess-1).
	if got, want := fr.calls[3].args, hasSessionArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[3] = %#v, want %#v", got, want)
	}
}

func TestCreateLaunchCommandContainsKeepAliveShell(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, nil, nil}

	_, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent", "--flag"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// The launch command is the last argument to new-session (after shellPath -c).
	args := fr.calls[0].args
	launchCmd := args[len(args)-1]
	if !strings.Contains(launchCmd, `exec "${SHELL:-/bin/sh}" -i`) {
		t.Fatalf("launch command missing keep-alive shell: %q", launchCmd)
	}
	if !strings.Contains(launchCmd, "'myagent'") {
		t.Fatalf("launch command missing quoted argv: %q", launchCmd)
	}
}

func TestCreateLaunchCommandExportsEnvVars(t *testing.T) {
	oldGetenv := getenv
	getenv = func(key string) string {
		if key == "PATH" {
			return "/usr/bin:/bin"
		}
		return ""
	}
	defer func() { getenv = oldGetenv }()

	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, nil, nil}

	_, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
		Env: map[string]string{
			"AO_SESSION_ID": "sess-1",
			"ODD":           "can't",
			"PATH":          "/custom/bin:/usr/bin",
		},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	args := fr.calls[0].args
	launchCmd := args[len(args)-1]
	for _, want := range []string{
		"export AO_SESSION_ID='sess-1';",
		"export ODD='can'\\''t';",
		"export PATH='/custom/bin:/usr/bin';",
	} {
		if !strings.Contains(launchCmd, want) {
			t.Fatalf("launch command missing %q in: %q", want, launchCmd)
		}
	}
}

func TestCreateDestroysAndReturnsErrorWhenNotAlive(t *testing.T) {
	// Use a specialized fakeRunner that returns an exit error only for the 3rd call.
	r2, _ := newTestRuntime(0)
	fr3 := &fakeRunnerSelectiveErr{exitErrAt: 3}
	fr3.outputs = [][]byte{nil, nil, nil, []byte("can't find session: sess-1")}
	r2.runner = fr3

	_, err := r2.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
	})
	if err == nil {
		t.Fatal("Create: got nil, want error when session not alive after create")
	}
	// Verify Destroy was called (kill-session).
	hasKill := false
	for _, c := range fr3.calls {
		if len(c.args) > 0 && c.args[0] == "kill-session" {
			hasKill = true
		}
	}
	if !hasKill {
		t.Fatal("expected kill-session cleanup call when session not alive")
	}
}

// fakeRunnerSelectiveErr returns an exec.ExitError for the call at index exitErrAt.
type fakeRunnerSelectiveErr struct {
	calls     []runnerCall
	outputs   [][]byte
	exitErrAt int
}

func (f *fakeRunnerSelectiveErr) Run(_ context.Context, env []string, name string, args ...string) ([]byte, error) {
	idx := len(f.calls)
	f.calls = append(f.calls, runnerCall{env: append([]string(nil), env...), name: name, args: append([]string(nil), args...)})
	var out []byte
	if len(f.outputs) > 0 {
		out = f.outputs[0]
		f.outputs = f.outputs[1:]
	}
	if idx == f.exitErrAt {
		return out, &exec.ExitError{}
	}
	return out, nil
}

// -- Destroy tests --

func TestDestroyIsIdempotentWhenSessionMissing(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("can't find session: sess-1")}
	fr.err = &exec.ExitError{}

	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if len(fr.calls) != 1 || fr.calls[0].args[0] != "kill-session" {
		t.Fatalf("calls = %#v, want only kill-session", fr.calls)
	}
}

func TestDestroyIsIdempotentWhenNoServer(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("no server running on /tmp/tmux-1000/default")}
	fr.err = &exec.ExitError{}

	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err != nil {
		t.Fatalf("Destroy no-server: %v", err)
	}
}

func TestDestroyReportsUnexpectedFailures(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("permission denied")}
	fr.err = &exec.ExitError{}

	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err == nil {
		t.Fatal("Destroy: got nil, want unexpected failure error")
	}
}

func TestDestroyArgs(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil}

	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	// killSessionArgs uses exact-match target =<id>.
	if got, want := fr.calls[0].args, killSessionArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("destroy args = %#v, want %#v", got, want)
	}
}

// -- IsAlive tests --

func TestIsAliveReturnsTrueOnExitZero(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("IsAlive: %v", err)
	}
	if !alive {
		t.Fatal("alive = false, want true")
	}
	if got, want := fr.calls[0].args, hasSessionArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("has-session args = %#v, want %#v", got, want)
	}
}

func TestIsAliveReturnsFalseNilOnCantFindSession(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("can't find session: sess-1")}
	fr.err = &exec.ExitError{}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("IsAlive: %v", err)
	}
	if alive {
		t.Fatal("alive = true, want false")
	}
}

func TestIsAliveReturnsFalseNilOnNoServer(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("no server running on /tmp/tmux-1000/default")}
	fr.err = &exec.ExitError{}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("IsAlive: %v", err)
	}
	if alive {
		t.Fatal("alive = true, want false")
	}
}

func TestIsAliveReturnsFalseNilOnErrorConnecting(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("error connecting to /tmp/tmux-1000/default (No such file or directory)")}
	fr.err = &exec.ExitError{}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("IsAlive error connecting: %v", err)
	}
	if alive {
		t.Fatal("alive = true, want false")
	}
}

// IsAlive must treat any non-"missing" non-zero exit as a probe error so the
// reaper never reads a transient failure as proof of death.
func TestIsAliveReportsOtherExitFailuresAsProbeErrors(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("unexpected internal error")}
	fr.err = &exec.ExitError{}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err == nil {
		t.Fatal("IsAlive: got nil, want probe error; failed probe must not read as dead")
	}
	if alive {
		t.Fatal("alive = true on probe failure")
	}
}

// -- SendMessage tests --

func TestSendMessageChunksAndSendsEnter(t *testing.T) {
	r, fr := newTestRuntime(5) // chunkSize=5
	// "hello世界": hello=5 bytes, 世=3 bytes, 界=3 bytes => 3 sends + 1 Enter
	if err := r.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "hello世界"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(fr.calls) != 4 {
		t.Fatalf("calls = %d, want 4 (3 chunks + Enter)", len(fr.calls))
	}
	if got, want := fr.calls[0].args, sendKeysLiteralArgs("sess-1", "hello"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 1 args = %#v, want %#v", got, want)
	}
	if got, want := fr.calls[1].args, sendKeysLiteralArgs("sess-1", "世"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 2 args = %#v, want %#v", got, want)
	}
	if got, want := fr.calls[2].args, sendKeysLiteralArgs("sess-1", "界"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 3 args = %#v, want %#v", got, want)
	}
	if got, want := fr.calls[3].args, sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Enter args = %#v, want %#v", got, want)
	}
}

func TestSendMessageUsesLiteralFlag(t *testing.T) {
	r, fr := newTestRuntime(0)
	if err := r.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "Enter"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	// First call must use -l so "Enter" is sent literally, not as a key binding.
	if fr.calls[0].args[3] != "-l" {
		t.Fatalf("send-keys args[3] = %q, want -l", fr.calls[0].args[3])
	}
}

// TestSendMessageDelaysBeforeEnter verifies the pre-Enter pause (mirroring
// conpty's ptyInputEnterDelay) fires only for a non-empty message: a large
// multiline paste needs time to settle before the trailing Enter, or the Enter
// is absorbed and the prompt is left unsubmitted (issue #2342). An empty
// (nudge) message skips the pause — there is no paste ahead of a catch-up Enter.
func TestSendMessageDelaysBeforeEnter(t *testing.T) {
	// enterDelay=0 (the test default) => no pause: SendMessage is near-instant.
	r0, _ := newTestRuntime(0)
	r0.enterDelay = 0
	start := time.Now()
	if err := r0.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "hi"); err != nil {
		t.Fatalf("SendMessage (no delay): %v", err)
	}
	if dt := time.Since(start); dt > 50*time.Millisecond {
		t.Fatalf("SendMessage with enterDelay=0 took %s; want no real pause", dt)
	}

	// enterDelay>0 => SendMessage blocks at least enterDelay before Enter, but
	// only for a non-empty message.
	r, fr := newTestRuntime(0)
	r.enterDelay = 30 * time.Millisecond
	start = time.Now()
	if err := r.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "hello"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if dt := time.Since(start); dt < r.enterDelay {
		t.Fatalf("SendMessage took %s, want >= %s pre-Enter pause", dt, r.enterDelay)
	}
	// Non-empty message still ends with the literal chunks then Enter.
	if len(fr.calls) != 2 {
		t.Fatalf("calls = %d, want 2 (chunk + Enter)", len(fr.calls))
	}
	if got, want := fr.calls[1].args, sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Enter args = %#v, want %#v", got, want)
	}

	// Empty (nudge) message: no paste, no pause — even with enterDelay set.
	rNudge, frNudge := newTestRuntime(0)
	rNudge.enterDelay = 30 * time.Millisecond
	start = time.Now()
	if err := rNudge.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ""); err != nil {
		t.Fatalf("SendMessage (nudge): %v", err)
	}
	if dt := time.Since(start); dt > 50*time.Millisecond {
		t.Fatalf("nudge SendMessage took %s; want no pause for empty message", dt)
	}
	// Empty message is Enter-only: no send-keys -l call, just Enter.
	if len(frNudge.calls) != 1 {
		t.Fatalf("nudge calls = %d, want 1 (Enter only)", len(frNudge.calls))
	}
	if got, want := frNudge.calls[0].args, sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("nudge Enter args = %#v, want %#v", got, want)
	}
}

// TestSendMessageEnterSurvivesCallerCancel pins the detached-Enter contract:
// once the chunks are pasted, a caller cancellation landing in the pre-Enter
// pause must NOT abandon the send — the pasted draft would sit unsubmitted and
// a retried send would double-paste. The pause and Enter run on a context
// detached from the caller's, so SendMessage completes (chunks then Enter).
func TestSendMessageEnterSurvivesCallerCancel(t *testing.T) {
	r, fr := newTestRuntime(0)
	// A pause long enough that the 50ms-delayed cancel deterministically lands
	// inside it (the chunk send is near-instant against the fake runner).
	r.enterDelay = 200 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(50*time.Millisecond, cancel)
	defer timer.Stop()

	if err := r.SendMessage(ctx, ports.RuntimeHandle{ID: "sess-1"}, "hello"); err != nil {
		t.Fatalf("SendMessage cancelled mid-pause: %v (Enter must run detached)", err)
	}
	if len(fr.calls) != 2 {
		t.Fatalf("calls = %d, want 2 (chunk + Enter despite the caller cancel after the paste)", len(fr.calls))
	}
	if got, want := fr.calls[1].args, sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Enter args = %#v, want %#v", got, want)
	}
}

// -- GetOutput tests --

func TestGetOutputValidatesLines(t *testing.T) {
	r, _ := newTestRuntime(0)
	_, err := r.GetOutput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, 0)
	if err == nil {
		t.Fatal("GetOutput lines=0: got nil, want error")
	}
}

func TestGetOutputTrimsLines(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("one\ntwo\nthree\n")}

	out, err := r.GetOutput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, 2)
	if err != nil {
		t.Fatalf("GetOutput: %v", err)
	}
	if out != "two\nthree\n" {
		t.Fatalf("output = %q, want last two lines", out)
	}
}

func TestGetOutputTrimsTrailingScreenPaddingBeforeTailing(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("ready\nprompt> echo hi\nhi\n\n\n\n")}

	out, err := r.GetOutput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, 2)
	if err != nil {
		t.Fatalf("GetOutput: %v", err)
	}
	if out != "prompt> echo hi\nhi\n" {
		t.Fatalf("output = %q, want last non-padding lines", out)
	}
}

func TestGetOutputArgs(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("output\n")}

	_, err := r.GetOutput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, 10)
	if err != nil {
		t.Fatalf("GetOutput: %v", err)
	}
	if got, want := fr.calls[0].args, capturePaneArgs("sess-1", 10); !reflect.DeepEqual(got, want) {
		t.Fatalf("capture-pane args = %#v, want %#v", got, want)
	}
}

// -- AttachCommand tests --

func TestAttachCommandReturnsExpectedArgv(t *testing.T) {
	r := New(Options{Binary: "/usr/bin/tmux", Timeout: time.Second})
	argv, err := r.attachCommand(ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("AttachCommand: %v", err)
	}
	want := []string{"/usr/bin/tmux", "attach-session", "-t", "sess-1"}
	if !reflect.DeepEqual(argv, want) {
		t.Fatalf("argv = %#v, want %#v", argv, want)
	}
}

func TestAttachCommandRejectsInvalidHandle(t *testing.T) {
	r := New(Options{})
	_, err := r.attachCommand(ports.RuntimeHandle{ID: ""})
	if err == nil {
		t.Fatal("AttachCommand empty handle: got nil, want error")
	}
}

func TestAttachEnvForcesUsableTerm(t *testing.T) {
	env := attachEnv([]string{"PATH=/bin", "TERM=dumb", "SHELL=/bin/sh"})
	if got, want := env, []string{"PATH=/bin", "TERM=xterm-256color", "SHELL=/bin/sh"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("attachEnv = %#v, want %#v", got, want)
	}

	env = attachEnv([]string{"PATH=/bin"})
	if got, want := env, []string{"PATH=/bin", "TERM=xterm-256color"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("attachEnv without TERM = %#v, want %#v", got, want)
	}
}

// -- commandError tests --

func TestCommandErrorUnwraps(t *testing.T) {
	base := errors.New("base")
	err := commandError{err: base, output: "details"}
	if !errors.Is(err, base) {
		t.Fatal("commandError should unwrap base error")
	}
	if !strings.Contains(err.Error(), "details") {
		t.Fatalf("error = %q, want output details", err.Error())
	}
}

// -- text helper tests --

func TestChunks(t *testing.T) {
	if got := chunks("", 5); !reflect.DeepEqual(got, []string{""}) {
		t.Fatalf("chunks empty = %#v", got)
	}
	if got := chunks("hello", 10); !reflect.DeepEqual(got, []string{"hello"}) {
		t.Fatalf("chunks fits = %#v", got)
	}
	// UTF-8 boundary: 世 is 3 bytes; with chunkSize=5 "hello世界" splits at 5,6,6
	got := chunks("hello世界", 5)
	if len(got) != 3 {
		t.Fatalf("chunks count = %d, want 3: %#v", len(got), got)
	}
	if got[0] != "hello" || got[1] != "世" || got[2] != "界" {
		t.Fatalf("chunks = %#v, want [hello 世 界]", got)
	}
}

func TestTailLines(t *testing.T) {
	if got := tailLines("a\nb\nc\n", 2); got != "b\nc\n" {
		t.Fatalf("tailLines = %q, want b/c", got)
	}
	if got := tailLines("a\nb\n", 5); got != "a\nb\n" {
		t.Fatalf("tailLines fewer = %q", got)
	}
	if got := tailLines("", 5); got != "" {
		t.Fatalf("tailLines empty = %q", got)
	}
}

func TestTrimTrailingBlankLines(t *testing.T) {
	if got := trimTrailingBlankLines("a\nb\n\n\n"); got != "a\nb\n" {
		t.Fatalf("trimTrailingBlankLines = %q, want a/b", got)
	}
	if got := trimTrailingBlankLines(""); got != "" {
		t.Fatalf("trimTrailingBlankLines empty = %q", got)
	}
}
