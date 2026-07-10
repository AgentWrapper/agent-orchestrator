# In-place session workspaces

Tracks GH #174 — "Sessions must start at the project root, not daemon-created worktrees".

## Problem

The daemon unconditionally creates a git worktree per session under
`~/.ao/data/worktrees/<project>/<session>` (workers) or
`.../<project>/orchestrator/<prefix>-orchestrator` (orchestrators), and checks
out an `ao/<sid>/root` branch there. Worktree-per-session is not configurable:
`gitworktree.Workspace.managedPath` branches only on `cfg.Kind`.

For a fleet whose SDLC skills create and own their own task worktrees off the
shared repo root, this produces a second, redundant checkout per session
(double dependency install), hides sessions from the harness's
working-directory-keyed session picker, and splits branch/worktree ownership
between the daemon and the skills.

## Settled behavior

A project selects a **workspace mode**. Two modes:

| Mode                 | Session cwd                  | Daemon-created branch | Daemon-created worktree |
| -------------------- | ---------------------------- | --------------------- | ----------------------- |
| `worktree` (default) | `~/.ao/data/worktrees/…`     | `ao/<sid>/root`       | yes                     |
| `in-place`           | the project path (repo root) | none                  | none                    |

`in-place` means the daemon _starts_ the session at the repo root and nothing
more. It never checks out a branch there, never writes to it, and never removes
it. The shared root stays read-only ground truth; task worktrees remain the
SDLC skill's job.

### Config shape

Top-level default plus a per-role override, mirroring how `agent` /
`agentConfig` already resolve (role value wins, else top-level, else built-in
default).

```go
// domain/projectconfig.go
type WorkspaceMode string

const (
    WorkspaceModeWorktree WorkspaceMode = "worktree" // default
    WorkspaceModeInPlace  WorkspaceMode = "in-place"
)

type ProjectConfig struct {
    // …
    Workspace    WorkspaceMode `json:"workspace,omitempty"`
    Worker       RoleOverride  `json:"worker,omitempty"`
    Orchestrator RoleOverride  `json:"orchestrator,omitempty"`
}

type RoleOverride struct {
    Harness     AgentHarness  `json:"agent,omitempty"`
    Workspace   WorkspaceMode `json:"workspace,omitempty"`
    // …
}

// ResolveWorkspaceMode mirrors ResolveReviewerHarness.
func (c ProjectConfig) ResolveWorkspaceMode(kind SessionKind) WorkspaceMode
```

Resolution: `roleOverride(kind, cfg).Workspace` → `cfg.Workspace` →
`WorkspaceModeWorktree`.

**The default is `worktree`.** The zero value is today's behavior, so existing
projects and upstream installs are unchanged on upgrade. This fleet opts in per
project; the diff stays upstream-shaped (repo rule: backend changes are
upstream-shaped only, upstream PR opened regardless).

### The mode is persisted per session, not looked up per restore

`Manager.Restore` / `RestoreAll` never persist the cwd — they **recompute** it
via `workspace.Restore` → `managedPath` (`manager.go:1663`). If the mode were
read from project config at restore time, flipping a project to `in-place`
would relocate already-running `worktree` sessions to the repo root on the next
daemon restart — the rug-pull that #174 forbids.

So the resolved mode is written to session metadata at spawn and read back on
restore:

```go
type SessionMetadata struct {
    Branch        string        `json:"branch,omitempty"`
    WorkspacePath string        `json:"workspacePath,omitempty"`
    WorkspaceMode WorkspaceMode `json:"workspaceMode,omitempty"`
    // …
}
```

The zero value (`""`) reads as `worktree`, so every session that exists today
keeps its worktree across the upgrade with no migration. The "existing live
sessions unaffected" criterion falls out of the zero value rather than a
special case.

`ports.WorkspaceConfig` and `ports.WorkspaceInfo` both carry `Mode` so the
adapter branches on an explicit value. Inferring in-place from
`Path == repoPath` would be implicit and would break the moment a project's
managed root nests under its repo.

## Behavior per path

### Spawn

- Resolve mode from project config + session kind; persist it in metadata.
- `in-place`: `workspace.Create` resolves the project's repo path, verifies it
  is a git repo, and returns it as the workspace. No `git worktree add`, no
  branch. `SessionMetadata.Branch` is empty.
