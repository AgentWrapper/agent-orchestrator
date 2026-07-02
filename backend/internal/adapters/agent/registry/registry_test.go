package registry

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// TestGetAgentHooksFootprintIsGitignored enforces a contract every shipped
// (and future) adapter must hold: any file GetAgentHooks writes into a session
// worktree must be covered by a sibling AO-managed self-ignoring .gitignore
// (hookutil.EnsureWorkspaceGitignore). Hook files are untracked, and
// `git worktree remove` (without --force) refuses on any untracked file — an
// uncovered hook file makes every one of that adapter's session workspaces
// permanently undeletable (kill/cleanup can never free them).
func TestGetAgentHooksFootprintIsGitignored(t *testing.T) {
	for _, ha := range Harnessed() {
		t.Run(string(ha.Harness), func(t *testing.T) {
			ws := t.TempDir()
			if ha.Harness == "autohand" {
				t.Setenv("AUTOHAND_CONFIG", filepath.Join(t.TempDir(), "config.json"))
			}
			cfg := ports.WorkspaceHookConfig{
				SessionID:     "proj-1",
				WorkspacePath: ws,
				DataDir:       t.TempDir(),
			}
			if err := ha.Agent.GetAgentHooks(context.Background(), cfg); err != nil {
				t.Fatalf("GetAgentHooks: %v", err)
			}
			files := workspaceFiles(t, ws)
			for _, rel := range files {
				gitignorePath := filepath.Join(ws, filepath.Dir(rel), ".gitignore")
				data, err := os.ReadFile(gitignorePath) //nolint:gosec // test-owned temp dir
				if err != nil {
					t.Errorf("hook file %q has no sibling .gitignore (%v); it will keep the session worktree permanently dirty", rel, err)
					continue
				}
				content := string(data)
				if !strings.Contains(content, hookutil.GitignoreSentinel) {
					t.Errorf(".gitignore next to %q is not AO-managed (missing sentinel)", rel)
					continue
				}
				if entry := "/" + filepath.Base(rel); !hasLine(content, entry) {
					t.Errorf(".gitignore next to %q does not list %q", rel, entry)
				}
			}
		})
	}
}

func TestEveryHarnessReportsAuthStatus(t *testing.T) {
	authCheckerExempt := map[string]string{
		"continue": "Continue auth probes require sending a model prompt, so catalog refresh must not run them",
	}
	for _, ha := range Harnessed() {
		if reason, exempt := authCheckerExempt[string(ha.Harness)]; exempt {
			if _, ok := ha.Agent.(ports.AgentAuthChecker); ok {
				t.Errorf("%s implements ports.AgentAuthChecker but is exempt: %s", ha.Harness, reason)
			}
			continue
		}
		if _, ok := ha.Agent.(ports.AgentAuthChecker); !ok {
			t.Errorf("%s does not implement ports.AgentAuthChecker", ha.Harness)
		}
	}
}

// workspaceFiles returns every regular file under root, relative to root.
func workspaceFiles(t *testing.T, root string) []string {
	t.Helper()
	var files []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			files = append(files, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk workspace: %v", err)
	}
	return files
}

func hasLine(content, line string) bool {
	for _, l := range strings.Split(content, "\n") {
		if strings.TrimSpace(l) == line {
			return true
		}
	}
	return false
}
