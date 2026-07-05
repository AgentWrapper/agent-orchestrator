package cursor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
)

// cursorTrustMarkerName is the file cursor-agent drops into a workspace's
// project-storage dir to record that the workspace is trusted.
const cursorTrustMarkerName = ".workspace-trusted"

// cursorSlugNonAlnum matches runs of non-alphanumeric characters. cursor-agent
// slugifies an absolute workspace path into its project-storage directory name
// by collapsing each such run to a single "-"; this mirrors that transform.
var cursorSlugNonAlnum = regexp.MustCompile(`[^A-Za-z0-9]+`)

// ensureWorkspaceTrusted pre-seeds cursor-agent's workspace-trust marker so a
// freshly created worker worktree does not stop at the interactive "Do you
// trust the files in this workspace?" prompt in AO's terminal pane. These are
// AO-spawned worker workspaces, so the trust decision is implicit.
//
// cursor-agent gates trust purely on the existence of a `.workspace-trusted`
// file under its per-workspace project-storage dir
// (`$CURSOR_DATA_DIR|~/.cursor`/projects/<slug>), where <slug> is the absolute
// workspace path with every run of non-alphanumeric characters collapsed to
// "-". Its `--trust` flag only works in --print/headless mode (see
// GetLaunchCommand), so for the interactive TUI AO writes the marker itself,
// exactly as cursor-agent would on first trust.
//
// Trust is looked up by the canonicalized cwd first and the literal path
// second, which on macOS commonly differ (/tmp vs /private/tmp), so both are
// seeded — mirroring the codex adapter's workspace-trust handling. Best-effort:
// any error is returned for the caller to ignore, so a seed failure degrades to
// the pre-existing one-time prompt rather than blocking launch.
func ensureWorkspaceTrusted(workspacePath string) error {
	path := strings.TrimSpace(workspacePath)
	if path == "" {
		return nil
	}

	seen := map[string]bool{}
	var firstErr error
	for _, variant := range trustPathVariants(path) {
		dir := cursorProjectStorageDir(variant)
		if dir == "" || seen[dir] {
			continue
		}
		seen[dir] = true
		if err := writeCursorTrustMarker(dir, variant); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// trustPathVariants returns the workspace path plus its symlink-resolved form
// when they differ, so trust is seeded under whichever cursor-agent derives from
// its resolved cwd.
func trustPathVariants(path string) []string {
	variants := []string{path}
	if resolved, err := filepath.EvalSymlinks(path); err == nil && resolved != path {
		variants = append(variants, resolved)
	}
	return variants
}

// cursorProjectStorageDir returns the per-workspace project-storage directory
// cursor-agent derives for workspacePath: <base>/projects/<slug>. base is
// $CURSOR_DATA_DIR when set, else ~/.cursor. Returns "" when neither is
// resolvable. This intentionally omits cursor-agent's long-path hashing
// fallback: that only applies to the shorter, capped storage variant, whereas
// the trust marker is keyed off the uncapped slug (verified against on-disk
// markers for >92-char worktree paths).
func cursorProjectStorageDir(workspacePath string) string {
	base := strings.TrimSpace(os.Getenv("CURSOR_DATA_DIR"))
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".cursor")
	}
	return filepath.Join(base, "projects", cursorSlugifyPath(workspacePath))
}

// cursorSlugifyPath mirrors cursor-agent's slugifyPath: collapse each run of
// non-alphanumeric characters to "-" and trim leading/trailing dashes. Case is
// preserved (cursor-agent does not lowercase the path).
func cursorSlugifyPath(path string) string {
	return strings.Trim(cursorSlugNonAlnum.ReplaceAllString(path, "-"), "-")
}

// writeCursorTrustMarker writes the trust marker into dir when absent. cursor-agent
// checks only the file's existence, but the JSON shape mirrors what it writes so
// the file reads identically to a natively-trusted workspace.
func writeCursorTrustMarker(dir, workspacePath string) error {
	markerPath := filepath.Join(dir, cursorTrustMarkerName)
	if hookutil.FileExists(markerPath) {
		return nil
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("cursor: create project storage dir: %w", err)
	}
	payload, err := json.MarshalIndent(map[string]string{
		"trustedAt":     time.Now().UTC().Format(time.RFC3339Nano),
		"workspacePath": workspacePath,
		"trustMethod":   "ao-managed",
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("cursor: encode trust marker: %w", err)
	}
	if err := hookutil.AtomicWriteFile(markerPath, append(payload, '\n'), 0o600); err != nil {
		return fmt.Errorf("cursor: write trust marker: %w", err)
	}
	return nil
}