- An explicit `ao spawn --branch <b>` under `in-place` is a **hard error**, not
  a silent ignore. Honoring it would mean checking out a branch in the shared
  root, which is precisely what the mode forbids.

### Provisioning

`provisionWorkspace` (symlinks + `postCreate`) is **skipped** in `in-place`
mode. Symlinking into the shared root would write to read-only ground truth,
and `postCreate` would re-run per session against a tree the operator already
provisioned.

### Reconcile and shutdown

`SaveAndTeardownAll` (`manager.go:1409`) and `reconcileLive`
(`manager.go:1480`) currently early-skip any session whose `Branch` is empty.
That guard exists to skip half-spawned sessions with incomplete metadata — but
an `in-place` session legitimately has no branch, so it would fall through both
paths: never marked terminated, never restored, left looking live forever.

The guard becomes mode-aware: skip on empty `WorkspacePath`, and additionally
on empty `Branch` **only in `worktree` mode**.

For an `in-place` session whose runtime is gone:

- **No `StashUncommitted`.** The shared root is not the session's private tree;
  a preserve ref built from it would capture whatever the operator or another
  agent happens to have in flight. There is nothing session-scoped to save.
- **No `ForceDestroy`.** The repo root is never removed.
- Still `MarkTerminated`, still destroy the runtime handle.
- A `session_worktrees` row is still written, with `PreservedRef` and `Branch`
  empty. The row is the **"torn down by this daemon run, relaunch me"** signal —
  it is what `RestoreAll` keys on, and without it a restarted daemon cannot
  distinguish a session it just tore down from one a user killed last week.
  What does _not_ apply to `in-place` is the worktree-restore _semantics_
  (stash → recreate worktree → `ApplyPreserved`), not the marker row itself.

An alive runtime is adopted unchanged, exactly as today.

### Persisting the mode through the lifecycle manager

`lifecycle.mergeMetadata` copies a fixed list of `SessionMetadata` fields; a
field absent from that list is discarded on its way to the store. `MarkSwitched`
likewise copies fields one by one. Both must be taught `WorkspaceMode`, or the
mode set at spawn never reaches the DB, persists as `""`, normalizes back to
`worktree` on the next restore, and relocates an in-place session into a
worktree it never had.

The merge is not a plain string copy: the zero value is meaningful (it _is_ the
back-compat reading of `worktree`), so only a **known** mode may overwrite the
base. `WorkspaceMode.IsKnown()` gates both assignments.

### Harness switching

`SwitchHarness` gates on a non-empty branch and rebuilds metadata, so it needs
the same treatment as restore: mode-aware incomplete-handle guard, `Mode`
threaded into `workspace.Restore` on the terminated-relaunch path, and
`WorkspaceMode` carried into both `MarkSwitched` payloads. Without it an
in-place session is un-switchable, and a live switch silently drops the mode.

### Agent hooks in the shared root

`prepareWorkspace` still runs in `in-place` mode: it installs AO's agent hooks,
which the harness needs to report session ids and activity back to the daemon.
This is the one daemon write into the project path, and it is deliberate.

It is safe because the hook payload is session-agnostic
(`GetAgentHooks` ignores the session id), the target is the untracked
`.claude/settings.local.json`, and the write goes through
`hookutil.AtomicWriteFile` (temp file + rename). Concurrent in-place spawns
therefore converge on identical content and cannot tear the file. The narrow
residual is a lost update if a user edits that file in the same instant a
session spawns — the same read-modify-write window that already exists today,
not one this change introduces.

### Restore

- `Manager.Restore`'s `ErrIncompleteHandle` guard requires a non-empty
  `Branch` only in `worktree` mode.
- `workspace.Restore` under `in-place` returns the repo path without touching
  git.
- `ApplyPreserved` is skipped when the preserved ref is empty (already the
  case for clean worktrees; `in-place` always takes this path).
- The session relaunches at the project path via the existing `restoreArgv`.

### Cleanup

`Manager.Cleanup` must never call `workspace.Destroy` on an `in-place`
workspace — `Destroy` is a no-op for that mode. Two reasons: the repo root is
git's main worktree (`git worktree remove` refuses it anyway), and because every
`in-place` session shares one path, the existing `liveWorkspacePaths` guard
would otherwise report each terminated session as permanently `Skipped`.

## Orphaned daemon worktrees

