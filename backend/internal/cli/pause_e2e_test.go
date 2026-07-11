package cli

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
)

// TestE2E_PauseResumeCommands drives `ao pause` / `ao resume` through the real
// loopback to the daemon router, asserting the CLI hits the right endpoints for
// per-project and fleet targets.
func TestE2E_PauseResumeCommands(t *testing.T) {
	run := func(t *testing.T, projects *fakeProjectManager, args ...string) string {
		t.Helper()
		startDriftTestDaemon(t, &fakeSessionService{}, projects)
		var out bytes.Buffer
		root := NewRootCommand(Deps{
			Out:          &out,
			Err:          &out,
			HTTPClient:   &http.Client{},
			ProcessAlive: func(int) bool { return true },
		})
		root.SetArgs(args)
		if err := root.Execute(); err != nil {
			t.Fatalf("%v execute: %v\noutput: %s", args, err, out.String())
		}
		return out.String()
	}

	t.Run("pause project", func(t *testing.T) {
		projects := &fakeProjectManager{}
		out := run(t, projects, "pause", "mer")
		if projects.pausedProject == nil || string(*projects.pausedProject) != "mer" || !projects.pausedValue {
			t.Fatalf("pause did not reach project mer: %+v", projects)
		}
		if !strings.Contains(out, "Project mer paused") {
			t.Fatalf("output = %q, want project pause confirmation", out)
		}
	})

	t.Run("resume project", func(t *testing.T) {
		projects := &fakeProjectManager{}
		out := run(t, projects, "resume", "mer")
		if projects.pausedProject == nil || projects.pausedValue {
			t.Fatalf("resume did not clear project mer: %+v", projects)
		}
		if !strings.Contains(out, "Project mer resumed") {
			t.Fatalf("output = %q, want project resume confirmation", out)
		}
	})

	t.Run("pause fleet", func(t *testing.T) {
		projects := &fakeProjectManager{}
		out := run(t, projects, "pause", "--all")
		if projects.fleetSet == nil || !*projects.fleetSet {
			t.Fatalf("pause --all did not set fleet paused: %+v", projects)
		}
		if !strings.Contains(out, "Fleet paused") {
			t.Fatalf("output = %q, want fleet pause confirmation", out)
		}
	})

	t.Run("resume fleet", func(t *testing.T) {
		projects := &fakeProjectManager{fleetPaused: true}
		out := run(t, projects, "resume", "--all")
		if projects.fleetSet == nil || *projects.fleetSet {
			t.Fatalf("resume --all did not clear fleet paused: %+v", projects)
		}
		if !strings.Contains(out, "Fleet resumed") {
			t.Fatalf("output = %q, want fleet resume confirmation", out)
		}
	})

	t.Run("hard pause project", func(t *testing.T) {
		projects := &fakeProjectManager{}
		run(t, projects, "pause", "mer", "--hard")
		if !projects.pausedHard {
			t.Fatal("--hard did not propagate to the project pause request")
		}
	})

	t.Run("hard pause fleet", func(t *testing.T) {
		projects := &fakeProjectManager{}
		run(t, projects, "pause", "--all", "--hard")
		if !projects.fleetHard {
			t.Fatal("--hard did not propagate to the fleet pause request")
		}
	})
}

// TestPauseRequiresTarget: `ao pause` with neither a project nor --all is a
// usage error, not a silent no-op.
func TestPauseRequiresTarget(t *testing.T) {
	startDriftTestDaemon(t, &fakeSessionService{}, &fakeProjectManager{})
	var out bytes.Buffer
	root := NewRootCommand(Deps{
		Out:          &out,
		Err:          &out,
		HTTPClient:   &http.Client{},
		ProcessAlive: func(int) bool { return true },
	})
	root.SetArgs([]string{"pause"})
	if err := root.Execute(); err == nil {
		t.Fatalf("pause with no target should error; output: %s", out.String())
	}
}
