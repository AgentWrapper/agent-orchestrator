package crush

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	crushConfigDirName      = ".crush"
	crushConfigFileName     = ".crush.json"
	crushSystemPromptName   = "ao-system-prompt.md"
	crushSystemPromptPath   = crushConfigDirName + "/" + crushSystemPromptName
	crushSystemPromptMarker = "agent-orchestrator: managed crush system prompt"
)

// GetAgentHooks installs AO's standing instructions as a Crush context file.
// Crush has no launch-time system-prompt flag, but it reads context_paths from
// project config. AO therefore owns one prompt file under .crush/ and merges
// only that path into the hidden project-local .crush.json.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("crush.GetAgentHooks: WorkspacePath is required")
	}
	prompt, err := crushSystemPromptText(cfg.SystemPrompt, cfg.SystemPromptFile)
	if err != nil {
		return fmt.Errorf("crush.GetAgentHooks: %w", err)
	}
	if strings.TrimSpace(prompt) == "" {
		return nil
	}

	promptPath := crushSystemPromptFile(cfg.WorkspacePath)
	if _, err := os.Stat(promptPath); err == nil {
		managed, err := isAOManagedCrushSystemPrompt(promptPath)
		if err != nil {
			return fmt.Errorf("crush.GetAgentHooks: %w", err)
		}
		if !managed {
			return fmt.Errorf("crush.GetAgentHooks: refusing to overwrite non-AO file at %s", promptPath)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("crush.GetAgentHooks: stat system prompt: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(promptPath), 0o750); err != nil {
		return fmt.Errorf("crush.GetAgentHooks: create config dir: %w", err)
	}
	content := "<!-- " + crushSystemPromptMarker + " -->\n\n" + strings.TrimRight(prompt, "\n") + "\n"
	if err := hookutil.AtomicWriteFile(promptPath, []byte(content), 0o600); err != nil {
		return fmt.Errorf("crush.GetAgentHooks: write system prompt: %w", err)
	}
	if err := mergeCrushContextPath(crushConfigFile(cfg.WorkspacePath), crushSystemPromptPath); err != nil {
		return fmt.Errorf("crush.GetAgentHooks: merge config: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(promptPath), crushSystemPromptName); err != nil {
		return fmt.Errorf("crush.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

// UninstallHooks removes AO's Crush context file and context_paths entry. User
// config is preserved; AO removes only its exact path and only deletes the
// prompt file when it carries the AO marker.
func (p *Plugin) UninstallHooks(ctx context.Context, workspacePath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return errors.New("crush.UninstallHooks: workspacePath is required")
	}
	promptPath := crushSystemPromptFile(workspacePath)
	managed, err := isAOManagedCrushSystemPrompt(promptPath)
	if err != nil {
		return fmt.Errorf("crush.UninstallHooks: %w", err)
	}
	if managed {
		if err := os.Remove(promptPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("crush.UninstallHooks: remove system prompt: %w", err)
		}
	}
	if err := removeCrushContextPath(crushConfigFile(workspacePath), crushSystemPromptPath); err != nil {
		return fmt.Errorf("crush.UninstallHooks: merge config: %w", err)
	}
	return nil
}

// AreHooksInstalled reports whether AO's Crush system-prompt context file is
// present. Crush still lacks activity hooks; this reports only the prompt
// injection hook surface AO manages for Crush.
func (p *Plugin) AreHooksInstalled(ctx context.Context, workspacePath string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return false, errors.New("crush.AreHooksInstalled: workspacePath is required")
	}
	managed, err := isAOManagedCrushSystemPrompt(crushSystemPromptFile(workspacePath))
	if err != nil {
		return false, fmt.Errorf("crush.AreHooksInstalled: %w", err)
	}
	return managed, nil
}

func crushSystemPromptFile(workspacePath string) string {
	return filepath.Join(workspacePath, crushConfigDirName, crushSystemPromptName)
}

func crushConfigFile(workspacePath string) string {
	return filepath.Join(workspacePath, crushConfigFileName)
}

func crushSystemPromptText(inline, file string) (string, error) {
	if strings.TrimSpace(file) != "" {
		data, err := os.ReadFile(file) //nolint:gosec // path is AO-owned launch config
		if err != nil {
			return "", fmt.Errorf("read system prompt file: %w", err)
		}
		return strings.TrimRight(string(data), "\n"), nil
	}
	return strings.TrimRight(inline, "\n"), nil
}

func isAOManagedCrushSystemPrompt(path string) (bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // path built from caller-owned workspace dir
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read %s: %w", path, err)
	}
	return strings.Contains(string(data), crushSystemPromptMarker), nil
}

func mergeCrushContextPath(configPath, contextPath string) error {
	cfg, err := readCrushConfig(configPath)
	if err != nil {
		return err
	}
	options := crushConfigObject(cfg, "options")
	paths := crushStringSlice(options["context_paths"])
	if !slices.Contains(paths, contextPath) {
		paths = append(paths, contextPath)
	}
	options["context_paths"] = paths
	cfg["options"] = options
	return writeCrushConfig(configPath, cfg)
}

func removeCrushContextPath(configPath, contextPath string) error {
	cfg, err := readCrushConfig(configPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	options, ok := cfg["options"].(map[string]any)
	if !ok {
		return nil
	}
	paths := crushStringSlice(options["context_paths"])
	next := paths[:0]
	for _, path := range paths {
		if path != contextPath {
			next = append(next, path)
		}
	}
	options["context_paths"] = next
	cfg["options"] = options
	return writeCrushConfig(configPath, cfg)
}

func readCrushConfig(path string) (map[string]any, error) {
	data, err := os.ReadFile(path) //nolint:gosec // path built from caller-owned workspace dir
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return map[string]any{}, nil
	}
	var cfg map[string]any
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return cfg, nil
}

func writeCrushConfig(path string, cfg map[string]any) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	return hookutil.AtomicWriteFile(path, data, 0o600)
}

func crushConfigObject(cfg map[string]any, key string) map[string]any {
	if obj, ok := cfg[key].(map[string]any); ok {
		return obj
	}
	return map[string]any{}
}

func crushStringSlice(v any) []string {
	raw, ok := v.([]any)
	if !ok {
		if typed, ok := v.([]string); ok {
			return slices.Clone(typed)
		}
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
