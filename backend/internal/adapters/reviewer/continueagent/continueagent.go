// Package continueagent defines the staged Continue CLI reviewer adapter.
//
// Continue is an interactive TUI with several paths to host authority even in
// readonly mode. AO does not yet have the containment and capability gateway
// needed to run it as a reviewer, so this adapter deliberately fails closed and
// is not registered. The contained launch description is retained here so the
// eventual enablement cannot drift into a less restrictive command shape.
package continueagent

import (
	"context"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// HarnessID stays outside the domain reviewer vocabulary until the adapter
	// can actually be isolated on every supported runtime.
	HarnessID domain.ReviewerHarness = "continue"

	packageName      = "@continuedev/cli"
	packageVersion   = "1.5.47"
	packageIntegrity = "sha512-gtpewV3RoIOD9dyTtKIBi1SY0VOHRu3Ehe7C/mmnswm+j34MPyrcQhQaWj/m+jdfGO4fNIKdrgGIlLso1ULDFw=="

	configPath       = "/ao/config/continue/config.yaml"
	neutralDirectory = "/ao/empty"
)

// ErrIsolationUnavailable is returned before binary resolution, config
// generation, or runtime creation. Continue's readonly mode is a permission
// preference, not an OS security boundary.
var ErrIsolationUnavailable = errors.New("continue reviewer isolation-unavailable: AO has no reviewer containment, capability broker, or Continue gateway")

// Reviewer is staged only. Do not add it to the domain vocabulary or registry
// until ReviewCommand can hand a mandatory isolation profile to the runtime.
type Reviewer struct{}

// New returns the fail-closed staged adapter.
func New() *Reviewer { return &Reviewer{} }

// Harness identifies the staged adapter without making it configurable.
func (*Reviewer) Harness() domain.ReviewerHarness { return HarnessID }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand always fails before the runtime can start Continue. The
// adapter-local containedCommand documents the only future launch contract,
// but the current ports cannot require environment replacement or containment.
func (*Reviewer) ReviewCommand(ctx context.Context, _ ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	return ports.ReviewCommandSpec{}, ErrIsolationUnavailable
}

// ReviewPreflight reports the same blocker without probing or installing the
// npm package. This keeps preflight fail-closed and side-effect free.
func (*Reviewer) ReviewPreflight(ctx context.Context, _ string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrIsolationUnavailable
}

// ReviewMessage reuses AO's opaque task reference in the already-running TUI.
// It neither grants new authority through environment nor restores a prior
// Continue session.
func (*Reviewer) ReviewMessage(ctx context.Context, inv ports.ReviewInvocation) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return inv.Prompt, nil
}

// ReviewCancel sends exactly one Escape, Continue's active-turn cancellation
// key, while preserving the live pane for a later ReviewMessage.
func (*Reviewer) ReviewCancel(ctx context.Context) (ports.ReviewCancelSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCancelSpec{}, err
	}
	return ports.ReviewCancelSpec{
		Mode:       ports.ReviewCancelEscape,
		Interrupts: 1,
		Input:      "\x1b",
	}, nil
}

// containedLaunch is adapter-local because the current runtime contract has no
// enforceable environment-replacement or containment fields. Returning its
// ReviewCommandSpec from production would therefore be unsafe.
type containedLaunch struct {
	Command              ports.ReviewCommandSpec
	ReplaceEnvironment   bool
	PostReadinessMessage string
	RestoreSupported     bool
}

// containedCommand fixes the future TUI argv, neutral cwd, replacement env,
// and post-readiness task delivery. No prompt or restore token is placed in
// argv. The container image will provide the audited npm artifact above.
func containedCommand(inv ports.ReviewInvocation) containedLaunch {
	return containedLaunch{
		Command: ports.ReviewCommandSpec{
			Argv:             []string{"cn", "--config", configPath, "--readonly"},
			Env:              replacementEnvironment(),
			WorkingDirectory: neutralDirectory,
		},
		ReplaceEnvironment:   true,
		PostReadinessMessage: inv.Prompt,
		RestoreSupported:     false,
	}
}

func replacementEnvironment() map[string]string {
	return map[string]string{
		"HOME":                          "/ao/home",
		"XDG_CONFIG_HOME":               "/ao/config",
		"XDG_STATE_HOME":                "/ao/state",
		"XDG_CACHE_HOME":                "/ao/cache",
		"TMPDIR":                        "/ao/tmp",
		"TMP":                           "/ao/tmp",
		"TEMP":                          "/ao/tmp",
		"PATH":                          "/usr/local/bin:/usr/bin:/bin",
		"CONTINUE_CLI_ENABLE_TELEMETRY": "0",
	}
}
