package review

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type foregroundRuntime struct {
	reviewerRuntime
	alive      bool
	aliveErr   error
	foreground string
	fgErr      error
}

func (f foregroundRuntime) IsAlive(context.Context, ports.RuntimeHandle) (bool, error) {
	return f.alive, f.aliveErr
}

func (f foregroundRuntime) ForegroundCommand(context.Context, ports.RuntimeHandle) (string, error) {
	return f.foreground, f.fgErr
}

// A terminal outliving its agent is the case that mattered: tmux keeps the pane
// at a shell prompt, and calling that alive made Trigger type the review prompt
// into the shell instead of launching a reviewer.
func TestAliveTreatsAShellAsNoReviewer(t *testing.T) {
	for _, tc := range []struct {
		name       string
		runtime    foregroundRuntime
		want       bool
		wantErrNil bool
	}{
		{name: "agent running", runtime: foregroundRuntime{alive: true, foreground: "claude"}, want: true},
		{name: "agent exited to zsh", runtime: foregroundRuntime{alive: true, foreground: "zsh"}, want: false},
		{name: "login shell form", runtime: foregroundRuntime{alive: true, foreground: "-bash"}, want: false},
		{name: "no terminal at all", runtime: foregroundRuntime{alive: false}, want: false},
		// A probe that fails tells us nothing, so keep the reviewer rather than
		// destroying a working pane over a transient error.
		{name: "probe error keeps the pane", runtime: foregroundRuntime{alive: true, fgErr: errors.New("boom")}, want: true},
		{name: "unknown foreground keeps the pane", runtime: foregroundRuntime{alive: true, foreground: ""}, want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := &agentLauncher{runtime: tc.runtime}
			got, err := l.Alive(context.Background(), "reviewer-w1")
			if err != nil {
				t.Fatalf("Alive: %v", err)
			}
			if got != tc.want {
				t.Fatalf("Alive = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestAliveIsFalseWithoutAHandle(t *testing.T) {
	l := &agentLauncher{runtime: foregroundRuntime{alive: true, foreground: "claude"}}
	got, err := l.Alive(context.Background(), "")
	if err != nil || got {
		t.Fatalf("Alive = %v, %v; want false, nil", got, err)
	}
}
