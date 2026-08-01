// Package kimi contains AO's staged Kimi Code CLI reviewer adapter.
//
// Kimi can provide AO's visible, long-lived interactive reviewer experience,
// but its TUI also exposes a direct host shell, an external editor, and a live
// Plan-mode toggle. AO cannot currently contain those terminal-user surfaces,
// so the production path fails closed before runtime creation. The contained
// launch model remains here to make the eventual isolation requirements
// explicit and to prevent a non-interactive fallback from being introduced.
package kimi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	agentkimi "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/kimi"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const HarnessID domain.ReviewerHarness = "kimi"

var (
	requiredFlags = []string{"--config", "--plan", "--skills-dir", "--add-dir"}
	safeID        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

	// ErrIsolationUnavailable prevents Kimi from reaching a reviewer pane until
	// AO can enforce replacement environments and block or sandbox TUI escapes.
	ErrIsolationUnavailable = errors.New("kimi reviewer is disabled: AO lacks Kimi process and input containment, a model broker, and review-gateway transport")
)

// Reviewer describes Kimi's interactive lifecycle without enabling an unsafe
// production launch. Function fields make compatibility probing testable
// without requiring an installed or authenticated Kimi CLI.
type Reviewer struct {
	dataDir       string
	resolveBinary func(context.Context) (string, error)
	run           func(context.Context, string, ...string) ([]byte, error)
}

// New returns the staged Kimi reviewer adapter. It is deliberately absent from
// the production registry while ErrIsolationUnavailable remains in force.
func New(dataDir string) *Reviewer {
	return &Reviewer{
		dataDir:       dataDir,
		resolveBinary: agentkimi.ResolveKimiBinary,
		run: func(ctx context.Context, binary string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, binary, args...).CombinedOutput()
		},
	}
}

// Harness identifies the staged adapter without widening the configurable
// reviewer vocabulary.
func (*Reviewer) Harness() domain.ReviewerHarness { return HarnessID }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand always fails before binary resolution or runtime creation.
// Kimi's -p/--prompt and --print modes are intentionally not used as a bypass:
// every eventual Kimi reviewer must remain a persistent interactive TUI.
func (*Reviewer) ReviewCommand(ctx context.Context, _ ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	return ports.ReviewCommandSpec{}, ErrIsolationUnavailable
}

// ReviewPreflight verifies that the installed CLI has the interactive
// isolation-oriented flags modeled below, then reports the missing AO runtime
// boundary. It never installs Kimi or starts a session.
func (r *Reviewer) ReviewPreflight(ctx context.Context, _ string) error {
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return err
	}
	help, err := r.run(ctx, binary, "--help")
	if err != nil {
		return fmt.Errorf("run kimi --help: %w", err)
	}
	for _, flag := range requiredFlags {
		if !strings.Contains(string(help), flag) {
			return fmt.Errorf("installed Kimi is incompatible: required flag %s is unavailable", flag)
		}
	}
	return ErrIsolationUnavailable
}

// ReviewMessage injects only AO's short task-file reference into the existing
// TUI for later review passes.
func (*Reviewer) ReviewMessage(ctx context.Context, inv ports.ReviewInvocation) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return inv.Prompt, nil
}

// ReviewCancel uses Kimi's documented one-Ctrl-C active-operation interrupt.
// A single interrupt preserves an idle pane because exiting requires a second
// confirmation; Escape only dismisses panels and is not the stream canceller.
func (*Reviewer) ReviewCancel(ctx context.Context) (ports.ReviewCancelSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCancelSpec{}, err
	}
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 1}, nil
}

// stagedCommandSpec records requirements the current runtime contract cannot
// enforce. It must not be returned from ReviewCommand until every field is a
// mandatory runtime boundary rather than adapter documentation.
type stagedCommandSpec struct {
	Command                ports.ReviewCommandSpec
	EnvironmentReplacement bool
	BlockedInput           []string
	UncontainedRisks       []string
}

// containedInteractiveSpec models the only future Kimi launch AO may enable.
// It starts the regular TUI in Plan mode from a neutral directory, replaces
// resource-discovery roots, exposes only explicit read roots, and injects the
// first task after startup. Prompt and print flags are never emitted.
func (r *Reviewer) containedInteractiveSpec(ctx context.Context, inv ports.ReviewInvocation) (stagedCommandSpec, error) {
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return stagedCommandSpec{}, err
	}
	if !filepath.IsAbs(binary) {
		return stagedCommandSpec{}, errors.New("kimi reviewer: resolved binary must be absolute")
	}
	workingDir, skillsDir, env, err := r.prepareNeutralEnvironment(inv.ReviewerID)
	if err != nil {
		return stagedCommandSpec{}, err
	}
	argv := []string{binary, "--plan", "--skills-dir", skillsDir}
	if strings.TrimSpace(inv.WorkspacePath) != "" {
		argv = append(argv, "--add-dir", inv.WorkspacePath)
	}
	if strings.TrimSpace(inv.TaskPromptRoot) != "" {
		argv = append(argv, "--add-dir", inv.TaskPromptRoot)
	}
	return stagedCommandSpec{
		Command: ports.ReviewCommandSpec{
			Argv:             argv,
			Env:              env,
			InitialMessage:   inv.Prompt,
			WorkingDirectory: workingDir,
		},
		EnvironmentReplacement: true,
		BlockedInput: []string{
			"\x18", // Ctrl-X toggles the direct shell in current Kimi releases.
			"\x0f", // Ctrl-O launches an external editor.
		},
		UncontainedRisks: []string{
			"terminal shell mode",
			"external editor",
			"plan-mode toggle",
			"slash-command configuration mutation",
		},
	}, nil
}

func (r *Reviewer) prepareNeutralEnvironment(reviewerID string) (string, string, map[string]string, error) {
	if strings.TrimSpace(r.dataDir) == "" || !filepath.IsAbs(r.dataDir) {
		return "", "", nil, errors.New("kimi reviewer: absolute AO data directory is required")
	}
	if !safeID.MatchString(reviewerID) {
		return "", "", nil, errors.New("kimi reviewer: invalid reviewer id")
	}
	root := filepath.Join(r.dataDir, "reviewer-runtime", reviewerID, "kimi")
	workingDir := filepath.Join(root, "workspace")
	kimiHome := filepath.Join(root, "kimi-home")
	skillsDir := filepath.Join(root, "empty-skills")
	configRoot := filepath.Join(root, "config")
	stateRoot := filepath.Join(root, "state")
	cacheRoot := filepath.Join(root, "cache")
	tempRoot := filepath.Join(root, "tmp")
	for _, dir := range []string{root, workingDir, kimiHome, skillsDir, configRoot, stateRoot, cacheRoot, tempRoot} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return "", "", nil, fmt.Errorf("kimi reviewer: create neutral directory: %w", err)
		}
	}
	env := map[string]string{
		"HOME":            root,
		"KIMI_CODE_HOME":  kimiHome,
		"XDG_CONFIG_HOME": configRoot,
		"XDG_STATE_HOME":  stateRoot,
		"XDG_CACHE_HOME":  cacheRoot,
		"TMPDIR":          tempRoot,
		"TEMP":            tempRoot,
		"TMP":             tempRoot,
		"PATH":            "/usr/local/bin:/usr/bin:/bin",
	}
	return workingDir, skillsDir, env, nil
}
