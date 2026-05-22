# PR #1466 — Review State, Risks, Edge Cases

What reviewers cared about, where the bodies are buried, and what to verify before claiming done. Companion to [`main.md`](./main.md) and [`architecture.md`](./architecture.md).

---

## Review state at a glance

This PR has been through **11+ review rounds** across multiple reviewers (humans + Copilot bot). The commit log reflects this — see group L "Review fixes" in `pr-1466.html` (Commit Story tab). Treat any new feedback as the 12th round, not the 1st.

**Reviewer focus areas, in descending order of attention:**
1. `migrate-storage/` — the migration + rollback machinery. Most reviewed; most edge cases filed.
2. Cross-project CLI semantics (`ao stop` / `ao start` / Ctrl+C) — behavioral correctness around `last-stop.json`.
3. Status / lifecycle dual-truth elimination — making sure no consumer still reads `previousStatus`.
4. Worktree path safety during migration — git config rewriting.
5. Dashboard sidebar scoping regression.

---

## Edge cases handled (do not regress)

The migration machinery survived a brutal review pass. The PR has explicit handlers for **at least 21 named edge cases**, codified mostly in commit `64caef04` ("EC-1..EC-8, EC-14, EC-27") and follow-ups. The ones to keep in mind when changing this code:

| ID / theme | Scenario | Where handled |
|------------|----------|---------------|
| EC-1 | V1 root has both new and legacy directories simultaneously | `migrate-storage/inventory.ts` |
| EC-2 | macOS case-insensitive filesystem collision (`Foo` vs `foo`) | `64caef04` |
| EC-3 | Git worktree files contain absolute paths to old location | `ff61ee97` |
| EC-7 | Re-running migration on a partially-migrated tree | `880930a2` (`.migrated` markers, prevent `.migrated.migrated`) |
| EC-8 | Active sessions exist during migration | Pre-flight check, **bypassed only for `--dry-run`** (`c800c89c`) |
| EC-14 | Corrupt or unparseable session JSON | Whitelisted JSON parse with rejection (`fd4f969f`) |
| EC-27 | Rollback after partial success — preserve already-migrated worktrees | `fd4f969f` |
| — | Stray worktree recursion (worktree containing worktree path) | `ff61ee97` |
| — | Empty / orphaned archive directories | Archive removal commits (group C) |
| — | Stale `running.json` from previous crashed `ao start` | Auto-pruned on next read (pre-existing, kept) |
| — | High-entropy test placeholders triggering gitleaks | `31b20ed2`, `3e23c8db` (targeted regex) |
| — | Two `ao migrate-storage` runs racing | File-locked global config writes (`bb4c68fc`) |
| — | Partial failure in one project — others succeed | Per-project transaction isolation |
| — | `ao start <project>` after `ao stop <project>` hits "already running" | `removeProjectFromRunning()` + `projectNeedsRestart` gate |
| — | `projectNeedsRestart` false-triggers on path/URL args | `isProjectId` guard: `!isRepoUrl(arg) && !isLocalPath(arg)` |
| — | Ctrl+C leaves tmux orphans | Signal handler mirrors full `ao stop` cleanup (`b4feda79`) |

Each of these has at least one test. **If you change `migrate-storage/`, run** `pnpm --filter @aoagents/ao-core test` **and read the failures carefully** — they're load-bearing.

---

## Hot zones — touch with care

These files have subtle invariants and high blast radius. State which invariants you preserve when modifying them (per `CLAUDE.md`).

### `packages/core/src/migrate-storage/`
- The order of operations in the per-project transaction is checkpointed for rollback. Reordering = corruption on partial failure.
- The `.migrated` marker scheme — re-runs depend on it.
- Git worktree path rewriting regex — intentionally narrow. Broadening it has caused data loss before (`ff61ee97`).
- Atomic write helpers (temp + rename). Don't substitute direct `fs.writeFile`.

### `packages/core/src/lifecycle-state.ts` + `lifecycle-manager.ts`
- `state` + `reason` are the source of truth. **Never persist legacy `SessionStatus`.**
- `deriveLegacyStatus` is a *display-only* read function. Don't introduce write paths through it.
- State transitions have implicit dependencies — see CLAUDE.md "Working Principles → Think Before Coding."

### `packages/core/src/session-manager.ts`
- `sm.list()` reconciles stale runtimes (`runtime_lost`) — this is what keeps the dashboard honest. Don't short-circuit it.
- No more archive lookup paths. If you find yourself wanting one, you're solving the wrong problem.

