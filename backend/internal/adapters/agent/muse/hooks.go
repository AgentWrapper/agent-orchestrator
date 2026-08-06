package muse

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
	museInstructionsDirName  = ".muse"
	museInstructionsFileName = "AGENTS.md"
	museInstructionsSentinel = "<!-- managed by agent-orchestrator: muse system prompt -->"
	museInstructionsEnd      = "<!-- /managed by agent-orchestrator: muse system prompt -->"
)

// GetAgentHooks installs AO's standing prompt through Muse's documented
// project instruction file. Muse's external hook support does not currently
// emit every lifecycle event AO needs, so this adapter intentionally installs
// instructions only and relies on AO's generic process supervision.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("muse.GetAgentHooks: WorkspacePath is required")
	}
	systemPrompt, err := museSystemPromptText(cfg.SystemPrompt, cfg.SystemPromptFile)
	if err != nil {
		return fmt.Errorf("muse.GetAgentHooks: %w", err)
	}
	if systemPrompt == "" {
		return nil
	}

	path := museInstructionsPath(cfg.WorkspacePath)
	existing, err := os.ReadFile(path) //nolint:gosec // path is inside the session workspace
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("muse.GetAgentHooks: read %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("muse.GetAgentHooks: create instruction dir: %w", err)
	}
	if err := hookutil.AtomicWriteFile(path, []byte(mergeMuseInstructionFile(string(existing), systemPrompt)), 0o600); err != nil {
		return fmt.Errorf("muse.GetAgentHooks: write %s: %w", path, err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(path), museInstructionsFileName); err != nil {
		return fmt.Errorf("muse.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

func museInstructionsPath(workspacePath string) string {
	return filepath.Join(workspacePath, museInstructionsDirName, museInstructionsFileName)
}

func museSystemPromptText(inline, file string) (string, error) {
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

func museInstructionFile(systemPrompt string) string {
	return museInstructionsSentinel + "\n\n" +
		"# Agent Orchestrator Session Instructions\n\n" +
		strings.TrimRight(systemPrompt, "\n") + "\n\n" +
		museInstructionsEnd + "\n"
}

func mergeMuseInstructionFile(existing, systemPrompt string) string {
	block := museInstructionFile(systemPrompt)
	start := strings.Index(existing, museInstructionsSentinel)
	if start < 0 {
		return joinMuseInstructionParts(existing, block, "")
	}

	afterStart := existing[start+len(museInstructionsSentinel):]
	endRel := strings.Index(afterStart, museInstructionsEnd)
	if endRel < 0 {
		return joinMuseInstructionParts(existing[:start], block, "")
	}
	end := start + len(museInstructionsSentinel) + endRel + len(museInstructionsEnd)
	return joinMuseInstructionParts(existing[:start], block, existing[end:])
}

func joinMuseInstructionParts(prefix, block, suffix string) string {
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
