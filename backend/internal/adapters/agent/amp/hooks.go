package amp

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
	ampPluginDirName  = ".amp"
	ampPluginSubDir   = "plugins"
	ampPluginFileName = "ao-system-prompt.ts"
	ampPluginSentinel = "agent-orchestrator: managed amp system prompt plugin"
)

// GetAgentHooks installs AO's Amp system-prompt plugin into the worktree-local
// .amp/plugins directory. Amp has no documented system-prompt argv flag, but
// its plugin agent.start hook can add hidden context at turn start. AO owns only
// ao-system-prompt.ts; other user plugin files are preserved.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("amp.GetAgentHooks: WorkspacePath is required")
	}

	pluginPath := ampPluginPath(cfg.WorkspacePath)
	if _, err := os.Stat(pluginPath); err == nil {
		managed, err := isAOManagedAmpPlugin(pluginPath)
		if err != nil {
			return fmt.Errorf("amp.GetAgentHooks: %w", err)
		}
		if !managed {
			return fmt.Errorf("amp.GetAgentHooks: refusing to overwrite non-AO file at %s", pluginPath)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("amp.GetAgentHooks: stat plugin: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(pluginPath), 0o750); err != nil {
		return fmt.Errorf("amp.GetAgentHooks: create plugin dir: %w", err)
	}
	source := ampSystemPromptPluginSource(cfg.SystemPrompt, cfg.SystemPromptFile)
	if err := hookutil.AtomicWriteFile(pluginPath, []byte(source), 0o600); err != nil {
		return fmt.Errorf("amp.GetAgentHooks: write plugin: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(pluginPath), ampPluginFileName); err != nil {
		return fmt.Errorf("amp.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

func ampPluginPath(workspacePath string) string {
	return filepath.Join(workspacePath, ampPluginDirName, ampPluginSubDir, ampPluginFileName)
}

func isAOManagedAmpPlugin(path string) (bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // path built from caller-owned workspace dir
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read plugin: %w", err)
	}
	return strings.Contains(string(data), ampPluginSentinel), nil
}

func ampSystemPromptPluginSource(inline, file string) string {
	file = strings.TrimSpace(file)
	inline = strings.TrimRight(inline, "\n")

	var b strings.Builder
	b.WriteString("// ")
	b.WriteString(ampPluginSentinel)
	b.WriteString("\n")
	b.WriteString("import type { PluginAPI } from \"@ampcode/plugin\";\n")
	b.WriteString("import { readFile } from \"node:fs/promises\";\n\n")
	b.WriteString("const systemPromptFile = ")
	fmt.Fprintf(&b, "%q", file)
	b.WriteString(";\n")
	b.WriteString("const inlineSystemPrompt = ")
	if file == "" {
		fmt.Fprintf(&b, "%q", inline)
	} else {
		b.WriteString("\"\"")
	}
	b.WriteString(";\n\n")
	b.WriteString("async function loadSystemPrompt(amp: any): Promise<string> {\n")
	b.WriteString("  if (systemPromptFile) {\n")
	b.WriteString("    try {\n")
	b.WriteString("      const content = await readFile(systemPromptFile, \"utf8\");\n")
	b.WriteString("      const trimmed = content.trim();\n")
	b.WriteString("      if (trimmed) return trimmed;\n")
	b.WriteString("      amp.logger.log(\"AO system prompt file is empty\", { systemPromptFile });\n")
	b.WriteString("    } catch (error) {\n")
	b.WriteString("      amp.logger.log(\"AO system prompt file is unavailable\", { systemPromptFile, error });\n")
	b.WriteString("    }\n")
	b.WriteString("  }\n")
	b.WriteString("  return inlineSystemPrompt.trim();\n")
	b.WriteString("}\n\n")
	b.WriteString("export default function (amp: PluginAPI) {\n")
	b.WriteString("  amp.on(\"agent.start\", async () => {\n")
	b.WriteString("    const systemPrompt = await loadSystemPrompt(amp);\n")
	b.WriteString("    if (!systemPrompt) return {};\n")
	b.WriteString("    return { message: { content: systemPrompt, display: false } };\n")
	b.WriteString("  });\n")
	b.WriteString("}\n")
	return b.String()
}
