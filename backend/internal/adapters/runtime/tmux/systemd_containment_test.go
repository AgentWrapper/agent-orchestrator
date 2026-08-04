package tmux

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestContainmentUnitNameIsDeterministic(t *testing.T) {
	if got, want := containmentUnitName("session-42"), "ao-session-session-42.scope"; got != want {
		t.Fatalf("containmentUnitName = %q, want %q", got, want)
	}
	if got := containmentUnitName("session with spaces"); strings.ContainsAny(got, " '") {
		t.Fatalf("containmentUnitName contains unsafe characters: %q", got)
	}
}

func TestSystemdWrapCommandKeepsExistingShellAsOneArgument(t *testing.T) {
	s := newSystemdContainment(&fakeRunner{}, time.Second, 5*time.Second)
	got := s.WrapCommand("/bin/sh", "cd '/tmp/ws'; exec 'codex'", "ao-session-s1.scope", 5*time.Second)
	want := `exec systemd-run --user --scope --collect --unit=ao-session-s1.scope ` +
		`--property=KillMode=control-group --property=TimeoutStopSec=5s ` +
		`--property=SendSIGKILL=yes -- '/bin/sh' -c 'cd '\''/tmp/ws'\''; exec '\''codex'\'''`
	if got != want {
		t.Fatalf("wrapped launch command = %q, want %q", got, want)
	}
}

func TestParseSystemdUnitState(t *testing.T) {
	got, err := parseSystemdUnitState("LoadState=loaded\nActiveState=inactive\nSubState=dead\n")
	if err != nil {
		t.Fatal(err)
	}
	if !got.released() || got.active() {
		t.Fatalf("state = %+v, want released and not active", got)
	}
	if _, err := parseSystemdUnitState("LoadState=loaded\nActiveState=active\n"); err == nil {
		t.Fatal("parseSystemdUnitState accepted missing SubState")
	}
	if _, err := parseSystemdUnitState("not-a-state-line"); err == nil {
		t.Fatal("parseSystemdUnitState accepted malformed line")
	}
}

func TestSystemdReleaseAcceptsInactiveAndMissing(t *testing.T) {
	tests := []struct {
		name   string
		state  string
		wantOK bool
	}{
		{name: "inactive", state: "LoadState=loaded\nActiveState=inactive\nSubState=dead\n", wantOK: true},
		{name: "not-found", state: "LoadState=not-found\nActiveState=inactive\nSubState=dead\n", wantOK: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fr := &fakeRunner{outputs: [][]byte{nil, []byte(tc.state)}}
			s := newSystemdContainment(fr, time.Second, time.Second)
			s.poll = time.Millisecond
			if err := s.Release(context.Background(), "ao-session-s1.scope"); (err == nil) != tc.wantOK {
				t.Fatalf("Release error = %v, wantOK=%v", err, tc.wantOK)
			}
			if len(fr.calls) != 2 || !reflect.DeepEqual(fr.calls[0].args, []string{"--user", "stop", "ao-session-s1.scope"}) {
				t.Fatalf("systemctl calls = %#v", fr.calls)
			}
		})
	}
}

func TestSystemdReleaseRejectsActiveAndMalformedState(t *testing.T) {
	for _, state := range []string{
		"LoadState=loaded\nActiveState=active\nSubState=running\n",
		"LoadState=loaded\nActiveState=deactivating\nSubState=stop-sigterm\n",
		"LoadState=loaded\nActiveState=unknown\nSubState=unknown\n",
	} {
		t.Run(strings.ReplaceAll(state, "\n", "/"), func(t *testing.T) {
			fr := &fakeRunner{outputs: [][]byte{nil, []byte(state)}}
			s := newSystemdContainment(fr, 20*time.Millisecond, 0)
			s.poll = time.Millisecond
			err := s.Release(context.Background(), "ao-session-s1.scope")
			if err == nil {
				t.Fatalf("Release(%q) = nil, want error", state)
			}
		})
	}
}