### `packages/cli/src/commands/start.ts` (includes stop logic — there is no `stop.ts`)
- `last-stop.json` schema includes `otherProjects` for cross-project restore. Adding fields → bump schema, write a migration test.
- `ao stop <project>` (with arg) **must not** kill the parent process or the dashboard. There's a regression test for this; it caught a real bug (`95cf979d`).
- `ao stop <project>` calls `removeProjectFromRunning(projectId)` — removing the project from `running.json` so that `ao start <project>` can restart. The `projectNeedsRestart` gate in `ao start` depends on this.
- Ctrl+C handler has a **10s hard timeout**. Don't remove — cleanup hangs are real.
- The `projectNeedsRestart` gate uses an `isProjectId` guard (`!isRepoUrl && !isLocalPath`) to avoid false triggers when `projectArg` is a filesystem path or URL.

### `packages/cli/src/lib/running-state.ts`
- Advisory lockfile system (`O_EXCL` atomic creation) with jittered backoff and dead-owner cleanup.
- `removeProjectFromRunning()` — surgically removes a project from `running.json.projects[]`. 6 dedicated tests cover targeted vs full stop semantics.

### `packages/web/src/components/Dashboard.tsx`
- Sidebar must show all sessions across all projects, regardless of `projectId`. Per-project filtering happens client-side via `projectSessions` (see commit `53e8476f`).
- SSE 5s interval is hard-coded by constraint C-14. Don't change.

---

## Known risks at handoff

Things to verify still hold when you pick this up:

1. **Upstream drift.** This PR has been merged with `upstream/main` multiple times. Run `git fetch upstream && git log --oneline upstream/main ^storage-redesign` — if the result is non-empty, plan a merge before pushing.
2. **Migration on real user data.** All migration tests use synthetic fixtures. Before merge, the author validated against personal `~/.agent-orchestrator/` once. Worth re-verifying on any reviewer's machine.
3. **The `last-stop.json` ↔ `running.json` interaction.** If `ao start` crashes between writing `running.json` and the restore prompt, the next `ao start` will see both files. Current behavior: prompt restore, then proceed. Verify this is still the case.
4. **Dashboard during migration.** If the user has the dashboard open while running `ao migrate-storage`, the SSE stream may briefly 404 on a session whose path moved. Pre-existing tolerance handles it; don't tighten the error UI.
5. **Plugin authors with hardcoded `storageKey`.** External plugins that built against the old type may break. Search consumer plugins for `storageKey` references. Within this monorepo, all plugins are clean.

---

## Verification checklist before claiming "done"

Before pushing to `storage-redesign` or merging the simulation branch:

```bash
# Full pre-flight
pnpm install
pnpm build
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm --filter @aoagents/ao-web test
pnpm test:integration   # only if your change touches CLI / lifecycle / migration
```

**Manual smoke tests (do not skip if you touched CLI or migration):**

1. Fresh `~/.agent-orchestrator/`:
   - `ao start` → spawn a session → `ao stop` → `ao start` → confirm restore prompt → accept → session resumes.
2. Cross-project:
   - Register two projects in global config.
   - Spawn a session in each.
   - `ao stop` (no args) — both die. `last-stop.json` has both.
   - `ao start` from project A — restore prompt offers both, including project B's.
3. `ao stop <projectB>` from inside project A — only project B's sessions die. Dashboard + parent process untouched.
4. Ctrl+C in `ao start` — sessions die, `last-stop.json` written, no tmux orphans (`tmux ls` is empty).
5. Migration on a V1 layout snapshot:
   - `ao migrate-storage --dry-run` → review plan.
   - `ao migrate-storage` → V2 layout exists, archive content folded into `sessions/`, no orphan files.
6. Dashboard:
   - Multi-project sidebar shows all projects' sessions when filter changes.
   - Restore button works on a terminated session.

---

## Things reviewers explicitly rejected

If you're tempted to do any of these, *don't* — they were proposed in earlier rounds and shot down:

- Adding a configurable archive directory ("for users who want to keep an archive"). Plugin slot, not config.
- Keeping `SessionStatus` as a "compatibility field." It was the source of bugs; it stays derived-only.
- Using a database. AO is flat-file by design.
- Rebasing the PR. The merge commits from upstream are intentional — they preserve review context.
- Splitting the PR. Tried earlier; storage + migration + status + CLI are too entangled.

---

## When in doubt

1. Re-read `CLAUDE.md` "Working Principles."
2. Read the relevant commit message — they're detailed for this PR.
3. Search the PR conversation on GitHub: https://github.com/ComposioHQ/agent-orchestrator/pull/1466
4. Bias toward simplification (per `feedback_simplify_backend` memory). The backend is already lean after this PR; keep it that way.
