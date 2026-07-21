package pi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "embed"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	piConfigDirName     = ".pi"
	piExtensionSubDir   = "extensions"
	piExtensionFileName = "ao-activity.ts"
	piExtensionSentinel = "agent-orchestrator: managed pi activity extension"
	piHookCommandPrefix = "ao hooks pi "
)

//go:embed assets/ao-activity.ts
var piExtensionSource string

var piManagedEvents = []string{"session-start", "user-prompt-submit", "stop", "session-end"}

// GetAgentHooks installs AO's Pi activity extension into the worktree-local
// .pi/extensions/ directory. Pi discovers project-local TypeScript extensions
// there after the project is trusted. AO fully owns this one filename and
// refuses to overwrite it unless the existing file carries AO's sentinel.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("pi.GetAgentHooks: WorkspacePath is required")
	}

	extensionPath := piExtensionPath(cfg.WorkspacePath)
	if _, err := os.Stat(extensionPath); err == nil {
		managed, err := isAOManagedPIExtension(extensionPath)
		if err != nil {
			return fmt.Errorf("pi.GetAgentHooks: %w", err)
		}
		if !managed {
			return fmt.Errorf("pi.GetAgentHooks: refusing to overwrite non-AO file at %s", extensionPath)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("pi.GetAgentHooks: stat extension: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(extensionPath), 0o750); err != nil {
		return fmt.Errorf("pi.GetAgentHooks: create extension dir: %w", err)
	}
	if err := hookutil.AtomicWriteFile(extensionPath, []byte(piExtensionSource), 0o600); err != nil {
		return fmt.Errorf("pi.GetAgentHooks: write extension: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(extensionPath), piExtensionFileName); err != nil {
		return fmt.Errorf("pi.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

func piExtensionPath(workspacePath string) string {
	return filepath.Join(workspacePath, piConfigDirName, piExtensionSubDir, piExtensionFileName)
}

func isAOManagedPIExtension(path string) (bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // path built from caller-owned workspace dir
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read %s: %w", path, err)
	}
	return strings.Contains(string(data), piExtensionSentinel), nil
}
