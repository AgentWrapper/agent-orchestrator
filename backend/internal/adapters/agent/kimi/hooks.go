package kimi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	kimiInstructionsDirName  = ".kimi-code"
	kimiInstructionsFileName = "AGENTS.md"
	kimiInstructionsSentinel = "<!-- managed by agent-orchestrator: kimi system prompt -->"
	kimiInstructionsEnd      = "<!-- /managed by agent-orchestrator: kimi system prompt -->"
)

// GetAgentHooks installs AO's standing system prompt through Kimi's
// project-level instruction file. Kimi has no system-prompt argv flag, and its
// user-level config lives outside AO's data dir, so a gitignored worktree-local
// instruction file is the least invasive session-scoped injection point.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("kimi.GetAgentHooks: WorkspacePath is required")
	}

	systemPrompt, err := kimiSystemPromptText(cfg.SystemPrompt, cfg.SystemPromptFile)
	if err != nil {
		return fmt.Errorf("kimi.GetAgentHooks: %w", err)
	}
	if systemPrompt == "" {
		return nil
	}

	instructionsPath := kimiInstructionsPath(cfg.WorkspacePath)
	var existing []byte
	existing, err = os.ReadFile(instructionsPath) //nolint:gosec // path built from caller-owned workspace dir
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("kimi.GetAgentHooks: read %s: %w", instructionsPath, err)
	}

	if err := os.MkdirAll(filepath.Dir(instructionsPath), 0o750); err != nil {
		return fmt.Errorf("kimi.GetAgentHooks: create instruction dir: %w", err)
	}
	body := mergeKimiInstructionFile(string(existing), systemPrompt)
	if err := hookutil.AtomicWriteFile(instructionsPath, []byte(body), 0o600); err != nil {
		return fmt.Errorf("kimi.GetAgentHooks: write %s: %w", instructionsPath, err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(instructionsPath), kimiInstructionsFileName); err != nil {
		return fmt.Errorf("kimi.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

func kimiInstructionsPath(workspacePath string) string {
	return filepath.Join(workspacePath, kimiInstructionsDirName, kimiInstructionsFileName)
}

func kimiSystemPromptText(inline, file string) (string, error) {
	if strings.TrimSpace(inline) != "" {
		return strings.TrimRight(inline, "\n"), nil
	}
	if strings.TrimSpace(file) == "" {
		return "", nil
	}
	data, err := os.ReadFile(file) //nolint:gosec // path is AO-owned launch config
	if err != nil {
		return "", fmt.Errorf("read system prompt file: %w", err)
	}
	return strings.TrimRight(string(data), "\n"), nil
}

func kimiInstructionFile(systemPrompt string) string {
	return kimiInstructionsSentinel + "\n\n" +
		"# Agent Orchestrator Session Instructions\n\n" +
		strings.TrimRight(systemPrompt, "\n") + "\n\n" +
		kimiInstructionsEnd + "\n"
}

func mergeKimiInstructionFile(existing, systemPrompt string) string {
	block := kimiInstructionFile(systemPrompt)
	start := strings.Index(existing, kimiInstructionsSentinel)
	if start < 0 {
		return joinKimiInstructionParts(existing, block, "")
	}

	afterStart := existing[start+len(kimiInstructionsSentinel):]
	endRel := strings.Index(afterStart, kimiInstructionsEnd)
	if endRel < 0 {
		// Older AO-managed files did not have an end marker. Treat the marker as
		// owning the rest of the file so stale AO instructions are replaced.
		return joinKimiInstructionParts(existing[:start], block, "")
	}

	end := start + len(kimiInstructionsSentinel) + endRel + len(kimiInstructionsEnd)
	return joinKimiInstructionParts(existing[:start], block, existing[end:])
}

func joinKimiInstructionParts(prefix, block, suffix string) string {
	var b strings.Builder
	prefix = strings.TrimRight(prefix, "\n")
	if prefix != "" {
		b.WriteString(prefix)
		b.WriteString("\n\n")
	}
	b.WriteString(block)
	suffix = strings.TrimLeft(suffix, "\n")
	if suffix != "" {
		b.WriteString("\n")
		b.WriteString(suffix)
	}
	return b.String()
}