Switching a project to `in-place` strands the daemon worktrees of sessions that
were spawned in `worktree` mode. Nothing is rug-pulled: those sessions carry
`workspaceMode = "worktree"` (or, if they predate the column, `""`, which
normalizes to worktree), so they keep restoring into their own trees until they
end. Their worktrees are then reclaimed by the ordinary path:

```sh
ao session cleanup            # removes worktrees of terminated sessions
```

`ao session cleanup` calls the non-force `Destroy`, so a stranded tree holding
uncommitted work is reported as skipped and preserved, never discarded. That is
the desired behavior — an agent's unpushed work outlives its session.

Trees whose sessions are already gone from the DB are not `ao`'s to find — the
session DTO does not expose `workspacePath`, so the orphan set has to be derived
from git plus the live session ids. Detection is read-only; run it first.

```sh
REPO_ROOT=<repo-root>
MANAGED="$HOME/.ao/data/worktrees"

# 1. Sessions the daemon still considers live.
ao session ls --json | jq -r '.data[] | select(.isTerminated | not) | .id' | sort -u > /tmp/live-ids

# 2. Worker worktrees git has registered under the managed root. The second
#    grep anchors on the managed root: a bare "/orchestrator/" would also match
#    the operator's own $HOME (/home/orchestrator/...) and silently match
#    everything.
git -C "$REPO_ROOT" worktree list --porcelain \
  | awk '/^worktree /{print $2}' \
  | grep "^$MANAGED/" \
  | grep -vE "^$MANAGED/[^/]+/orchestrator/" \
  | sort -u > /tmp/managed-wts

# 3. Registered but owned by no live session, annotated with dirtiness.
while read -r wt; do
  b=$(basename "$wt")
  grep -qx "$b" /tmp/live-ids || \
    printf '%-72s %s dirty file(s)\n' "$wt" "$(git -C "$wt" status --porcelain | wc -l)"
done < /tmp/managed-wts
```

Then remove only the clean ones. `git worktree remove` without `--force`
refuses a tree with uncommitted work, so the dirty ones survive by construction:

```sh
while read -r wt; do
  b=$(basename "$wt")
  grep -qx "$b" /tmp/live-ids || git -C "$REPO_ROOT" worktree remove "$wt"
done < /tmp/managed-wts
git -C "$REPO_ROOT" worktree prune
```

Never add `--force` here. A tree git refuses holds an agent's unpushed work;
resolve it by hand.

Session branches (`ao/<sid>/root`) outlive their worktrees. They are cheap to
keep and are the only pointer to a preserved ref if a cleanup went wrong —
delete them only after confirming the branch is merged or empty.

## Test plan

- `domain`: `ResolveWorkspaceMode` precedence (role → top-level → default);
  `Validate` rejects unknown modes; config JSON round-trip; `WithDefaults`.
- `gitworktree`: `Create`/`Restore` under `in-place` return the repo path,
  create no branch and no worktree; `Destroy`/`ForceDestroy`/`StashUncommitted`
  are no-ops; `Create` errors when the repo path is not a git repo.
- `session_manager`: spawn (worker + orchestrator) in both modes; `--branch`
  under `in-place` errors; provisioning skipped; `reconcileLive` adopt-alive and
  terminate-dead for `in-place`; `SaveAndTeardownAll` no longer skips
  branch-less in-place sessions; `RestoreAll` relaunches an `in-place` session
  at the project path; `Cleanup` never destroys the repo root; a session with
  empty persisted `workspaceMode` still restores into its worktree (no
  rug-pull).
- `cli`: `--config-json` round-trip; `dto_drift_e2e_test` parity for the new
  fields.

## Rollout

Code lands with the default unchanged (`worktree`), so merging is inert. The
fleet flip is a separate, operator-run config change.

`ao project set-config --config-json` unmarshals into a hand-maintained mirror
of `ProjectConfig` in `cli/project.go`, so a key absent from that mirror is
**silently dropped** — the go-live command below would have been a no-op. The
mirror carries `workspace` at both levels, and `dto_drift_e2e_test.go` now
drives `set-config` end-to-end so the next dropped field fails CI instead of
shipping.

```sh
ao project get agent-orchestrator --json          # read current config
ao project set-config agent-orchestrator \
  --config-json '<merged config with "workspace":"in-place">'
```

Verification of in-place spawn/restore/reconcile happens against a throwaway
scratch project, not the live `agent-orchestrator` project, so no running worker
is disturbed.

`backend/internal/session_manager/**` is a sensitive path: autonomous merge
parks this PR for a human.
