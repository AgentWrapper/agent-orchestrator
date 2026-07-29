// Package registry is the single source of truth for the agent adapters the
// daemon ships. The daemon wires sessions through it, so adding a harness is a
// single edit to Constructors rather than a list maintained in several places.
package registry

import (
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agy"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/aider"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/amp"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/auggie"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/autohand"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/cline"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/codex"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/continueagent"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/copilot"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/crush"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/cursor"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/devin"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/droid"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/fake"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/goose"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/grok"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/kilocode"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/kimi"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/kiro"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/opencode"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/pi"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/qwen"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/vibe"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Constructors returns a fresh instance of every agent adapter the daemon
// ships, in a stable registration order. Adding a new harness means adding its
// constructor here (and a domain.AgentHarness constant) — the one edit the
// daemon picks up.
func Constructors() []adapters.Adapter {
	return []adapters.Adapter{
		claudecode.New(),
		codex.New(),
		opencode.New(),
		grok.New(),
		cursor.New(),
		qwen.New(),
		copilot.New(),
		kimi.New(),
		droid.New(),
		amp.New(),
		agy.New(),
		crush.New(),
		aider.New(),
		goose.New(),
		auggie.New(),
		continueagent.New(),
		devin.New(),
		cline.New(),
		kiro.New(),
		kilocode.New(),
		vibe.New(),
		pi.New(),
		autohand.New(),
		fake.New(),
	}
}

// Build returns a registry populated with the shipped agent adapters, keyed by
// manifest id. Registration only fails on an empty/duplicate id — a programmer
// error, not a runtime condition.
func Build() (*adapters.Registry, error) {
	reg := adapters.NewRegistry()
	for _, a := range Constructors() {
		if err := reg.Register(a); err != nil {
			return nil, fmt.Errorf("register agent adapter %q: %w", a.Manifest().ID, err)
		}
	}
	return reg, nil
}

// AllowedHarnessesEnv scopes a daemon to a subset of harnesses. The agent-host
// supervisor sets it when the daemon runs inside a per-harness cloud sandbox:
// a sandbox that hosts claude-code sessions must not be able to spawn — or
// even advertise in the catalog — any other harness, so a compromised or
// shared sandbox is bounded to the one credential it already holds.
// Comma-separated manifest ids; unset/empty = every shipped adapter (local
// behavior, byte-identical).
const AllowedHarnessesEnv = "AO_AGENT_HOST_HARNESSES"

// BuildAllowed returns a registry containing only the named harnesses. Names
// are manifest ids, trimmed, case-insensitive; an unknown or empty allowlist
// entry is an error — a misconfigured sandbox must fail fast, not silently
// host nothing.
func BuildAllowed(csv string) (*adapters.Registry, error) {
	want := map[string]bool{}
	for _, raw := range strings.Split(csv, ",") {
		name := strings.ToLower(strings.TrimSpace(raw))
		if name == "" {
			continue
		}
		want[name] = false
	}
	if len(want) == 0 {
		return Build()
	}
	reg := adapters.NewRegistry()
	for _, a := range Constructors() {
		id := a.Manifest().ID
		if _, ok := want[id]; !ok {
			continue
		}
		if err := reg.Register(a); err != nil {
			return nil, fmt.Errorf("register agent adapter %q: %w", id, err)
		}
		want[id] = true
	}
	for name, found := range want {
		if !found {
			return nil, fmt.Errorf("agent-host allowlist names unknown harness %q (%s)", name, AllowedHarnessesEnv)
		}
	}
	return reg, nil
}

// HarnessAgent pairs a session harness with the adapter that drives it. The
// harness is the adapter's manifest id, which is also the domain.AgentHarness
// value a session carries and the `--harness` flag users pass.
type HarnessAgent struct {
	Harness  domain.AgentHarness
	Manifest adapters.Manifest
	Agent    ports.Agent
}

// Harnessed returns every shipped adapter that drives an agent, paired with its
// harness, in Constructors() order. An adapter that does not implement
// ports.Agent is skipped.
func Harnessed() []HarnessAgent {
	cons := Constructors()
	out := make([]HarnessAgent, 0, len(cons))
	for _, a := range cons {
		agent, ok := a.(ports.Agent)
		if !ok {
			continue
		}
		out = append(out, HarnessAgent{
			Harness:  domain.AgentHarness(a.Manifest().ID),
			Manifest: a.Manifest(),
			Agent:    agent,
		})
	}
	return out
}

// HarnessedAllowed is Harnessed() filtered to an allowlist (see BuildAllowed).
// The agent catalog consumes it so a scoped agent-host never ADVERTISES a
// harness it cannot spawn — advertising invites the desktop default-selection
// to route work at a sandbox that would only reject it.
func HarnessedAllowed(csv string) ([]HarnessAgent, error) {
	scoped, err := BuildAllowed(csv)
	if err != nil {
		return nil, err
	}
	out := make([]HarnessAgent, 0)
	for _, h := range Harnessed() {
		if _, ok := scoped.Get(string(h.Harness)); ok {
			out = append(out, h)
		}
	}
	return out, nil
}
