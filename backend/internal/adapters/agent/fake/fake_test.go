package fake

import (
	"context"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifestReportsFakeHarness(t *testing.T) {
	m := New().Manifest()
	if m.ID != "fake" {
		t.Fatalf("Manifest().ID = %q, want %q", m.ID, "fake")
	}
	if domain.AgentHarness(m.ID) != domain.HarnessFake {
		t.Fatalf("manifest id %q does not match domain.HarnessFake %q", m.ID, domain.HarnessFake)
	}
	if !domain.HarnessFake.IsKnown() {
		t.Fatal("domain.HarnessFake is not registered as a known harness")
	}
	found := false
	for _, c := range m.Capabilities {
		if c == "agent" {
			found = true
		}
	}
	if !found {
		t.Fatalf("manifest missing agent capability: %#v", m.Capabilities)
	}
}

func TestGetLaunchCommandIsScriptedTimeline(t *testing.T) {
	// Fixed speedup so the emitted sleep is deterministic in the assertions.
	t.Setenv(SpeedupEnv, "4")
	cmd, err := New().GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt: "ignored by the fake",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(cmd) != 3 || cmd[0] != "sh" || cmd[1] != "-lc" {
		t.Fatalf("launch command shape = %#v, want [sh -lc <script>]", cmd)
	}

	script := cmd[2]
	// Events must appear in timeline order: active -> waiting_input -> active -> done.
	wantOrder := []string{
		"ao hooks fake session-start",
		"ao hooks fake permission-request",
		"ao hooks fake user-prompt-submit",
		"ao hooks fake stop",
	}
	last := 0
	for _, want := range wantOrder {
		idx := strings.Index(script[last:], want)
		if idx < 0 {
			t.Fatalf("script missing %q in order; script:\n%s", want, script)
		}
		last += idx + len(want)
	}

	// basePhaseSeconds (2) / speedup (4) = 0.5.
	if !strings.Contains(script, "sleep 0.5") {
		t.Fatalf("script does not sleep at the sped-up cadence (0.5s); script:\n%s", script)
	}
	// Hooks must read from /dev/null and never fail the timeline.
	if !strings.Contains(script, "</dev/null") || !strings.Contains(script, "|| true") {
		t.Fatalf("hook invocations are not guarded/stdin-fed; script:\n%s", script)
	}
}

func TestGetLaunchCommandDefaultsToBaseCadence(t *testing.T) {
	t.Setenv(SpeedupEnv, "")
	cmd, err := New().GetLaunchCommand(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cmd[2], "sleep 2") {
		t.Fatalf("default cadence should sleep basePhaseSeconds (2s); got:\n%s", cmd[2])
	}
}

func TestPhaseSleepIgnoresBadSpeedup(t *testing.T) {
	for _, raw := range []string{"", "0", "-3", "abc"} {
		getenv = func(string) string { return raw }
		if got := phaseSleep(); got != basePhaseSeconds {
			t.Fatalf("phaseSleep() with %q = %v, want base %v", raw, got, basePhaseSeconds)
		}
	}
	getenv = func(string) string { return "2" }
	if got := phaseSleep(); got != basePhaseSeconds/2 {
		t.Fatalf("phaseSleep() with speedup 2 = %v, want %v", got, basePhaseSeconds/2)
	}
	t.Cleanup(func() { getenv = func(k string) string { return "" } })
}

func TestDeriveActivityStateMapping(t *testing.T) {
	tests := []struct {
		event string
		want  domain.ActivityState
		ok    bool
	}{
		{"session-start", domain.ActivityActive, true},
		{"user-prompt-submit", domain.ActivityActive, true},
		{"permission-request", domain.ActivityWaitingInput, true},
		{"stop", domain.ActivityIdle, true},
		{"unknown-event", "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		got, ok := DeriveActivityState(tt.event, nil)
		if got != tt.want || ok != tt.ok {
			t.Errorf("DeriveActivityState(%q) = (%q, %v), want (%q, %v)", tt.event, got, ok, tt.want, tt.ok)
		}
	}
}

func TestAuthStatusIsAuthorized(t *testing.T) {
	status, err := New().AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want authorized", status)
	}
}

func TestGetPromptDeliveryStrategyIsInCommand(t *testing.T) {
	got, err := New().GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.PromptDeliveryInCommand {
		t.Fatalf("prompt delivery strategy = %q, want in_command", got)
	}
}
