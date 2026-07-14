// Package fake implements a deterministic, LLM-free agent harness. It exists so
// e2e tests can drive the full session lifecycle (spawning -> active ->
// waiting_input -> active -> done) without a real CLI, a network round-trip, or
// any token spend.
//
// The launch command is a small POSIX shell script that walks a fixed timeline:
// it prints canned marker lines to its pane and calls `ao hooks fake <event>`
// at each phase, exactly the way real agents report activity through their
// native hooks. The daemon pins the session PATH to its own binary and sets
// AO_SESSION_ID/AO_DATA_DIR, so the bare `ao` in the script reaches the daemon
// and its activity reports land against the spawning session.
//
// Timing is controlled by AO_FAKE_SPEEDUP (a float, default 1): every phase
// sleeps for a base duration divided by the speedup, so tests can compress the
// whole run into well under a second (issue prereq #4, clock control).
package fake

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// SpeedupEnv is the environment variable that divides every phase duration. A
// value <= 0 or unparseable falls back to 1 (real-time base durations).
const SpeedupEnv = "AO_FAKE_SPEEDUP"

// basePhaseSeconds is how long each timeline phase lasts at speedup 1. Five
// phases (spawning, active, waiting_input, active, done tail) give an ~10s run
// unspeeded, which AO_FAKE_SPEEDUP compresses for tests.
const basePhaseSeconds = 2.0

// getenv is a seam so tests can control the speedup without mutating the
// process environment.
var getenv = os.Getenv

// Plugin is the fake agent adapter. It holds no state and is safe for
// concurrent use.
type Plugin struct {
	agentbase.Base
}

// New returns a ready-to-register fake adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)
var _ ports.AgentAuthChecker = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          "fake",
		Name:        "Fake",
		Description: "Deterministic LLM-free harness for e2e tests.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand returns `sh -lc <script>`, where the script walks the fixed
// activity timeline. cfg is intentionally ignored except that it is honored via
// ctx cancellation: the fake never consults the prompt, permissions, or
// workspace, so its behavior is fully deterministic.
func (p *Plugin) GetLaunchCommand(ctx context.Context, _ ports.LaunchConfig) (cmd []string, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return []string{"sh", "-lc", timelineScript(phaseSleep())}, nil
}

// AuthStatus reports authorized unconditionally: the fake needs no credentials.
// It exists so the fake satisfies the registry contract that every shipped
// harness expose an auth probe.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	return ports.AgentAuthStatusAuthorized, nil
}

// DeriveActivityState maps a fake hook sub-command name onto an AO activity
// state. The bool is false when the event carries no activity signal. It is the
// deriver registered for the "fake" token in activitydispatch, and it mirrors
// the events timelineScript emits:
//
//   - session-start / user-prompt-submit → active
//   - permission-request                 → waiting_input
//   - stop                               → idle
func DeriveActivityState(event string, _ []byte) (domain.ActivityState, bool) {
	switch event {
	case "session-start", "user-prompt-submit":
		return domain.ActivityActive, true
	case "permission-request":
		return domain.ActivityWaitingInput, true
	case "stop":
		return domain.ActivityIdle, true
	default:
		return "", false
	}
}

// phaseSleep resolves the per-phase sleep duration in seconds from
// AO_FAKE_SPEEDUP, defaulting to basePhaseSeconds at speedup 1.
func phaseSleep() float64 {
	speedup := 1.0
	if raw := strings.TrimSpace(getenv(SpeedupEnv)); raw != "" {
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && parsed > 0 {
			speedup = parsed
		}
	}
	return basePhaseSeconds / speedup
}

// timelineScript builds the POSIX shell script the fake runs. Each `ao hooks`
// call takes its stdin from /dev/null (the hook reads a payload from stdin) and
// swallows output, and is guarded with `|| true` so a missing/unreachable
// daemon never fails the fake mid-timeline. The states, in order:
//
//	(launch) spawning -> active -> waiting_input -> active -> done
//
// The leading sleep leaves the session in its pre-activity spawning state long
// enough to be observed before the first hook flips it to active.
func timelineScript(sleepSeconds float64) string {
	d := formatSeconds(sleepSeconds)
	var b strings.Builder
	line := func(marker, event string) {
		fmt.Fprintf(&b, "printf '%%s\\n' 'fake-agent: %s'\n", marker)
		if event != "" {
			fmt.Fprintf(&b, "ao hooks fake %s </dev/null >/dev/null 2>&1 || true\n", event)
		}
		fmt.Fprintf(&b, "sleep %s\n", d)
	}
	line("spawning", "")
	line("active", "session-start")
	line("waiting for input", "permission-request")
	line("active", "user-prompt-submit")
	line("done", "stop")
	return b.String()
}

// formatSeconds renders a duration for the shell `sleep` builtin: a compact
// decimal with no trailing zero noise (GNU/BSD sleep both accept fractions).
func formatSeconds(s float64) string {
	return strconv.FormatFloat(s, 'f', -1, 64)
}
