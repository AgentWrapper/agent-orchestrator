# PR #1466 — Architecture Changes

What this PR changes, in the order you should learn it. Companion to [`main.md`](./main.md) and [`review-and-risks.md`](./review-and-risks.md).

---

## 1. Storage layout: V1 → V2

### V1 (before — `upstream/main`)

```
~/.agent-orchestrator/
  {hash}-{projectId}/                # hash = SHA-256 of config dir
    sessions/                        # active session metadata (key=value flat files)
    worktrees/{sessionId}/
    archive/{sessionId}_{ts}/        # terminated sessions copied here
```

- `storageKey` = `{hash}-{projectId}` was the primary key threaded through every session.
- Archive was a *second place* to look for terminated sessions — restore/status had dual lookup paths.

### V2 (after — `storage-redesign`)

```
~/.agent-orchestrator/
  config.yaml                        # global registry of all projects
  running.json                       # current ao start PID/port
  last-stop.json                     # NEW — sessions killed by ao stop / Ctrl+C
  projects/
    {projectId}/                     # projectId = {basename}_{hash}
      sessions/{sessionId}.json      # JSON metadata, terminated sessions stay here
      worktrees/{sessionId}/
```

**Key shifts:**
- One canonical directory per project — no more `{hash}-{projectId}` wrapper.
- `projectId` is now a *deterministic, human-readable, collision-safe* identifier: `{basename}_{8-char-hash}`. Duplicate basenames get suffixed automatically.
- Session metadata is JSON files (`.json` extension), not flat key-value blobs.
- `archive/` is gone. Terminated sessions stay in `sessions/` with a terminated lifecycle state.
- `storageKey` is fully removed from the type system. Any reference is dead code.

### Path helpers (where to read/write)

`packages/core/src/paths.ts`:
- `getProjectSessionsDir(projectId)` — replaces `getActiveMetadataDir(storageKey)`.
- `getProjectWorktreesDir(projectId)` — replaces worktree path under `{hash}-{projectId}`.
- Archive helpers (`getArchiveDir`, etc.) are **removed**. If you see one, it's dead.

---

## 2. Project identity (hashed)

`projectId` shape: `{sanitized-basename}_{8-char-sha256-prefix}`

Example: a config at `/Users/harshit/work/agent-orchestrator/agent-orchestrator.yaml` → `projectId = "agent-orchestrator_a1b2c3d4"`.

Properties:
- **Deterministic** — same path always yields the same id.
- **Collision-safe** — different paths with the same basename get distinct hashes.
- **Suffix allocation on duplicates** — if you have two checkouts with the same basename in the global config, the loader allocates `name_2`, `name_3`, etc. (see commit `f7118ef1`).
- **Sanitization** — basenames are stripped of dots and unsafe chars before hashing (commit `27666c6e`).

Where it's used:
- Storage paths (above)
- `agent-orchestrator.yaml` → global config registration
- Web tmux session resolution (commit `eca3001c` handles legacy wrapped keys for backward compat)
- `ao status`, `ao stop <project>`, `ao spawn` — all key off `projectId`

**Invariant:** one `projectId` ↔ one canonical orchestrator session per project. Enforced in `f674422a`.

---

## 3. Session lifecycle: dual-truth elimination

### Before

Sessions persisted **both** a `SessionStatus` enum (`spawning | working | pr_open | merged | killed | …`) **and** a lifecycle `state` + `reason`. They drifted. Restore code had to reconcile them. Tests asserted on whichever was easier.

### After

Source of truth is **`lifecycle-state.ts`**:
- `state`: `not_started | working | idle | needs_input | stuck | detecting | done | terminated`
- `reason`: `manually_killed | runtime_lost | agent_process_exited | probe_failure | error_in_process | auto_cleanup | pr_merged`

Legacy `SessionStatus` is **derived** at read time via `deriveLegacyStatus(state, reason, prState)` — used only for display backward-compat. Never persisted.

Practical consequences:
- `previousStatus` arguments throughout the codebase are gone (commit `e9d9c762`).
- Restore now resets lifecycle cleanly, including for previously-merged PRs (commits `d22f0c6f`, `b178eb66`, `fc6fd88b`).
- Stale runtime detection: `sm.list()` checks if the tmux/process backing each session is still alive during enrichment. Dead ones get persisted as `runtime_lost` → legacy status `killed`. Without this, sessions whose runtime died silently would show "active" forever (commit `9e2df894`).

---

## 4. Migration: V1 → V2 with rollback

The single most-reviewed code in the PR. Lives in `packages/core/src/migrate-storage/`.

### Command

```bash
ao migrate-storage --dry-run       # show planned actions
ao migrate-storage                 # execute (atomic per-project, with rollback on failure)
```

### What it does

1. **Detect V1 layout** — looks for `{hash}-{projectId}/` directories at the AO root.
2. **Inventory** — enumerates sessions, worktrees, archives, validates each against Zod schemas.
3. **Plan** — computes target paths under `projects/{newProjectId}/`. Detects macOS case-insensitive collisions before writing anything.
4. **Execute, atomically per project:**
   - Convert flat-file metadata → JSON.
   - Move worktrees, rewriting any embedded paths in git config.
   - Flatten `archive/` contents back into `sessions/` with terminated lifecycle.
   - Mark the source dir as `.migrated` so re-runs don't re-process it (commit `880930a2` prevents `.migrated.migrated`).
5. **Rollback** if any step fails: restore originals, repair git worktrees (the trickiest part — `worktree` files contain absolute paths that need rewriting).

