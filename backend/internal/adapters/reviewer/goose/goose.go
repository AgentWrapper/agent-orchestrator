// Package goose defines the staged, fail-closed Goose reviewer adapter.
//
// Goose can provide AO's visible, long-lived reviewer TUI, but its security
// contract requires an OCI supervisor, a model broker, and the AO review
// gateway MCP shim. None of those launch prerequisites exist yet, so this
// package is deliberately absent from the reviewer domain and registry and
// every production launch returns ErrIsolationUnavailable.
package goose

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// HarnessID remains adapter-local until the isolation boundary ships.
	HarnessID domain.ReviewerHarness = "goose"

	pinnedVersion     = "1.38.0"
	gooseBinary       = "/opt/ao/bin/goose"
	gatewayMCPBinary  = "/opt/ao/bin/ao-review-gateway-mcp"
	containedRoot     = "/opt/ao/reviewer"
	neutralWorkingDir = containedRoot + "/work"
	isolatedHome      = containedRoot + "/home"
	isolatedGooseRoot = containedRoot + "/goose"
	isolatedTemp      = containedRoot + "/tmp"
	systemPromptPath  = containedRoot + "/prompts/system.md"
	modelBrokerHost   = "http://ao-review-model-broker/v1"

	// This is the SHA-256 of the exact stdout emitted by the official Goose
	// 1.38.0 binary for `goose session --help`. Version equality alone is not
	// enough: a rebuilt binary with changed flags or semantics must fail closed.
	pinnedSessionHelpSHA256 = "7da45db07c6fd73d17f7cf4d6267f345ece2c033bb6a212fd54dd6738d9fbbf2"
)

// ErrIsolationUnavailable prevents the adapter from reaching runtime.Create.
// Environment overrides on the current runtime are additive, whereas Goose
// requires an OCI-enforced replacement environment and broker-only network.
var ErrIsolationUnavailable = errors.New("goose reviewer is disabled: AO has no OCI reviewer supervisor, model broker, or review gateway MCP shim")

// Reviewer records Goose's pinned compatibility and TUI lifecycle contracts.
// The injected runner keeps preflight tests independent of a Goose install.
type Reviewer struct {
	run func(context.Context, string, ...string) ([]byte, error)
}

// New returns the staged production adapter. It is intentionally unregistered.
func New() *Reviewer {
	return &Reviewer{run: func(ctx context.Context, binary string, args ...string) ([]byte, error) {
		return exec.CommandContext(ctx, binary, args...).CombinedOutput()
	}}
}

// Harness identifies the staged adapter without enabling it in project config.
func (*Reviewer) Harness() domain.ReviewerHarness { return HarnessID }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand always fails before a reviewer runtime can be created. The
// future contained command is modeled separately because ReviewCommandSpec.Env
// currently augments the host environment and therefore cannot express the
// required replacement-environment boundary.
func (*Reviewer) ReviewCommand(ctx context.Context, _ ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	return ports.ReviewCommandSpec{}, ErrIsolationUnavailable
}

// ReviewPreflight accepts only the official Goose 1.38.0 CLI and its exact
// session help contract, then reports the missing isolation prerequisites.
func (r *Reviewer) ReviewPreflight(ctx context.Context, _ string) error {
	version, err := r.run(ctx, gooseBinary, "--version")
	if err != nil {
		return fmt.Errorf("run goose --version: %w", err)
	}
	if got := strings.TrimSpace(string(version)); got != pinnedVersion {
		return fmt.Errorf("installed Goose %q is incompatible: exactly version %s is required", got, pinnedVersion)
	}

	help, err := r.run(ctx, gooseBinary, "session", "--help")
	if err != nil {
		return fmt.Errorf("run goose session --help: %w", err)
	}
	if got := fmt.Sprintf("%x", sha256.Sum256(help)); got != pinnedSessionHelpSHA256 {
		return fmt.Errorf("installed Goose %s is incompatible: session help contract drifted (sha256 %s)", pinnedVersion, got)
	}
	return ErrIsolationUnavailable
}

// ReviewMessage keeps subsequent reviews in the already-running TUI. AO's
// launcher supplies only a short reference to an immutable task file here.
func (*Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

// ReviewCancel sends exactly one Ctrl-C. Goose treats it as cancellation of an
// active turn; AO must not send a second interrupt that could exit the TUI.
func (*Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 1}, nil
}

// containedProcessSpec is the future OCI supervisor contract. Environment is
// the complete child environment, not values to merge into os.Environ.
type containedProcessSpec struct {
	Argv                 []string
	Environment          []string
	WorkingDirectory     string
	ReadOnlyFiles        []string
	InitialMessage       string
	InjectAfterReadiness bool
}

// containedCommand models the sole launch shape an eventual OCI supervisor may
// accept. It has no resume form: a dead Goose reviewer starts a new session.
func containedCommand(initialMessage string) containedProcessSpec {
	return containedProcessSpec{
		Argv: []string{
			gooseBinary,
			"session",
			"--no-profile",
			"--with-extension", gatewayMCPBinary,
		},
		Environment: []string{
			"CONTEXT_FILE_NAMES=[]",
			"GOOSE_DISABLE_KEYRING=1",
			"GOOSE_DISABLE_SESSION_NAMING=true",
			"GOOSE_MODEL=ao-reviewer",
			"GOOSE_MODE=auto",
			"GOOSE_PATH_ROOT=" + isolatedGooseRoot,
			"GOOSE_PROVIDER=openai",
			"GOOSE_SYSTEM_PROMPT_FILE_PATH=" + systemPromptPath,
			"GOOSE_TELEMETRY_OFF=1",
			"HOME=" + isolatedHome,
			"OPENAI_BASE_URL=" + modelBrokerHost,
			"PATH=/opt/ao/bin:/usr/bin:/bin",
			"TERM=xterm-256color",
			"TMPDIR=" + isolatedTemp,
		},
		WorkingDirectory:     neutralWorkingDir,
		ReadOnlyFiles:        []string{systemPromptPath},
		InitialMessage:       initialMessage,
		InjectAfterReadiness: true,
	}
}
