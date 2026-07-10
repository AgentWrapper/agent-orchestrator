package cursor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
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

// cursorTrustMethodAO tags markers AO seeded itself, so cleanup can tell them
// apart from markers cursor-agent wrote after a real user trust decision.
const cursorTrustMethodAO = "ao-managed"

// cursorSlugNonAlnum matches runs of non-alphanumeric characters. cursor-agent
// slugifies an absolute workspace path into its project-storage directory name
// by collapsing each such run to a single "-"; this mirrors that transform.
var cursorSlugNonAlnum = regexp.MustCompile(`[^A-Za-z0-9]+`)

// seedWorkspaceTrust applies ensureWorkspaceTrusted's best-effort contract at
// the launch/restore call sites: a seed failure must never block the launch
// (it degrades to cursor's one-time prompt), but it must be visible in the
// daemon log — an unattended worker otherwise stalls at the trust prompt with
// nothing anywhere explaining why the session sits idle.
func seedWorkspaceTrust(ctx context.Context, workspacePath string, env map[string]string) {
	if err := ensureWorkspaceTrusted(ctx, workspacePath, env); err != nil {
		slog.Warn("cursor: workspace trust seeding failed; the session may stop at cursor-agent's one-time trust prompt",
			"workspace", workspacePath, "error", err)
	}
}

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
// second, so both variants are seeded (hookutil.WorkspacePathVariants, shared
// with the codex adapter). Best-effort: any error is returned for the caller
// to log-and-continue, so a seed failure degrades to the pre-existing one-time
// prompt rather than blocking launch.
//
// env is the environment overrides the runtime exports into the spawned
// cursor-agent process (ports.LaunchConfig.Env / RestoreConfig.Env). The
// marker must land in the data dir the CHILD resolves, not the daemon's: a
// project-level env.CURSOR_DATA_DIR (or HOME) override changes where
// cursor-agent looks, so the same override must steer where the marker is
// written. A variable that differs between the daemon's environment and an
// externally started tmux server's — without appearing in env — can still
// diverge; only override keys present in env are exported into the pane.
func ensureWorkspaceTrusted(ctx context.Context, workspacePath string, env map[string]string) error {
	var firstErr error
	err := forEachTrustDir(ctx, workspacePath, env, func(dir, variant string) {
		if err := writeCursorTrustMarker(dir, variant); err != nil && firstErr == nil {
			firstErr = err
		}
	})
	if err != nil {
		return err
	}
	return firstErr
}

// removeWorkspaceTrust deletes AO-seeded trust markers for workspacePath. It
// is the teardown counterpart of ensureWorkspaceTrusted: without it, a
// destroyed worktree leaves durable trust at a reusable absolute path, so a
// later manual cursor-agent run on different content there would silently
// skip the trust prompt. Only markers stamped trustMethod "ao-managed" are
// removed — a marker cursor-agent wrote after the user answered its prompt
// records a real user decision and is left alone.
func removeWorkspaceTrust(ctx context.Context, workspacePath string, env map[string]string) error {
	var firstErr error
	err := forEachTrustDir(ctx, workspacePath, env, func(dir, _ string) {
		if err := removeCursorTrustMarker(dir); err != nil && firstErr == nil {
			firstErr = err
		}
	})
	if err != nil {
		return err
	}
	return firstErr
}

// forEachTrustDir invokes fn once per distinct project-storage dir derived
// from workspacePath's path variants. Returns early on context cancellation;
// fn collects its own per-dir errors.
func forEachTrustDir(ctx context.Context, workspacePath string, env map[string]string, fn func(dir, variant string)) error {
	seen := map[string]bool{}
	for _, variant := range hookutil.WorkspacePathVariants(workspacePath) {
		if err := ctx.Err(); err != nil {
			return err
		}
		dir := cursorProjectStorageDir(variant, env)
		if dir == "" || seen[dir] {
			continue
		}
		seen[dir] = true
		fn(dir, variant)
	}
	return nil
}

// cursorProjectStorageDir returns the per-workspace project-storage directory
// cursor-agent derives for workspacePath: <base>/projects/<slug>. base is
// CURSOR_DATA_DIR as the spawned process will see it — env overrides win over
// the daemon's own environment, mirroring how the runtime exports env
// (overrides on top of os.Environ()) — else <home>/.cursor, where home also
// honors an env HOME override before the daemon's os.UserHomeDir. A relative
// base is resolved against the workspace path, because the child resolves it
// against its own cwd (the workspace), not the daemon's. Returns "" when
// nothing is resolvable. This intentionally omits cursor-agent's long-path
// hashing fallback: that only applies to the shorter, capped storage variant,
// whereas the trust marker is keyed off the uncapped slug (verified against
// on-disk markers for >92-char worktree paths).
func cursorProjectStorageDir(workspacePath string, env map[string]string) string {
	base, overridden := env["CURSOR_DATA_DIR"]
	if !overridden {
		base = os.Getenv("CURSOR_DATA_DIR")
	}
	base = strings.TrimSpace(base)
	if base == "" {
		home := strings.TrimSpace(env["HOME"])
		if home == "" {
			h, err := os.UserHomeDir()
			if err != nil {
				return ""
			}
			home = h
		}
		base = filepath.Join(home, ".cursor")
	}
	if !filepath.IsAbs(base) {
		base = filepath.Join(workspacePath, base)
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
		"trustMethod":   cursorTrustMethodAO,
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("cursor: encode trust marker: %w", err)
	}
	if err := hookutil.AtomicWriteFile(markerPath, append(payload, '\n'), 0o600); err != nil {
		return fmt.Errorf("cursor: write trust marker: %w", err)
	}
	return nil
}

// removeCursorTrustMarker deletes dir's trust marker when AO seeded it. A
// missing, unreadable-as-JSON, or non-AO marker is left untouched. The
// storage dir itself is removed only when the marker was its last content.
func removeCursorTrustMarker(dir string) error {
	markerPath := filepath.Join(dir, cursorTrustMarkerName)
	data, err := os.ReadFile(markerPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("cursor: read trust marker: %w", err)
	}
	var marker struct {
		TrustMethod string `json:"trustMethod"`
	}
	if err := json.Unmarshal(data, &marker); err != nil || marker.TrustMethod != cursorTrustMethodAO {
		return nil
	}
	if err := os.Remove(markerPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("cursor: remove trust marker: %w", err)
	}
	_ = os.Remove(dir) // best-effort: clears the dir only when now empty
	return nil
}
