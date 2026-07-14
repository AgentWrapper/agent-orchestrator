package domain_test

import (
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// The Spawnable contract (issue #298, decision D2).
//
// Validate() is a vocabulary check: it rejects values outside the typed
// vocabulary but never checks presence, so a config that provably cannot launch
// a session used to persist with a 201. Spawnable is the completeness gate.
//
// It is deliberately ROLE-SCOPED. Every live project carries an empty `prime`
// role, so an all-roles gate would reject all four configs on write and lock the
// config editor fleet-wide.

func TestSpawnableRequiresAHarnessForTheRole(t *testing.T) {
	t.Parallel()

	var empty domain.ProjectConfig
	err := empty.Spawnable(domain.KindWorker)
	if err == nil {
		t.Fatal("an empty config must not be spawnable: spawn fails with ErrMissingHarness")
	}
	if !strings.Contains(err.Error(), "worker.agent") {
		t.Fatalf("error must name the missing field, got %q", err)
	}

	if err := empty.Spawnable(domain.KindOrchestrator); err == nil {
		t.Fatal("an empty config must not be spawnable as an orchestrator")
	}
}

func TestSpawnableAcceptsAWorkerMixInPlaceOfAHarness(t *testing.T) {
	t.Parallel()

	// A non-empty mix assigns the harness before the ErrMissingHarness check, so
	// it satisfies the harness requirement on its own.
	cfg := domain.ProjectConfig{
		AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeBypassPermissions},
		WorkerMix: domain.WorkerMix{
			{Harness: domain.HarnessCodex, Weight: 100},
		},
	}
	if err := cfg.Spawnable(domain.KindWorker); err != nil {
		t.Fatalf("a worker mix satisfies the harness requirement, got %v", err)
	}
	// ...but only for the worker role. The orchestrator has no mix fallback.
	if err := cfg.Spawnable(domain.KindOrchestrator); err == nil {
		t.Fatal("workerMix must not satisfy the orchestrator's harness requirement")
	}
}

// The permission requirement is harness-conditional, and this asymmetry is the
// whole reason the original incident looked like a hang rather than an error:
// codex maps an empty mode to --dangerously-bypass-approvals-and-sandbox, but
// claude-code emits no --permission-mode flag at all and defers to
// ~/.claude/settings.json, where defaultMode is unset. So an unattended
// claude-code worker blocks on its first approval prompt.
func TestSpawnableRequiresPermissionsOnlyForClaudeHarnesses(t *testing.T) {
	t.Parallel()

	codexOnly := domain.ProjectConfig{
		Worker: domain.RoleOverride{Harness: domain.HarnessCodex},
	}
	if err := codexOnly.Spawnable(domain.KindWorker); err != nil {
		t.Fatalf("a codex worker is spawnable without an explicit permission mode, got %v", err)
	}

	claudeOnly := domain.ProjectConfig{
		Worker: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}
	err := claudeOnly.Spawnable(domain.KindWorker)
	if err == nil {
		t.Fatal("a claude-code worker with no permission mode deadlocks; it must not be spawnable")
	}
	if !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("error must name the missing field, got %q", err)
	}
}

func TestSpawnablePermissionsMayComeFromEitherTheBaseOrTheRole(t *testing.T) {
	t.Parallel()

	base := domain.ProjectConfig{
		AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeBypassPermissions},
		Worker:      domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}
	if err := base.Spawnable(domain.KindWorker); err != nil {
		t.Fatalf("base permissions satisfy the role, got %v", err)
	}

	// A role override wins over the base — including the empty->set direction.
	role := domain.ProjectConfig{
		Worker: domain.RoleOverride{
			Harness:     domain.HarnessClaudeCode,
			AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeAcceptEdits},
		},
	}
	if err := role.Spawnable(domain.KindWorker); err != nil {
		t.Fatalf("role permissions satisfy the role, got %v", err)
	}
}

// A mix that can select a claude harness needs permissions even when the
// worker's own harness is codex — the mix, not Worker.Harness, decides.
func TestSpawnableChecksEveryHarnessAWorkerMixCanSelect(t *testing.T) {
	t.Parallel()

	cfg := domain.ProjectConfig{
		Worker: domain.RoleOverride{Harness: domain.HarnessCodex},
		WorkerMix: domain.WorkerMix{
			{Harness: domain.HarnessCodex, Weight: 55},
			{Harness: domain.HarnessClaudeCode, Weight: 45},
		},
	}
	if err := cfg.Spawnable(domain.KindWorker); err == nil {
		t.Fatal("a mix that can select claude-code needs a permission mode")
	}

	cfg.AgentConfig.Permissions = domain.PermissionModeBypassPermissions
	if err := cfg.Spawnable(domain.KindWorker); err != nil {
		t.Fatalf("with permissions set the mix is spawnable, got %v", err)
	}
}

// ValidateSpawnable is the write gate. Prime is exempt unless the operator has
// actually configured it: every live project carries an empty prime role, and a
// blanket gate would reject all four configs on write.
func TestValidateSpawnableExemptsAnUnconfiguredPrimeRole(t *testing.T) {
	t.Parallel()

	live := domain.ProjectConfig{
		AgentConfig:  domain.AgentConfig{Permissions: domain.PermissionModeBypassPermissions},
		Worker:       domain.RoleOverride{Harness: domain.HarnessCodex},
		Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		// Prime left zero, exactly as all four live projects have it.
	}
	if err := live.ValidateSpawnable(); err != nil {
		t.Fatalf("an unconfigured prime role must not block a write, got %v", err)
	}

	// But a HALF-configured prime is a real misconfiguration and must be caught:
	// it would fail at spawn with ErrMissingHarness.
	half := live
	half.Prime = domain.RoleOverride{
		AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeBypassPermissions},
	}
	if err := half.ValidateSpawnable(); err == nil {
		t.Fatal("a configured-but-harnessless prime role must be rejected")
	}

	wakeBackoffOnly := live
	wakeBackoffOnly.Prime = domain.RoleOverride{
		WakeBackoff: &domain.WakeBackoffConfig{Base: "15m", Max: "1h"},
	}
	if err := wakeBackoffOnly.ValidateSpawnable(); err == nil {
		t.Fatal("a prime role with only wakeBackoff is configured and must be rejected without a harness")
	}
}

func TestValidateSpawnableRejectsAConfigThatCannotLaunchAnything(t *testing.T) {
	t.Parallel()

	// The agent-vault config that started this: prefix set, everything else empty.
	vault := domain.ProjectConfig{ProjectPrefix: "av"}
	if err := vault.ValidateSpawnable(); err == nil {
		t.Fatal("the config that deadlocked agent-vault must be rejected on write")
	}
}
