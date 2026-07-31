// Package qwen contains the pending interactive Qwen Code reviewer adapter.
// It is intentionally absent from the shipped reviewer registry until AO has
// tested OS isolation for Qwen's terminal-user `!` shell on tmux and ConPTY.
package qwen

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	workerqwen "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/qwen"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/reviewgateway"
)

type binaryResolver func(context.Context) (string, error)

// ErrIsolationUnavailable keeps Qwen fail-closed until AO can contain the
// interactive TUI's terminal-user shell on both tmux and ConPTY.
var ErrIsolationUnavailable = errors.New("qwen reviewer is disabled: AO has no fail-closed cross-platform isolation for Qwen shell escapes")

// Reviewer builds only Qwen's visible, long-lived interactive TUI command.
type Reviewer struct {
	dataDir       string
	resolveBinary binaryResolver
}

// New creates the pending adapter. Registration remains a separate, gated act.
func New(dataDir string) *Reviewer {
	return &Reviewer{dataDir: dataDir, resolveBinary: workerqwen.ResolveQwenBinary}
}

func (r *Reviewer) Harness() domain.ReviewerHarness { return domain.ReviewerQwen }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand deliberately rejects production launch. The reserved command
// shape is tested separately so enabling the adapter cannot silently introduce
// a headless mode, but a neutral environment is not OS containment.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	return ports.ReviewCommandSpec{}, ErrIsolationUnavailable
}

// interactiveCommandSpec reserves Qwen's future long-lived TUI command shape.
// --bare and an explicit empty MCP configuration prevent implicit project
// extensions/MCP/startup discovery; they do not contain the TUI's `!` shell.
func (r *Reviewer) interactiveCommandSpec(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	env, err := r.prepareEnvironment(inv)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	if !filepath.IsAbs(binary) {
		return ports.ReviewCommandSpec{}, errors.New("qwen reviewer: resolved binary must be absolute")
	}
	systemPrompt, err := readSystemPrompt(inv)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	argv := []string{
		binary,
		"--bare",
		"--approval-mode", "plan",
		"--chat-recording=false",
		"--mcp-config", `{"mcpServers":{}}`,
	}
	if systemPrompt != "" {
		argv = append(argv, "--append-system-prompt", systemPrompt)
	}
	// -i is Qwen's documented "execute prompt and continue in interactive
	// mode" flag. Never substitute -p, positional one-shot, output formats,
	// ACP, RPC, serve, or JSON-schema modes here.
	argv = append(argv, "--prompt-interactive", inv.Prompt)

	envVars := env.TUIEnvironment()
	envVars["AO_DATA_DIR"] = env.DataDir
	envVars["AO_REVIEW_GATEWAY_MANIFEST"] = env.ManifestPath
	return ports.ReviewCommandSpec{Argv: argv, Env: envVars, WorkingDirectory: env.WorkingDirectory}, nil
}

// ReviewMessage creates a new immutable task capability and carries its path in
// AO's normal pane injection. The future sandbox-owned gateway transport will
// bind that manifest; Qwen never receives new authority through process env.
func (r *Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	env, err := r.prepareEnvironment(inv)
	if err != nil {
		return "", err
	}
	return inv.Prompt + "\nAO review gateway manifest: `" + filepath.ToSlash(env.ManifestPath) + "`.", nil
}

// ReviewCancel matches Qwen's interactive TUI: one Ctrl-C cancels the active
// turn while leaving the pane and session alive.
func (r *Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 1}, nil
}

func (r *Reviewer) prepareEnvironment(inv ports.ReviewInvocation) (reviewgateway.Environment, error) {
	if strings.TrimSpace(r.dataDir) == "" {
		return reviewgateway.Environment{}, errors.New("qwen reviewer: AO data directory is required")
	}
	manifest := reviewgateway.Manifest{
		ReviewerID: inv.ReviewerID, WorkerSessionID: inv.WorkerSessionID,
		WorkspacePath: inv.WorkspacePath, TaskPromptRoot: inv.TaskPromptRoot,
		Tasks: []reviewgateway.Task{{
			RunID: inv.RunID, PRURL: inv.PRURL, TargetSHA: inv.TargetSHA,
			TaskPromptFile: inv.TaskPromptFile,
		}},
	}
	env, err := reviewgateway.PrepareEnvironment(r.dataDir, manifest)
	if err != nil {
		return reviewgateway.Environment{}, fmt.Errorf("qwen reviewer: prepare gateway environment: %w", err)
	}
	return env, nil
}

func readSystemPrompt(inv ports.ReviewInvocation) (string, error) {
	if inv.SystemPrompt != "" {
		return inv.SystemPrompt, nil
	}
	if inv.SystemPromptFile == "" {
		return "", nil
	}
	raw, err := os.ReadFile(inv.SystemPromptFile) //nolint:gosec // AO-owned path from launcher
	if err != nil {
		return "", fmt.Errorf("qwen reviewer: read system prompt: %w", err)
	}
	return string(raw), nil
}
