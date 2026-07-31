// Package pi implements the interactive Pi code-review adapter.
package pi

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	agentpi "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/pi"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const extensionFilename = "ao-pi-reviewer.ts"

var requiredFlags = []string{
	"--no-builtin-tools",
	"--tools",
	"--extension",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--no-approve",
	"--session-dir",
}

//go:embed assets/ao-pi-reviewer.ts
var extensionSource []byte

// Reviewer launches Pi's live TUI with only AO's structured review tools.
type Reviewer struct {
	resolveBinary func(context.Context) (string, error)
	runHelp       func(context.Context, string) ([]byte, error)
}

// New returns the production Pi reviewer adapter.
func New() *Reviewer {
	return &Reviewer{
		resolveBinary: agentpi.ResolvePiBinary,
		runHelp: func(ctx context.Context, binary string) ([]byte, error) {
			return exec.CommandContext(ctx, binary, "--help").CombinedOutput()
		},
	}
}

// Harness identifies Pi in the reviewer registry.
func (*Reviewer) Harness() domain.ReviewerHarness { return domain.ReviewerPi }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewPreflight refuses Pi versions missing the resource-isolation flags on
// which the reviewer security boundary depends.
func (r *Reviewer) ReviewPreflight(ctx context.Context, _ string) error {
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return err
	}
	out, err := r.runHelp(ctx, binary)
	if err != nil {
		return fmt.Errorf("run pi --help: %w", err)
	}
	help := string(out)
	for _, flag := range requiredFlags {
		if !strings.Contains(help, flag) {
			return fmt.Errorf("installed Pi is incompatible: required flag %s is unavailable", flag)
		}
	}
	return nil
}

// ReviewCommand always starts Pi interactively. Resource discovery and every
// built-in tool are disabled; the explicit AO-owned extension is the complete
// tool surface. No print or non-interactive mode flag is ever emitted.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	// Preflight calls ReviewCommand before request-scoped prompt files exist and
	// only needs the executable. Production launches always have the prompt root.
	if strings.TrimSpace(inv.TaskPromptRoot) == "" {
		return ports.ReviewCommandSpec{Argv: []string{binary}}, nil
	}

	extensionPath := filepath.Join(inv.TaskPromptRoot, extensionFilename)
	if err := os.MkdirAll(inv.TaskPromptRoot, 0o700); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("create Pi reviewer directory: %w", err)
	}
	if err := os.WriteFile(extensionPath, extensionSource, 0o600); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("write Pi reviewer extension: %w", err)
	}
	policyPath := filepath.Join(inv.TaskPromptRoot, "pi-policy.md")
	if err := os.WriteFile(policyPath, []byte(piPolicy), 0o600); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("write Pi reviewer policy: %w", err)
	}
	sessionDir := filepath.Join(inv.TaskPromptRoot, "pi-sessions")
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("create Pi reviewer session directory: %w", err)
	}

	argv := []string{
		binary,
		"--no-builtin-tools",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-approve",
		"--extension", extensionPath,
		"--tools", "ao_read,ao_search,git_inspect,github_post_review,ao_review_submit",
		"--session-dir", sessionDir,
	}
	if inv.SystemPromptFile != "" {
		argv = append(argv, "--append-system-prompt", inv.SystemPromptFile)
	}
	argv = append(argv, "--append-system-prompt", policyPath)
	if inv.Prompt != "" {
		argv = append(argv, inv.Prompt)
	}
	return ports.ReviewCommandSpec{
		Argv: argv,
		Env: map[string]string{
			"AO_PI_REVIEW_WORKSPACE":   inv.WorkspacePath,
			"AO_PI_REVIEW_PROMPT_ROOT": inv.TaskPromptRoot,
			"AO_PI_REVIEW_SESSION":     string(inv.WorkerSessionID),
		},
	}, nil
}

// ReviewMessage returns the short task-file reference for the long-lived TUI.
func (*Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

// ReviewCancel selects Pi's official interactive Escape cancellation key.
func (*Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelEscape, Interrupts: 1, Input: "\x1b"}, nil
}

const piPolicy = `Pi reviewer security policy

You are running in Pi's interactive TUI with no built-in tools and no project or user resources. Use only the AO review tools supplied by the loaded AO extension. Use github_post_review instead of the task file's gh command, and use ao_review_submit instead of its ao CLI command. Those structured tools enforce the current review queue and do not provide arbitrary shell execution. Never ask for or attempt to enable other tools or resources.`
