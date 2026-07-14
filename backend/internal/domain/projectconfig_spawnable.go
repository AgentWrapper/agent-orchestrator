package domain

import "fmt"

// Spawnable reports whether a session of the given kind could actually launch
// with this config. It is the completeness gate that Validate deliberately is
// not: Validate checks that the values you DID set are known values, and
// explicitly permits empty, so a config that provably cannot launch a session
// used to persist with a 201.
//
// The gate is exactly two requirements, both derived from the spawn path:
//
//  1. The role must resolve to a harness. Spawn fails with ErrMissingHarness
//     otherwise. A non-empty WorkerMix satisfies this for the worker role, since
//     mix selection assigns the harness before that check.
//
//  2. The role must have a permission mode WHEN any harness it can resolve to is
//     a Claude-provider harness. This asymmetry is real, not defensive: the codex
//     adapter maps an empty mode onto an explicit bypass flag, but the claude-code
//     adapter emits no --permission-mode flag at all and defers to the user's
//     ~/.claude/settings.json. With no defaultMode there, an unattended claude-code
//     worker blocks on its first approval prompt — a hang, not an error, which is
//     exactly how this failure presented.
//
// An explicit PermissionModeDefault is accepted. It is equally capable of
// prompting, but it is a deliberate operator choice rather than an omission, and
// Spawnable gates omissions.
//
// Everything else a project can configure degrades to a working default and is
// therefore out of scope here.
func (c ProjectConfig) Spawnable(kind SessionKind) error {
	role := roleName(kind)
	harnesses := c.resolvableHarnesses(kind)
	if len(harnesses) == 0 {
		return fmt.Errorf("%s.agent: required — a session cannot spawn without a harness", role)
	}
	if !c.permissionsSetFor(kind) {
		for _, h := range harnesses {
			if h.ModelProvider() == ProviderAnthropic {
				return fmt.Errorf(
					"%s.agentConfig.permissions: required for %s — without it the agent starts in interactive mode and blocks on its first approval prompt",
					role, h,
				)
			}
		}
	}
	return nil
}

// ValidateSpawnable is the write gate: it refuses to persist a config that
// cannot launch the sessions the daemon will actually try to launch.
//
// It is role-scoped on purpose. Worker and orchestrator are always gated — the
// daemon spawns both unprompted. Prime is gated ONLY when the operator has
// configured it, because every live project carries an empty prime role and a
// blanket gate would reject all four configs on write, locking the config editor
// fleet-wide. An empty prime role is "prime is not in use"; a half-configured one
// is a misconfiguration that would fail at spawn, so it is caught.
func (c ProjectConfig) ValidateSpawnable() error {
	if err := c.Spawnable(KindWorker); err != nil {
		return err
	}
	if err := c.Spawnable(KindOrchestrator); err != nil {
		return err
	}
	if !c.Prime.IsZero() {
		if err := c.Spawnable(KindPrime); err != nil {
			return err
		}
	}
	return nil
}

// resolvableHarnesses lists every harness a spawn of this kind could select. For
// a worker with a mix that is every bucket in the mix — the mix, not
// Worker.Harness, decides — so a mix that can select a Claude harness carries the
// Claude permission requirement even when Worker.Harness is codex.
func (c ProjectConfig) resolvableHarnesses(kind SessionKind) []AgentHarness {
	if kind == KindWorker && len(c.WorkerMix) > 0 {
		out := make([]AgentHarness, 0, len(c.WorkerMix))
		for _, e := range c.WorkerMix {
			if e.Harness != "" {
				out = append(out, e.Harness)
			}
		}
		return out
	}
	if h := c.roleOverride(kind).Harness; h != "" {
		return []AgentHarness{h}
	}
	return nil
}

// permissionsSetFor mirrors the spawn-time precedence in agentconfig.Resolve: the
// role's own permission mode wins, else the project-wide one.
func (c ProjectConfig) permissionsSetFor(kind SessionKind) bool {
	if c.roleOverride(kind).AgentConfig.Permissions != "" {
		return true
	}
	return c.AgentConfig.Permissions != ""
}

func (c ProjectConfig) roleOverride(kind SessionKind) RoleOverride {
	switch kind {
	case KindWorker:
		return c.Worker
	case KindOrchestrator:
		return c.Orchestrator
	case KindPrime:
		return c.Prime
	default:
		return RoleOverride{}
	}
}

func roleName(kind SessionKind) string {
	switch kind {
	case KindOrchestrator:
		return "orchestrator"
	case KindPrime:
		return "prime"
	default:
		return "worker"
	}
}

// IsZero reports whether the role carries no configuration at all, i.e. the role
// is not in use. ValidateSpawnable uses it to exempt an unconfigured prime.
func (r RoleOverride) IsZero() bool {
	return r.Harness == "" &&
		r.Workspace == "" &&
		r.WakeInterval == "" &&
		r.WakeBackoff == nil &&
		r.InstructionsFile == "" &&
		r.AgentConfig.IsZero()
}