### Safety guarantees (commits handling each)

- File-locked global config updates so two `ao migrate-storage` runs can't race.
- Atomic writes: temp file + rename, never partial overwrites (`bb4c68fc`).
- macOS case-insensitive collision detection (`64caef04`).
- Worktree path rewriting handles recursion and stray paths (`ff61ee97`).
- Active session check is **skipped** during `--dry-run` so users can plan without killing sessions (`c800c89c`).
- Rollback preserves worktrees that were already migrated successfully (`fd4f969f`).
- Graceful errors: `b18cbe22` — failed migration shows actionable message instead of stack trace.
- 21+ named edge cases handled: see `handoff/pr-1466/review-and-risks.md`.

### Things to NOT touch in `migrate-storage/`

- The order of operations in the per-project transaction. Each step is checkpointed for rollback.
- The `.migrated` marker scheme.
- Git worktree path rewriting — the regex is intentionally narrow.

---

## 5. Cross-project CLI rework

### `ao stop`

**Note:** There is no `stop.ts` — the stop command is defined inside `packages/cli/src/commands/start.ts`.

| Invocation | Before | After |
|------------|--------|-------|
| `ao stop` | Kills only the most-recently-active orchestrator. Saw only local config (1 project). | Loads global config, kills **all** sessions across **all** registered projects. Stops parent process + dashboard. Writes `last-stop.json` with `{ projectId, sessionIds[], otherProjects: [...] }` for restore. |
| `ao stop <project>` | Same as above (no scoping). | Surgical: kills only `<project>`'s sessions. **Does not** kill parent process or dashboard (commit `95cf979d` — this was a real bug). Falls back to global config if `<project>` isn't in the local config (`2db2951a`). Calls `removeProjectFromRunning(projectId)` to remove the project from `running.json` so that a subsequent `ao start <project>` can restart without hitting the "already running" gate. |

### `ao start`

- Reads `last-stop.json` on startup. If it has sessions, prompts: **"Restore N sessions from your last shutdown?"** — including cross-project ones (`8b130964`).
- Loads global config for cross-project session-manager access during restore.
- Skips orchestrator restore if `ensureOrchestrator()` already restored it (avoids double-spawn).
- **`projectNeedsRestart` gate:** If `ao start <project>` is called and the project was removed from `running.json` by a prior `ao stop <project>`, the "already running" menu is bypassed and the orchestrator is re-created for that project. An `isProjectId` guard ensures this only triggers for project ID arguments (not filesystem paths or repo URLs).
- Project picker now offers "Add this project" when launched in an unregistered cwd (`d6a56a8f`, `e1ecc091`).
- Auto-registers a flat local config on first `ao start` if missing (`1972fa30`).

### `Ctrl+C` (signal handler in `ao start`)

Mirrors `ao stop` exactly: kills all sessions, writes `last-stop.json`, unregisters `running.json`. Implementation uses an async IIFE inside the sync signal handler (Node.js signal handlers are sync — `process.exit()` must be called explicitly since registering a handler removes the default exit behavior). 10s hard timeout via `setTimeout().unref()` in case cleanup hangs (`b4feda79`). Before this PR, Ctrl+C left tmux orphans.

### Tab completions

`packages/cli/completions/` — merge global + local config so tab completion shows every registered project, not just those in the current `agent-orchestrator.yaml` (`39ebb07f`).

---

## 6. Web dashboard changes

Minimal but important:
- **Sidebar:** always shows all sessions across all projects, regardless of which project is active. Per-project filtering is applied at the kanban level via `projectSessions = sessions.filter(s => s.projectId === projectId)`. (`53e8476f`)
- **Tmux session resolver:** handles the legacy wrapped storage key (`{hash}-{projectName}`) so dashboards open mid-migration don't break (`eca3001c`).
- No new UI component libraries, no inline styles — design system unchanged.

---

## 7. Archive removal — what to grep for

If you see any of these in the codebase, they're dead and should be deleted (or you're on the wrong branch):

```
getArchiveDir
ArchivedSessionMetadata
listArchive
moveToArchive
archive: true
```

The cleanup spans 11 commits (group C in `pr-1466.html` → Commit Story tab). Tests and docs were updated in lockstep.

---

## 8. New runtime artifacts

| File | Lifetime | Written by | Read by |
|------|----------|------------|---------|
| `~/.agent-orchestrator/config.yaml` | Persistent | `ao start` (auto-register), `ao spawn`, manual edits | All CLI commands needing cross-project visibility, tab completions |
| `~/.agent-orchestrator/running.json` | Lives while `ao start` is running | `ao start` (register), `ao stop`/Ctrl+C (unregister), `ao stop <project>` (removes project via `removeProjectFromRunning`) | `ao status`, `ao spawn`, dashboard, `ao start` (checks for already-running + `projectNeedsRestart` gate) |
| `~/.agent-orchestrator/last-stop.json` | Cleared after restore prompt | `ao stop`, Ctrl+C | `ao start` |

---

## 9. Things that intentionally did NOT change

- The 8-slot plugin system. No new plugins, no interface breakage.
- SSE 5s polling interval (CLAUDE.md C-14).
- The dashboard component library (no new deps; CLAUDE.md C-01).
- The lifecycle polling loop in `lifecycle-manager.ts` — only its inputs (state model) changed.
- The agent plugin contract (Claude Code, Codex, Aider, OpenCode all unchanged at the interface level).

If you find yourself touching any of the above to "fix" something, stop and re-read the original review thread on the PR — the answer is almost always "no, work around it."
