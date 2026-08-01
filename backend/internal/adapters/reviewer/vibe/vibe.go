// Package vibe contains the staged Mistral Vibe reviewer adapter.
//
// Vibe 2.17.1 can preserve AO's long-lived interactive reviewer UX, but its
// TUI also exposes a direct shell, an external-editor shortcut, and live agent
// switching. AO does not yet have the process/input containment, model broker,
// or review-gateway MCP transport required to expose those surfaces safely.
// The adapter therefore models the eventual contained launch exactly while
// failing closed before production runtime creation. It is not registered.
package vibe

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	agentvibe "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/vibe"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// HarnessID stays package-local so Vibe cannot be selected in project
	// configuration before all of its containment prerequisites are present.
	HarnessID     domain.ReviewerHarness = "vibe"
	pinnedVersion string                 = "2.17.1"
	reviewerAgent string                 = "plan"
)

var (
	requiredFlags               = []string{"--agent", "--workdir", "--trust"}
	safeID                      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	uncontainedInteractiveRisks = []string{
		"terminal shell escape",
		"external editor",
		"approval-mode toggle",
		"layered config discovery",
	}

	// ErrIsolationUnavailable is returned before runtime creation. A neutral
	// cwd, plan agent, and clean config reduce discovery, but none is an OS
	// boundary for Vibe's user shell or external editor.
	ErrIsolationUnavailable = errors.New("vibe reviewer is disabled: AO lacks Vibe process and input containment, replacement runtime environment, model broker, and review-gateway MCP transport")
)

// stagedCommandSpec records requirements the current runtime contract cannot
// yet express. It must not cross the production Reviewer boundary until the
// launcher can enforce every field rather than treating Env as an overlay.
type stagedCommandSpec struct {
	Command                ports.ReviewCommandSpec
	EnvironmentReplacement bool
	BlockedInput           []string
	UncontainedRisks       []string
}

// Reviewer describes Vibe's future interactive lifecycle while keeping its
// production path disabled. Function fields keep compatibility tests local and
// independent of an installed or authenticated Vibe binary.
type Reviewer struct {
	dataDir            string
	resolveBinary      func(context.Context) (string, error)
	run                func(context.Context, string, ...string) ([]byte, error)
	isolationPreflight func(context.Context) error
}

// New returns the staged adapter. Registration remains deliberately absent.
func New(dataDir string) *Reviewer {
	return &Reviewer{
		dataDir:       dataDir,
		resolveBinary: agentvibe.ResolveVibeBinary,
		run: func(ctx context.Context, binary string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, binary, args...).CombinedOutput()
		},
		isolationPreflight: func(context.Context) error { return ErrIsolationUnavailable },
	}
}

// Harness identifies the staged adapter without enabling it in the domain.
func (*Reviewer) Harness() domain.ReviewerHarness { return HarnessID }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand always fails before resolving a binary or constructing runtime
// state. Compatibility probing belongs exclusively to ReviewPreflight; no
// invocation shape may bypass the disabled production boundary.
func (*Reviewer) ReviewCommand(ctx context.Context, _ ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	return ports.ReviewCommandSpec{}, ErrIsolationUnavailable
}

// ReviewPreflight pins the only upstream release whose interactive and config
// surfaces this staged adapter models, then reports the production blocker.
func (r *Reviewer) ReviewPreflight(ctx context.Context, _ string) error {
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return err
	}
	version, err := r.run(ctx, binary, "--version")
	if err != nil {
		return fmt.Errorf("run vibe --version: %w", err)
	}
	if !isPinnedVersion(string(version)) {
		return fmt.Errorf("installed Vibe %q is incompatible: exactly version %s is required", strings.TrimSpace(string(version)), pinnedVersion)
	}
	help, err := r.run(ctx, binary, "--help")
	if err != nil {
		return fmt.Errorf("run vibe --help: %w", err)
	}
	for _, flag := range requiredFlags {
		if !strings.Contains(string(help), flag) {
			return fmt.Errorf("installed Vibe %s is incompatible: required flag %s is unavailable", pinnedVersion, flag)
		}
	}
	return r.isolationPreflight(ctx)
}

