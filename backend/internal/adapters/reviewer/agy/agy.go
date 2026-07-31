// Package agy defines the fail-closed Antigravity CLI reviewer adapter.
//
// Agy can preserve AO's long-lived interactive TUI contract, but AO does not
// yet have the process sandbox and structured gateway transport required to
// expose it safely. The adapter is deliberately not registered. Its production
// preflight and launch paths return ErrIsolationUnavailable until those shared
// prerequisites exist on tmux and ConPTY platforms.
package agy

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	agentagy "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// HarnessID is intentionally package-local vocabulary rather than a domain
	// reviewer constant: Agy must remain invalid in project configuration until
	// the isolation prerequisite is implemented.
	HarnessID      domain.ReviewerHarness = "agy"
	minimumVersion                        = "1.1.6"
)

var requiredFlags = []string{"--agent", "--conversation", "--prompt-interactive", "--sandbox"}

// ErrIsolationUnavailable prevents an Agy reviewer from being launched with a
// misleading read-only promise. A neutral cwd and HOME hide common discovery
// paths but are not a process sandbox and cannot contain built-in tools.
var ErrIsolationUnavailable = errors.New("agy reviewer is disabled: AO has no fail-closed cross-platform TUI sandbox or Agy-to-review-gateway transport")

// Reviewer describes Agy's TUI lifecycle while failing closed at the missing
// security boundary. Function fields make compatibility behavior unit-testable
// without installing or authenticating Agy in tests.
type Reviewer struct {
	resolveBinary      func(context.Context) (string, error)
	run                func(context.Context, string, ...string) ([]byte, error)
	isolationPreflight func(context.Context) error
}

// New returns the staged production adapter. It is not added to the reviewer
// registry until isolationPreflight has a real platform implementation.
func New() *Reviewer {
	return &Reviewer{
		resolveBinary: agentagy.ResolveAgyBinary,
		run: func(ctx context.Context, binary string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, binary, args...).CombinedOutput()
		},
		isolationPreflight: func(context.Context) error { return ErrIsolationUnavailable },
	}
}

// Harness identifies the staged adapter without making it a supported domain
// reviewer harness.
func (*Reviewer) Harness() domain.ReviewerHarness { return HarnessID }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand returns only the executable for the launcher's generic binary
// preflight. A real invocation fails before constructing runtime argv because
// WorkingDirectory and environment overrides alone do not contain Agy.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	if strings.TrimSpace(inv.TaskPromptRoot) == "" {
		return ports.ReviewCommandSpec{Argv: []string{binary}}, nil
	}
	if err := r.isolationPreflight(ctx); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	// Keep this fail-closed even if a caller injects a successful isolation
	// probe: the gateway currently has no Agy-consumable IPC transport.
	return ports.ReviewCommandSpec{}, ErrIsolationUnavailable
}

// ReviewPreflight verifies the minimum CLI surface before reporting the shared
// isolation blocker. Markdown custom main agents landed in Agy 1.1.6.
func (r *Reviewer) ReviewPreflight(ctx context.Context, _ string) error {
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return err
	}
	help, err := r.run(ctx, binary, "--help")
	if err != nil {
		return fmt.Errorf("run agy --help: %w", err)
	}
	for _, flag := range requiredFlags {
		if !strings.Contains(string(help), flag) {
			return fmt.Errorf("installed Agy is incompatible: required flag %s is unavailable", flag)
		}
	}
	version, err := r.run(ctx, binary, "--version")
	if err != nil {
		return fmt.Errorf("run agy --version: %w", err)
	}
	if !versionAtLeast(strings.TrimSpace(string(version)), minimumVersion) {
		return fmt.Errorf("installed Agy %q is incompatible: version %s or newer is required", strings.TrimSpace(string(version)), minimumVersion)
	}
	return r.isolationPreflight(ctx)
}

// ReviewMessage returns the short AO-owned task-file reference for a future
// long-lived TUI. The full instructions remain outside terminal scrollback.
func (*Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

// ReviewCancel matches Agy's fixed TUI behavior: the first Ctrl-C interrupts
// the active operation, while a second Ctrl-C begins the exit flow.
func (*Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 1}, nil
}

// interactiveArgv pins the only launch shape an enabled adapter may use. It is
// kept separate so tests can guard against accidental print/headless flags while
// the production path remains disabled.
func interactiveArgv(binary, agentName, prompt string) []string {
	return []string{binary, "--agent", agentName, "--sandbox", "--prompt-interactive", prompt}
}

func versionAtLeast(got, minimum string) bool {
	parse := func(value string) ([3]int, bool) {
		var result [3]int
		parts := strings.Split(strings.TrimPrefix(value, "v"), ".")
		if len(parts) < 3 {
			return result, false
		}
		for i := range result {
			n, err := strconv.Atoi(parts[i])
			if err != nil {
				return result, false
			}
			result[i] = n
		}
		return result, true
	}
	a, okA := parse(got)
	b, okB := parse(minimum)
	if !okA || !okB {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return true
}
