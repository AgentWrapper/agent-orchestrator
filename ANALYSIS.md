# Core Engine Deep Analysis

Comprehensive audit of `packages/core/src/` — bugs, race conditions, performance issues, error handling gaps, and state corruption risks.

**Auditor:** Claude (automated static analysis)
**Date:** 2026-04-26
**Codebase snapshot:** `session/ao-7` branch at `64badbd`

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 6 |
| Medium | 9 |
| Low | 8 |
| **Total** | **25** |

---

## Critical

### C-01: Read-modify-write race in `updateMetadata` allows data loss across processes

**File:** `metadata.ts:163-171`
**Impact:** Session metadata can be silently lost when AO and agent scripts (via PATH wrappers) write concurrently.

`updateMetadata` does `readFileSync` → merge → `atomicWriteFileSync`. While the final write is atomic (rename), the read-merge-write sequence is not. Two concurrent writers (AO lifecycle poll + agent's `gh pr create` wrapper) can interleave:

```
Process A: reads {status=working, pr=}
Process B: reads {status=working, pr=}
Process A: writes {status=working, pr=https://...}   // PR URL written
Process B: writes {status=ci_failed, pr=}             // PR URL lost!
```

The `atomicWriteFileSync` temp-file-rename pattern prevents torn writes but not lost updates. This is the most likely cause of intermittent "PR disappeared from dashboard" reports.

**Fix:** Use `flock()` or `O_EXCL` + retry (compare-and-swap) around the read-merge-write cycle. Alternatively, use `mkdir` as a lock primitive since it's atomic on POSIX.

### C-02: Concurrent `checkSession` calls mutate shared `session` objects via `determineStatus`

**File:** `lifecycle-manager.ts:1984`, `session-manager.ts:1762-1830`
**Impact:** Session state can be corrupted when `Promise.allSettled` processes sessions concurrently and the session objects share references to mutable nested structures.

`pollAll()` calls `sessionManager.list()` to get sessions, then processes them via `Promise.allSettled(sessionsToCheck.map(s => checkSession(s)))`. Each `checkSession` calls `determineStatus(session)` which mutates `session.lifecycle`, `session.status`, and `session.activitySignal` in place via the `commit()` closure (lines 516-527).

While each session object is distinct (created fresh by `list()`), the `prEnrichmentCache` map is shared across all concurrent `determineStatus` calls. If `populatePREnrichmentCache` or a lazy individual PR state fetch writes to the cache while a concurrent `determineStatus` is reading it, the `Map` iteration order or value consistency could differ between sessions.

More critically, `sessionManager.invalidateCache()` is called from within `checkSession` (via `updateSessionMetadata`), which means concurrent sessions can invalidate the cache while others are still being processed. This doesn't corrupt the current batch (each session has its own object), but it means the lifecycle manager and dashboard can observe inconsistent snapshots within a single poll cycle.

**Fix:** The enrichment cache should be frozen or made immutable after `populatePREnrichmentCache` completes. Consider making `determineStatus` return a new session object instead of mutating in place.

---

## High

### H-01: `list()` performs expensive runtime probes for every session on every lifecycle poll

**File:** `session-manager.ts:1762-1830`, `lifecycle-manager.ts:1968`
**Impact:** For 20 sessions polling every 30s, this creates 60+ subprocess/IO operations per poll cycle (isAlive, getActivityState, getSessionInfo for each). Users with many sessions see high CPU and slow dashboard responses.

`enrichSessionWithRuntimeState` (line 1051) calls `runtime.isAlive()`, `agent.getActivityState()`, and `agent.getSessionInfo()` for every session. The lifecycle manager calls `list()` (not `listCached()`) on every poll cycle (line 1968), bypassing the 35s cache entirely. The cache only benefits the dashboard's `listCached()` path.

**Fix:** The lifecycle manager should use `listCached()` and only do full enrichment for sessions that need it (non-terminal, recently changed). Or `list()` should accept an options flag to skip enrichment.

### H-02: Phantom sessions from orphaned reservation files

**File:** `metadata.ts:379-389`, `session-manager.ts:1188`
**Impact:** If AO crashes between `reserveSessionId` (creates empty file with O_EXCL) and `writeMetadata` (writes full metadata), an empty metadata file remains. On next `list()`, this appears as a session with all-default values — no workspace, no branch, status "unknown". The lifecycle manager will eventually detect it as dead, but it can appear as a phantom session in the dashboard for one or more poll cycles.

The cleanup path in `spawn()` only runs on explicit errors (workspace creation failure, runtime creation failure). A process crash leaves the empty file with no recovery mechanism.

**Fix:** Add a startup cleanup pass that removes empty or incomplete metadata files (files without a `status` key or `createdAt` field). Or write minimal valid metadata during reservation instead of creating an empty file.

### H-03: Reaction tracker double-counting within a single poll cycle

**File:** `lifecycle-manager.ts:944-945`, `1218-1233`, `1748-1757`
**Impact:** `executeReaction` increments `tracker.attempts++` (line 945) before checking escalation. The same reaction key can be triggered from multiple code paths in a single `checkSession` call: the status transition handler (line 1751) AND `maybeDispatchReviewBacklog` (line 1220). This causes the retry counter to advance faster than configured, leading to premature escalation to human notification.

For example, if a session transitions to `changes_requested` (triggering the reaction from the transition handler) AND the review backlog check finds pending comments (triggering the same reaction again), `tracker.attempts` increments twice in one poll cycle instead of once.

**Fix:** Track whether a reaction was already executed for a given session+key within the current poll cycle. Reset the tracker only once per cycle, not per code path.

### H-04: `applyLifecycleDecision` in `lifecycle-transition.ts` is dead code — never called

**File:** `lifecycle-transition.ts:170-252`
**Impact:** `applyLifecycleDecision` and `applyDecisionToLifecycle` were designed as the central lifecycle mutation boundary (lines 4-8 describe "All lifecycle changes should flow through this module"). However, `lifecycle-manager.ts` uses its own inline `commit()` closure (line 509-527) that calls `commitLifecycleDecisionInPlace` directly, completely bypassing this module's validation, atomic persistence, and observability hooks.

The `lifecycle-transition.ts` module contains careful before/after state capture, validation, and atomic metadata persistence. None of this is used. Instead, the lifecycle manager directly mutates `session.lifecycle` in memory and persists via `updateSessionMetadata`, losing the transactional guarantees this module was designed to provide.

**Fix:** Refactor `checkSession` to use `applyLifecycleDecision` instead of the inline `commit()` closure, or remove the dead code.

### H-05: `isTerminalSession` considers runtime `missing` as terminal, contradicting session restoration semantics

**File:** `types.ts:249-267`
**Impact:** `isTerminalSession` returns `true` when `lifecycle.runtime.state === "missing"` (line 259). But `enrichSessionWithRuntimeState` sets `runtime.state = "missing"` for sessions whose tmux died while the agent is still conceptually active (e.g., agent crashed but PR is open). This makes the session appear terminal to `isRestorable()` and `isTerminalSession()`, but the session's status might still be `ci_failed` or `changes_requested` — non-terminal statuses that the lifecycle manager should continue tracking.

When a session with `runtime.state = "missing"` and `status = "ci_failed"` is checked by `isTerminalSession`, it returns `true`. But the session is actually in an active PR state that needs continued monitoring. The lifecycle manager's `pollAll` filter (line 1973-1977) will skip terminal sessions from tracking, so status transitions back to working (after a restore) won't be detected.

**Fix:** Make `isTerminalSession` check `session.status` in addition to `lifecycle.runtime.state` — only consider runtime-missing as terminal if the session status is also in a terminal state.

### H-06: `parseCanonicalLifecycle` Zod schema is excessively permissive

**File:** `lifecycle-state.ts:45-122`
**Impact:** All sub-objects (`session`, `pr`, `runtime`) use `.partial().optional()`, meaning a `statePayload` of `{"version": 2}` validates successfully. This means a corrupted or truncated payload (e.g., from a partial write during crash) is accepted and silently filled with synthesized defaults rather than being rejected.

The `normalizePayloadLifecycle` function merges the payload with synthesized defaults, so a completely empty payload produces a valid lifecycle that may not match the session's actual state. This can cause the lifecycle manager to derive incorrect statuses.

**Fix:** Make `state` and `reason` required (non-optional) in the Zod schema. Fall back to synthesized lifecycle only when `statePayload` is absent or fails validation, not when it validates but is partially empty.

---

## Medium

### M-01: `deleteMetadata` archive is not crash-safe

**File:** `metadata.ts:263-276`
**Impact:** `deleteMetadata` copies the file to `archive/` then unlinks the original. If the process crashes between the copy (`writeFileSync`) and the unlink, the session appears both active AND archived. On restart, `list()` returns it from the active directory, while `kill()` may find it in the archive and return `alreadyTerminated: true`, causing the auto-cleanup path to skip it.

**Fix:** Write a `.archiving` marker before the copy, then remove it after unlink. On startup, clean up sessions that have `.archiving` markers (either complete the archive or restore from active).

### M-02: `generateSessionPrefix` can produce colliding prefixes

**File:** `paths.ts:55-78`
**Impact:** The prefix generation algorithm uses simple heuristics (uppercase letters, initials, first 3 chars). Two different project names can produce the same prefix (e.g., "PyTorch" → "pt" and "PodcastTracker" → "pt"). While `validateProjectUniqueness` catches this at config load time, the error message is confusing because it references directory basenames rather than the generated prefixes.

**Fix:** Include the prefix in the validation error message so users understand why the collision occurred.

### M-03: Observability snapshot writes are not concurrency-safe

**File:** `observability.ts:418-443`
**Impact:** `updateSnapshot` reads the JSON snapshot, parses, mutates, and rewrites. If two concurrent calls interleave (e.g., from different async operations within the same AO process), one mutation can be lost. Since Node.js is single-threaded, this can't happen within a single event loop tick, but `readSnapshot` and `writeSnapshot` are separate sync calls that could interleave if an `await` were added between them in the future.

**Fix:** Batch mutations and write once at the end of the poll cycle, or use an in-memory snapshot that's periodically flushed.

### M-04: `classifyActivitySignal` creates inconsistent timestamps within a single poll

**File:** `activity-signal.ts:46-90`
**Impact:** `classifyActivitySignal` defaults `now = new Date()`. Called multiple times within a single `determineStatus` call, each invocation gets a slightly different `now`. If a timestamp falls exactly on the boundary between "strong" and "weak" freshness, two calls for the same session could classify the same activity differently.

**Fix:** Accept `now` as a parameter from the caller and pass a single frozen timestamp through the entire `determineStatus` call.

### M-05: `loadActiveSessionRecords` repairs metadata on every read

**File:** `session-manager.ts:666-685`
**Impact:** `repairSessionMetadataOnRead` is called on every `loadActiveSessionRecords` call, which happens on every `list()` call. For sessions that are already repaired, this reads metadata, checks conditions, and writes back — doing unnecessary I/O on every 30-second poll cycle. The `updateMetadataPreservingMtime` call (line 596) preserves mtime, but still does a full read-modify-write cycle.

**Fix:** Add a marker field (e.g., `repairedAt`) to skip already-repaired sessions. Or run repair only once on startup, not on every `list()`.

### M-06: `atomicWriteFileSync` temp file name collision is possible

**File:** `atomic-write.ts:8`
**Impact:** The temp file name `${filePath}.tmp.${process.pid}.${Date.now()}` uses millisecond-precision `Date.now()`. Two calls within the same millisecond from the same process produce the same temp file name. While AO is single-process and typically doesn't write the same file multiple times within 1ms, this could happen during rapid metadata updates (e.g., `applyAgentReport` + `updateSessionMetadata` in quick succession).

**Fix:** Add a counter or use `randomUUID()` for uniqueness.

### M-07: `resolveNotifierTarget` can resolve to a non-existent notifier

**File:** `notifier-resolution.ts:15-31`
**Impact:** When a notifier config key has no `plugin` field and the key itself isn't a registered plugin name, `resolveNotifierTarget` returns `{ reference, pluginName: reference }`. The lifecycle manager then does `registry.get<Notifier>("notifier", target.reference)` which returns `null`, silently dropping the notification. This happens when a user configures `notifiers: { alerts: { url: "..." } }` without specifying `plugin: "slack"` — the `alerts` key is used as both reference and plugin name, but no plugin named "alerts" exists.

**Fix:** Log a warning when `resolveNotifierTarget` falls back to using the reference as a plugin name and the plugin doesn't exist in the registry.

### M-08: `searchUpTree` in `findConfigFile` has no depth limit

**File:** `config.ts:680-697`
**Impact:** The recursive `searchUpTree` function walks up the directory tree until it reaches the root. On a system with a deeply mounted filesystem, this could traverse hundreds of directories before reaching root. While not a security issue, it could cause noticeable delay on `ao` startup if run from a deeply nested path on a slow filesystem.

**Fix:** Add a maximum depth (e.g., 20 levels) to prevent excessive traversal.

### M-09: `applyAgentReport` audit trail is written after the metadata mutation completes

**File:** `agent-report.ts:540`
**Impact:** The audit entry is appended to the `.ndjson` file (line 540) after `mutateMetadata` completes. If the process crashes between the metadata write and the audit append, the audit trail will be missing an entry, making it appear as though the report was never applied. This isn't a data corruption issue, but it breaks the audit trail's completeness guarantee.

**Fix:** Write the audit entry before the metadata mutation, or use a write-ahead log pattern.

---

## Low

### L-01: `serializeMetadata` replaces newlines with spaces, losing multi-line values

**File:** `metadata.ts:47-54`
**Impact:** Values containing `\n` or `\r` are silently converted to spaces. While session metadata typically doesn't contain newlines, the `agentReportedNote` field (set by `ao report ... --note`) could contain multi-line text that gets flattened.

**Fix:** Use a different escaping strategy (e.g., `\n` literal) or document that multi-line values are not supported.

### L-02: `isOrchestratorSession` in `types.ts` uses expensive regex compilation on every call

**File:** `types.ts:336-370`
**Impact:** Each call to `isOrchestratorSession` creates a new `RegExp` object via `new RegExp(...)` with an escaped prefix. This function is called frequently (during session list, lifecycle poll, send, kill). In a hot loop processing many sessions, this creates unnecessary GC pressure.

**Fix:** Cache compiled regexes in a Map keyed by the escaped prefix string.

### L-03: `parseKeyValueContent` doesn't handle values containing `#`

**File:** `key-value.ts:6-18`
**Impact:** Lines starting with `#` are treated as comments (line 10). But a value like `description=Fix #1234` is parsed correctly because only the trimmed line's first character is checked. However, if the key or value part before `=` starts with `#`, it would be skipped. This is unlikely but could cause silent data loss for edge-case metadata values.

**Fix:** Only treat a line as a comment if `#` is the first character AND there is no `=` before it.

### L-04: `listArchivedSessionIds` regex may miss some archived sessions

**File:** `session-manager.ts:370-379`
**Impact:** The regex `/^([a-zA-Z0-9_-]+)_\d/` requires a digit immediately after the underscore. Archive file names use ISO timestamps like `session-1_2026-04-26T10:30:00.000Z`. The regex matches `\d` (a single digit) after the underscore, which works for timestamps starting with a digit (which they always do since years start with 2). However, this regex would miss sessions with IDs that don't match `[a-zA-Z0-9_-]+` — e.g., sessions with dots in their names.

**Fix:** Use the `SESSION_ID_COMPONENT_PATTERN` from `utils/session-id.ts` for consistency, or read the archive directory and parse file names more robustly.

### L-05: `plugin-registry.ts` registers notifier instances under multiple keys

**File:** `plugin-registry.ts:409-417`
**Impact:** `registerNotifier` creates the first registration under both `registration.registrationName` and `manifest.name` (lines 411-414). This means the same notifier instance appears in the registry under two keys. While `list()` deduplicates by manifest name, `get()` returns the same instance from either key. If the same notifier is configured multiple times with different configs, the second config's instance overwrites the first under the manifest name key.

**Fix:** Only register under `registration.registrationName`. The fallback to `manifest.name` should be explicit in the caller, not implicit in the registry.

### L-06: `detectPR` is called even for sessions already in the PR tracking pipeline

**File:** `lifecycle-manager.ts:709-742`
**Impact:** `detectPR` is called when `!session.pr` (line 710), but a session can have `session.pr === null` while its lifecycle already shows `pr.state = "open"` (e.g., after a restore that doesn't preserve the PR object). This results in an unnecessary API call to `scm.detectPR` every poll cycle.

**Fix:** Also check `session.lifecycle.pr.state !== "none"` before calling `detectPR`.

### L-07: `maybeAutoCleanupOnMerge` can double-archive a session

**File:** `lifecycle-manager.ts:1566-1649`
**Impact:** If `kill()` throws after archiving (inside `deleteMetadata(dataDir, sessionId, true)` which archives then deletes), the catch block writes `mergedPendingCleanupSince` metadata. But the session file is already deleted/archived, so `updateMetadata` creates a new file in the sessions directory. On the next poll, the session reappears and cleanup is retried.

**Fix:** Check if the session is already archived before attempting kill, or use `mutateMetadata` with `createIfMissing: false` in the catch block.

### L-08: `synth PR state for `merged` status without PR URL may cause dashboard issues

**File:** `lifecycle-state.ts:210-228`
**Impact:** `synthesizePRState` handles `status === "merged"` without a PR URL by returning `{ state: "merged", reason: "merged", number: null, url: null }`. The dashboard may try to construct a PR link from `null` values, resulting in broken links or crashes.

**Fix:** Ensure dashboard code handles `pr.number === null` and `pr.url === null` gracefully.

---

## Appendix: Positive Observations

The codebase demonstrates several strong engineering practices:

1. **Atomic file writes** via `atomicWriteFileSync` prevent torn reads during crashes
2. **O_EXCL session reservation** prevents concurrent session ID collisions
3. **Canonical lifecycle model** (`CanonicalSessionLifecycle`) provides a clear single source of truth
4. **Activity signal classification** with freshness windows prevents stale signals from overriding live state
5. **Agent report freshness checks** with clock skew tolerance prevent future-dated reports from persisting
6. **Batch PR enrichment** via GraphQL reduces API calls from N×3 to 1 per poll cycle
7. **Metadata repair on read** self-heals legacy orchestrator session records
8. **Path traversal protection** in shell wrappers validates session names and directory roots before writing
9. **Shell injection prevention** via `shellEscape()` (documented and used across plugins)
10. **Graceful degradation** — every plugin call is wrapped in try/catch, failures degrade gracefully rather than crashing
