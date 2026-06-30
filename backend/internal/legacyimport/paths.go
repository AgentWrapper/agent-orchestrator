// Package legacyimport reads the legacy Agent Orchestrator flat-file store
// (~/.agent-orchestrator) read-only and ports it into the rewrite's native
// SQLite store. It maps the legacy project registry and per-project settings.
//
// This is the Go port of the legacy-side TypeScript reader (AgentWrapper PR
// #2144 / issue #2129); the field mapping is ReverbCode issue #247. The legacy
// files are NEVER modified: a declined or failed import loses nothing, and a
// re-run skips rows that already exist.
package legacyimport

import (
	"os"
	"path/filepath"
)

// userHomeDir is indirected so tests can pin the home directory without mutating
// process environment.
var userHomeDir = os.UserHomeDir

// DefaultLegacyRootDir returns the canonical legacy state root,
// ~/.agent-orchestrator, or "" when the home directory cannot be resolved.
func DefaultLegacyRootDir() string {
	home, err := userHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".agent-orchestrator")
}

// globalConfigPath is the legacy global config file, root/config.yaml.
func globalConfigPath(root string) string {
	return filepath.Join(root, "config.yaml")
}

// preferencesPath / registeredPath are the optional portfolio overlays that
// carry UI display names and per-project registration timestamps.
func preferencesPath(root string) string {
	return filepath.Join(root, "portfolio", "preferences.json")
}

func registeredPath(root string) string {
	return filepath.Join(root, "portfolio", "registered.json")
}
