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

	kimiHooksSentinelStart = "# managed by agent-orchestrator: kimi hooks"
	kimiHooksSentinelEnd   = "# /managed by agent-orchestrator: kimi hooks"
)

// GetAgentHooks installs AO's standing system prompt through Kimi's
// project-level instruction file. Kimi has no system-prompt argv flag, and its
// user-level config lives outside AO's data dir, so a gitignored worktree-local
// instruction file is the least invasive session-scoped injection point. It
// also installs Kimi lifecycle hooks into the AO-managed Kimi config so AO can
// capture Kimi's native session id for true resume without mutating the user's
// global Kimi profile.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("kimi.GetAgentHooks: WorkspacePath is required")
	}

	if err := installKimiConfigHooks(cfg); err != nil {
		return fmt.Errorf("kimi.GetAgentHooks: %w", err)
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

func installKimiConfigHooks(cfg ports.WorkspaceHookConfig) error {
	home, ok := kimiCodeHomeFromEnv(cfg.Env)
	if !ok {
		return errors.New("kimi: AO-managed Kimi Code home is unavailable")
	}
	path := filepath.Join(home, "config.toml")
	data, err := os.ReadFile(path) //nolint:gosec // path is the AO-managed Kimi config under KIMI_CODE_HOME.
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read %s: %w", path, err)
	}
	body := mergeKimiHooksConfig(string(data))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("create Kimi config dir: %w", err)
	}
	if err := hookutil.AtomicWriteFile(path, []byte(body), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func kimiCodeHomeFromEnv(env map[string]string) (string, bool) {
	if env != nil {
		if home := strings.TrimSpace(env[kimiCodeHomeEnv]); home != "" {
			return home, true
		}
	}
	return "", false
}

func mergeKimiHooksConfig(existing string) string {
	block := kimiHooksConfigBlock()
	start := strings.Index(existing, kimiHooksSentinelStart)
	if start < 0 {
		return joinKimiConfigParts(existing, block, "")
	}
	afterStart := existing[start+len(kimiHooksSentinelStart):]
	endRel := strings.Index(afterStart, kimiHooksSentinelEnd)
	if endRel < 0 {
		return joinKimiConfigParts(existing[:start], block, "")
	}
	end := start + len(kimiHooksSentinelStart) + endRel + len(kimiHooksSentinelEnd)
	return joinKimiConfigParts(existing[:start], block, existing[end:])
}

func kimiHooksConfigBlock() string {
	return kimiHooksSentinelStart + "\n\n" +
		kimiHookEntry("SessionStart", "startup", "ao hooks kimi session-start") +
		kimiHookEntry("UserPromptSubmit", "", "ao hooks kimi user-prompt-submit") +
		kimiHookEntry("PermissionRequest", "", "ao hooks kimi permission-request") +
		kimiHookEntry("Stop", "", "ao hooks kimi stop") +
		kimiHooksSentinelEnd + "\n"
}

func kimiHookEntry(event, matcher, command string) string {
	var b strings.Builder
	b.WriteString("[[hooks]]\n")
	b.WriteString("event = ")
	b.WriteString(quoteTOMLString(event))
	b.WriteByte('\n')
	if matcher != "" {
		b.WriteString("matcher = ")
		b.WriteString(quoteTOMLString(matcher))
		b.WriteByte('\n')
	}
	b.WriteString("command = ")
	b.WriteString(quoteTOMLString(command))
	b.WriteByte('\n')
	b.WriteString("timeout = 5\n\n")
	return b.String()
}

func quoteTOMLString(s string) string {
	return fmt.Sprintf("%q", s)
}

func joinKimiConfigParts(prefix, block, suffix string) string {
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