func TestSystemdWaitActiveIsBoundedWhenUnitNeverAppears(t *testing.T) {
	outputs := make([][]byte, 32)
	for i := range outputs {
		outputs[i] = []byte("LoadState=not-found\nActiveState=inactive\nSubState=dead\n")
	}
	s := newSystemdContainment(&fakeRunner{outputs: outputs}, 10*time.Millisecond, 0)
	s.poll = time.Millisecond
	if err := s.WaitActive(context.Background(), "ao-session-never.scope"); err == nil || !strings.Contains(err.Error(), "did not become active") {
		t.Fatalf("WaitActive error = %v, want bounded timeout", err)
	}
}

type fakeContainment struct {
	validateErr error
	releaseErr  error
	wrap        string
	validated   int
	wrapped     []string
	waited      []string
	released    []string
}

func (f *fakeContainment) Validate(context.Context) error {
	f.validated++
	return f.validateErr
}

func (f *fakeContainment) WrapCommand(_, launchCmd, unit string, _ time.Duration) string {
	f.wrapped = append(f.wrapped, unit+":"+launchCmd)
	if f.wrap != "" {
		return f.wrap
	}
	return launchCmd
}

func (f *fakeContainment) WaitActive(_ context.Context, unit string) error {
	f.waited = append(f.waited, unit)
	return nil
}

func (f *fakeContainment) Release(_ context.Context, unit string) error {
	f.released = append(f.released, unit)
	return f.releaseErr
}

func TestScopedCreateAddsRemainOnExitAndVerifiesScope(t *testing.T) {
	r, fr := newTestRuntime(0)
	fc := &fakeContainment{wrap: "wrapped-launch"}
	r.containment = fc
	fr.outputs = [][]byte{nil, nil, []byte("/tmp/ws\n"), nil, nil, nil, nil}
	if _, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"codex"},
	}); err != nil {
		t.Fatal(err)
	}
	if fc.validated != 1 || len(fc.waited) != 1 || fc.waited[0] != "ao-session-sess-1.scope" {
		t.Fatalf("containment lifecycle = validated %d, waited %#v", fc.validated, fc.waited)
	}
	if len(fr.calls) < 2 || !reflect.DeepEqual(fr.calls[1].args, setRemainOnExitArgs("sess-1")) {
		t.Fatalf("calls = %#v, want remain-on-exit after new-session", fr.calls)
	}
	if !strings.Contains(fr.calls[0].args[len(fr.calls[0].args)-1], "wrapped-launch") {
		t.Fatalf("new-session did not use wrapped launch: %#v", fr.calls[0].args)
	}
}

func TestScopedRestartReleasesBeforeRespawn(t *testing.T) {
	r, fr := newTestRuntime(0)
	fc := &fakeContainment{}
	r.containment = fc
	fr.outputs = [][]byte{nil, nil}
	h, err := r.Restart(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"codex"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if h.ID != "sess-1" || !reflect.DeepEqual(fc.released, []string{"ao-session-sess-1.scope"}) {
		t.Fatalf("restart = %+v, releases %#v", h, fc.released)
	}
	if len(fr.calls) != 2 || fr.calls[0].args[0] != "respawn-pane" {
		t.Fatalf("calls = %#v, want respawn then liveness", fr.calls)
	}
}

func TestScopedRestartDoesNotRespawnAfterReleaseFailure(t *testing.T) {
	r, fr := newTestRuntime(0)
	fc := &fakeContainment{releaseErr: errors.New("scope still active")}
	r.containment = fc
	_, err := r.Restart(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"codex"},
	})
	if err == nil || !strings.Contains(err.Error(), "scope still active") {
		t.Fatalf("Restart error = %v, want containment failure", err)
	}
	if len(fr.calls) != 0 {
		t.Fatalf("runtime called after release failure: %#v", fr.calls)
	}
}

func TestScopedDestroyReleasesEvenWhenTmuxIsMissing(t *testing.T) {
	r, fr := newTestRuntime(0)
	fc := &fakeContainment{}
	r.containment = fc
	fr.outputs = [][]byte{[]byte("can't find session: sess-1")}
	fr.err = &exec.ExitError{}
	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err != nil {
		t.Fatal(err)
	}
	if len(fr.calls) != 1 || fr.calls[0].args[0] != "kill-session" {
		t.Fatalf("calls = %#v, want only kill-session", fr.calls)
	}
	if !reflect.DeepEqual(fc.released, []string{"ao-session-sess-1.scope"}) {
		t.Fatalf("released = %#v", fc.released)
	}
}