// ReviewMessage reuses the live TUI and injects only AO's opaque task
// reference; the task body never enters argv or inherited process state.
func (*Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

// ReviewCancel uses Vibe 2.17.1's native one-Escape interrupt binding.
func (*Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelEscape, Interrupts: 1, Input: "\x1b"}, nil
}

// containedInteractiveSpec models the only future launch shape AO may use.
// The initial task is deliberately delivered through InitialMessage after the
// TUI is ready, never as Vibe's positional prompt or programmatic -p input.
func (r *Reviewer) containedInteractiveSpec(ctx context.Context, inv ports.ReviewInvocation) (stagedCommandSpec, error) {
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return stagedCommandSpec{}, err
	}
	if !filepath.IsAbs(binary) {
		return stagedCommandSpec{}, errors.New("vibe reviewer: resolved binary must be absolute")
	}
	workingDir, env, err := r.prepareNeutralEnvironment(inv.ReviewerID)
	if err != nil {
		return stagedCommandSpec{}, err
	}
	return stagedCommandSpec{
		Command: ports.ReviewCommandSpec{
			Argv:             []string{binary, "--trust", "--workdir", workingDir, "--agent", reviewerAgent},
			Env:              env,
			InitialMessage:   inv.Prompt,
			WorkingDirectory: workingDir,
		},
		EnvironmentReplacement: true,
		// Ctrl+G launches $VISUAL/$EDITOR (or a platform fallback) outside
		// Vibe's tool permissions. The future runtime must swallow it.
		BlockedInput:     []string{"\x07"},
		UncontainedRisks: append([]string(nil), uncontainedInteractiveRisks...),
	}, nil
}

func (r *Reviewer) prepareNeutralEnvironment(reviewerID string) (string, map[string]string, error) {
	if strings.TrimSpace(r.dataDir) == "" || !filepath.IsAbs(r.dataDir) {
		return "", nil, errors.New("vibe reviewer: absolute AO data directory is required")
	}
	if !safeID.MatchString(reviewerID) {
		return "", nil, errors.New("vibe reviewer: invalid reviewer id")
	}
	root := filepath.Join(r.dataDir, "reviewer-runtime", reviewerID, "vibe")
	workingDir := filepath.Join(root, "workspace")
	vibeHome := filepath.Join(root, "home")
	configRoot := filepath.Join(root, "config")
	stateRoot := filepath.Join(root, "state")
	cacheRoot := filepath.Join(root, "cache")
	tempRoot := filepath.Join(root, "tmp")
	for _, dir := range []string{root, workingDir, vibeHome, configRoot, stateRoot, cacheRoot, tempRoot} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return "", nil, fmt.Errorf("vibe reviewer: create neutral directory: %w", err)
		}
	}
	// Lock the TUI to plan so Shift+Tab cannot reach accept-edits or
	// auto-approve. Restrict built-ins to read-only local tools; the eventual
	// review operations must be supplied by the still-missing gateway MCP.
	config := strings.Join([]string{
		`default_agent = "plan"`,
		`enabled_agents = ["plan"]`,
		`enabled_tools = ["grep", "read"]`,
		`disabled_skills = ["*"]`,
		`mcp_servers = []`,
		`enable_auto_update = false`,
		`enable_telemetry = false`,
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(vibeHome, "config.toml"), []byte(config), 0o600); err != nil {
		return "", nil, fmt.Errorf("vibe reviewer: write neutral config: %w", err)
	}
	env := map[string]string{
		"HOME":            root,
		"VIBE_HOME":       vibeHome,
		"XDG_CONFIG_HOME": configRoot,
		"XDG_STATE_HOME":  stateRoot,
		"XDG_CACHE_HOME":  cacheRoot,
		"TMPDIR":          tempRoot,
		"TEMP":            tempRoot,
		"TMP":             tempRoot,
	}
	return workingDir, env, nil
}

func isPinnedVersion(output string) bool {
	return strings.TrimSpace(output) == "vibe "+pinnedVersion
}
