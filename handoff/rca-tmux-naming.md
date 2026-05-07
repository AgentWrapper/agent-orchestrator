# RCA: tmux session naming inconsistency (`int-1` / `ao-172` vs `c13a0108f64e-int-1`)

**Status:** Investigation complete. **No regression in code.** The "bare" name format is the current intentional design. However, the investigation surfaced a **separate, real bug**: the bare format is not collision-safe across multiple `agent-orchestrator.yaml` checkouts on the same machine that share a `sessionPrefix`.

---

## TL;DR

- The premise that hash-prefixed tmux names (`{hash}-{prefix}-{num}`) are the *expected* format is **outdated**.
- That format was the design under PR #58 (Feb 2026, `59971029`), but it was **explicitly removed** in PR #1466 (`refactor(core): storage redesign — projectId-based paths, JSON metadata`, commit `36fed87b`, merged Apr 28 2026, shipped in `v0.4.0`).
- The current intentional format is `{sessionPrefix}-{num}` (workers) and `{sessionPrefix}-orchestrator` (orchestrators). See `paths.ts:206-212` and `types.ts:1741`.
- All hash-prefixed sessions in the user's `tmux list-sessions` output were created **before** the v0.4.0 upgrade (or before that version reached the running orchestrator) and were never killed — tmux session names are baked in at creation time and don't get renamed on a code upgrade.
- Worker spawn and orchestrator spawn both use the new format. There is **no asymmetry** between `ao spawn` and `ao start`, and no asymmetry between orchestrator and worker code paths.
- **Newly identified concern (not the original report's bug, but a real one):** removing the hash prefix means tmux names are no longer globally unique across multiple config checkouts on the same machine. Two clones of a project sharing the same `sessionPrefix` will both try to claim e.g. `int-orchestrator` and the second `ao start` will fail in `tmux new-session` with a duplicate-name error.

---

## Code path (worker spawn)

`session-manager.ts:803-841` — `reserveNextSessionIdentity` for workers:

```ts
const sessionId  = `${project.sessionPrefix}-${num}`;
const tmuxName   = project.path
  ? generateSessionName(project.sessionPrefix, num)   // → "{prefix}-{num}"
  : undefined;
```

`paths.ts:206-212`:

```ts
/**
 * Generate user-facing session name.
 * Format: {prefix}-{num}     // ← no hash prefix by design
 * Example: "int-1", "ao-42"
 */
export function generateSessionName(prefix: string, num: number): string {
  return `${prefix}-${num}`;
}
```

`paths.ts:214-228` confirms the deprecation by retaining the old function only as `generateTmuxName` (now deprecated):

```ts
/**
 * @deprecated Session prefixes are globally unique — hash prefix is no longer needed.
 * Use generateSessionName(prefix, num) instead (same output as the new tmux name).
 *
 * Generate tmux session name (legacy format with hash).
 * Format: {storageKey}-{prefix}-{num}
 */
export function generateTmuxName(storageKey, prefix, num) { ... }
```

`types.ts:1737-1748`:

```ts
/**
 * Session metadata stored as JSON files under projects/{projectId}/sessions/.
 * Session files are named with user-facing session IDs (e.g., "ao-1.json").
 * The tmuxName field matches the session ID (e.g., "ao-1") — no hash prefix.
 */
```

The runtime is invoked at `session-manager.ts:1296` with `sessionId: tmuxName ?? sessionId` — both values are identical here (bare format), so the fallback is a no-op.

## Code path (orchestrator spawn)

`session-manager.ts:843-858` — `reserveFixedOrchestratorIdentity`:

```ts
const sessionId = getOrchestratorSessionId(project);     // → "{prefix}-orchestrator"
return { sessionId, tmuxName: config.configPath ? sessionId : undefined };
```

`orchestrator-session-strategy.ts:5-7`:

```ts
export function getOrchestratorSessionId(project) {
  return `${project.sessionPrefix}-orchestrator`;
}
```

So orchestrator tmux names are also bare. There is no code path that *currently* produces a hash-prefixed name.

## Persisted metadata confirms the new format

| Session  | `tmuxName` field on disk | tmux list output | Created                | Project          |
| -------- | ------------------------ | ----------------- | ---------------------- | ---------------- |
| `int-1`  | `"int-1"`                | `int-1`           | 2026-05-06             | integrator       |
| `ao-169` | `"ao-169"`               | `ao-169`          | 2026-05-06             | agent-orchestrator |
| `ao-172` | `"ao-172"`               | `ao-172`          | 2026-05-07             | agent-orchestrator |
| `ao-1`   | `"ao-1"`                 | (not running)     | 2026-05-04             | agent-orchestrator |

All metadata files live under `~/.agent-orchestrator/projects/{projectId}/sessions/` (also projectId-based, no hash directory).

## Affected sessions on this machine

Bare format (correct, post-v0.4.0):
- `int-1` (May 6, attached) — the originally reported session
- `ao-169` (May 6) — terminated after PR merge, tmux pane lingering
- `ao-172` (May 7) — this very session
- `ao-orchestrator` (May 6), `int-orchestrator` (May 4), `mer-orchestrator` (May 4)
- `ao-inttest-prompt-interactive-1776810270335` (Apr 22) — integration-test artifact

Hash-prefixed format (legacy, pre-v0.4.0 or transition window):
- `c13a0108f64e-int-{1,6,9}`, `c13a0108f64e-integrator-{8,10,11}`, `c13a0108f64e-integrator-int-10` (Apr 9–24)
- `5526214ea6a9-csf-{1,2,3,8}`, `5526214ea6a9-csf-orchestrator-{1,2}` (Apr 16) — `csf` project no longer in global config
- `15c372b67170-ao-168` (May 4) — created before this machine's running ao process picked up the v0.4.0 build
- `e920a3a2a0d6-mer-orchestrator` (May 4) — same explanation

The rough cutover lines up with `36fed87b` (merged Apr 28, 2026) and the `v0.4.0` release (`ef8ac42d`). Sessions started by older binaries kept their old names; new spawns get bare names. tmux does not rename existing sessions retroactively.

## Hypotheses tested

| Hypothesis                                                         | Result                                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `int-1` was created before a hash-prefix change was introduced     | **Inverted.** It was created *after* a hash-prefix *removal*. The bare name is correct. |
| Worker vs orchestrator code path skips the hash                    | **No.** Both paths use the new bare format consistently.                                |
| `restore` reuses an old non-hashed tmux name from legacy metadata  | Not applicable — `int-1` was created fresh on May 6, no restore.                        |
| `claim-pr` / takeover bypasses the naming logic                    | Not applicable — this session was a fresh spawn.                                        |
| `ao spawn` (worker) skips the prefix while `ao start` (orchestrator) keeps it | **Disproven.** All orchestrators on this machine *also* use bare format (`ao-orchestrator`, `int-orchestrator`, `mer-orchestrator`). The hashed orchestrator (`e920a3a2a0d6-mer-orchestrator`) is just a stale tmux session from an older binary. |

## Reproduction (showing this is the *correct* behavior)

```
git rev-parse HEAD                                  # any commit ≥ 36fed87b
ao spawn agent-orchestrator                         # creates session metadata
tmux list-sessions | grep ao-                       # shows "ao-{N}" (bare)
cat ~/.agent-orchestrator/projects/agent-orchestrator/sessions/ao-{N}.json | jq .tmuxName
# → "ao-{N}"
```

To produce a hash-prefixed session, you would have to check out a commit prior to `36fed87b`, build, and spawn — i.e., run an older AO version.

---

# Newly identified bug — tmux name collision risk

The user's follow-up question prompted this section: *"if I start multiple orchestrators on the same project, they will end up trying to start the same tmux session name. Isn't this a bug?"*

## Within a single AO config (controlled — not a bug)

Inside one `agent-orchestrator.yaml`, this is handled:

- `reserveFixedOrchestratorIdentity` calls `reserveSessionId(sessionsDir, sessionId)` (`session-manager.ts:847-852`); a second `ao start` against the same config goes through `ensureOrchestrator()` which honors `orchestratorSessionStrategy: reuse | delete | ignore`. Default is `reuse`.

So same-config double-start is fine.

## Across different AO configs sharing a `sessionPrefix` (real collision)

There is **no global registry** of tmux session names or `sessionPrefix` values. Two checkouts on the same machine with the same `sessionPrefix` will both:

1. Try to write metadata to *their own* `~/.agent-orchestrator/projects/{projectId}/sessions/` directory — these don't collide because the projectId path differs.
2. Call `runtime.create({ sessionId: "{prefix}-{num}" })` → `tmux new-session -d -s {prefix}-{num}` — these **do** collide because tmux session names are global per user.

The tmux plugin (`packages/plugins/runtime-tmux/src/index.ts:65`) calls `tmux new-session -d -s sessionName` directly without a pre-check. tmux will reject the duplicate with a "duplicate session" error, and the spawn fails. Looking at `session-manager.ts:826-828`, the worker numbering avoids local collisions by scanning the local sessions dir, but it **does not consult tmux** for occupancy, so the reserved number can still collide with another checkout's tmux session.

Worker example: checkout A spawns workers 1-5 (uses `int-1` … `int-5`). Checkout B's local sessions dir is empty, so it reserves `int-1` and tries `tmux new-session -d -s int-1` → fails because checkout A already owns that name. The user sees a confusing error at spawn time.

Orchestrator example: same as above with `int-orchestrator`. The second `ao start` fails with a tmux error rather than a clean message.

This regression was introduced by the same PR (#1466) that removed the hash prefix. The deprecation comment in `paths.ts:215` claims "Session prefixes are globally unique — hash prefix is no longer needed." That assumption only holds within a single config, not across multiple checkouts on a machine.

## Suggested fix (recommendation only — do not implement without approval)

A few options, in order of preference:

1. **Restore a short discriminator in tmux names** while keeping `sessionId` (and metadata filename) as the bare `{prefix}-{num}`. Concretely: tmux name = `{6-char-projectId-hash}-{prefix}-{num}`, but the persisted `tmuxName` field is what the runtime keys off of, so internal lookups stay correct. This decouples tmux global namespace from session-ID namespace and reverses the assumption made in #1466. Cleanest fix; preserves the projectId-based metadata layout and avoids cross-checkout collisions.

2. **Pre-check tmux occupancy when reserving identities** (`reserveNextSessionIdentity` and `reserveFixedOrchestratorIdentity`) and skip numbers that are already alive in tmux. Solves worker collisions but not orchestrator (which has a fixed name); still hits a hard failure on orchestrator collision unless we also fall back to a different name.

3. **Document the constraint** that `sessionPrefix` must be globally unique per machine and refuse to register a project whose prefix is already used by another config. Not great UX — silently couples projects across unrelated repos.

Recommendation: **option 1**. The hash discriminator on tmux names is cheap and was load-bearing for cross-checkout isolation. The PR #1466 deprecation note ("session prefixes are globally unique") understates the invariant — it's only enforced *per config*.

I have not implemented this fix. The change touches `session-manager.ts`, `paths.ts`, and a few test fixtures that pin tmux names; it is not a one-liner and per the task instructions I should recommend, not implement.

---

## Memory follow-up

`MEMORY.md` currently states *"Hash-based metadata paths. #58 migrated from flat to hash-based project isolation. All path resolution goes through `resolveMetadataPath()`."* This is **stale** as of v0.4.0 (PR #1466 reverted the hash-based paths to projectId-based paths and removed `storageKey` entirely). I will update memory after this report is filed.
