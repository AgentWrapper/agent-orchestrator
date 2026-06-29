# Core Package Deep Audit

Audited all files in `packages/core/src/`. Below are identified issues organized by severity.

---

## Critical

### C-01: Race condition in `reserveSessionId` — TOCTOU between metadata file operations

**File:** `metadata.ts:379-389`

```typescript
export function reserveSessionId(dataDir: string, sessionId: SessionId): boolean {
  const path = metadataPath(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
```

`O_EXCL` correctly makes the reservation itself atomic, but the caller in `session-manager.ts` (`reserveNextSessionIdentity`, line 812-853) reads all existing sessions first via `listMetadata` + `listArchivedSessionIds`, then iterates to find the next available number, then calls `reserveSessionId`. Between the list scan and the reserve call, another process could have reserved the same number. The loop retries with `num += 1` up to 10,000 times, so this is self-healing for small numbers of concurrent spawns, but under high concurrency (many `ao spawn` processes launched simultaneously), sessions will get very high numbers unnecessarily, and in pathological cases all 10,000 attempts could fail.

**Reproduction:** Run 5+ concurrent `ao spawn` commands against the same project simultaneously. Session IDs will skip numbers or (in extreme cases) throw "Failed to reserve session ID after 10000 attempts."

**Suggested fix:** Use a filesystem lock (e.g., `proper-lockfile` or `flock`) around the entire number-selection-and-reservation sequence, or use an atomic counter file.

---

### C-02: `list()` creates a new `fetchOpenCodeSessionList` promise but races multiple sessions against it

**File:** `session-manager.ts:1771-1797`

```typescript
let openCodeSessionListPromise: Promise<OpenCodeSessionListEntry[]> | undefined;

const tasks = allSessions.map(async ({ sessionName, projectId: sessionProjectId, raw }) => {
  // ...
  const sessionListPromise =
    effectiveAgentName === "opencode"
      ? (openCodeSessionListPromise ??= fetchOpenCodeSessionList())
      : undefined;
  // ...
});
```

The `??=` operator ensures only one promise is created, but the promise is shared across all opencode sessions. If `fetchOpenCodeSessionList` is called once and resolves, subsequent calls within the same `list()` invocation reuse the result — which is correct. However, if the first call fails (throws), the `??=` will NOT re-trigger (the variable is still assigned the rejected promise). Any subsequent opencode sessions in the same `list()` call will get the same rejected promise.

**Reproduction:** Have 2+ opencode sessions, and have the `opencode session list --format json` command fail once (e.g., timeout). All opencode sessions in that `list()` call fail to discover their session IDs.

**Suggested fix:** Reset `openCodeSessionListPromise = undefined` on rejection:
```typescript
const sessionListPromise = effectiveAgentName === "opencode"
  ? (openCodeSessionListPromise ??= fetchOpenCodeSessionList().catch(err => {
      openCodeSessionListPromise = undefined;
      throw err;
    }))
  : undefined;
```

---

### C-03: `determineStatus` mutates the `session` parameter in place — shared reference risk

**File:** `lifecycle-manager.ts:486-527`

```typescript
async function determineStatus(session: Session): Promise<DeterminedStatus> {
  // ...
  session.lifecycle = lifecycle;  // line 516
  session.status = decision.status;  // line 517
  session.activitySignal = activitySignal;  // line 518
```

The `determineStatus` function mutates the `session` object directly. In `pollAll`, sessions are obtained from `sessionManager.list()`, and each is passed to `checkSession` → `determineStatus`. If `list()` returns the same session object reference (which it can due to caching in `listCached`), mutations from one poll cycle can bleed into the next if the cache is still valid. Additionally, within a single `pollAll`, multiple references to the same session could theoretically exist.

**Reproduction:** With cache TTL of 35s and poll interval of 30s, two consecutive polls could return the same object from cache. The second poll's `determineStatus` would see state already mutated by the first poll's `checkSession`.

**Suggested fix:** Clone the session object at the top of `checkSession` before passing to `determineStatus`, or have `determineStatus` return a new object instead of mutating.

---

### C-04: `updateSessionMetadata` reads from `session.lifecycle` after it was mutated by `determineStatus`

**File:** `lifecycle-manager.ts:1073-1101`

```typescript
function updateSessionMetadata(session: Session, updates: Partial<Record<string, string>>): void {
  // ...
  const lifecycleUpdates = buildLifecycleMetadataPatch(
    cloneLifecycle(session.lifecycle),  // reads already-mutated lifecycle
    session.status,                     // reads already-mutated status
  );
```

Because `determineStatus` mutates `session.lifecycle` and `session.status` in place (C-03), when `updateSessionMetadata` is called later in `checkSession`, it reads the **new** lifecycle, not the one that was on disk. This means `buildLifecycleMetadataPatch` computes a diff against the already-updated in-memory state, which is correct for persistence but makes it impossible to detect what the previous state was (e.g., for auditing).

This is partially mitigated by `previousLifecycle = cloneLifecycle(session.lifecycle)` being captured at line 1659 before `determineStatus` runs. But any code path that calls `updateSessionMetadata` without first cloning the lifecycle will silently use the wrong state.

**Suggested fix:** Make `determineStatus` return a new lifecycle/status instead of mutating the session object.

---

## High

### H-01: `atomicWriteFileSync` temp file name collision across processes

**File:** `atomic-write.ts:8-11`

```typescript
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}
```

Two processes with the same PID (e.g., inside containers) calling `atomicWriteFileSync` at the same millisecond will produce the same temp file name. While unlikely, PID reuse + same millisecond means one process overwrites the other's temp file before rename. The `Date.now()` granularity is milliseconds, so two calls within the same millisecond from the same PID will also collide.

**Reproduction:** Two Docker containers with PID 1 writing metadata for different sessions in the same directory at the same time.

**Suggested fix:** Add `Math.random()` or `randomBytes(4).toString("hex")` to the temp file name.

---

### H-02: `deleteMetadata` uses non-atomic read-then-write for archiving

**File:** `metadata.ts:263-276`

```typescript
export function deleteMetadata(dataDir: string, sessionId: SessionId, archive = true): void {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return;

  if (archive) {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(archiveDir, `${sessionId}_${timestamp}`);
    writeFileSync(archivePath, readFileSync(path, "utf-8"));  // non-atomic read then write
  }

  unlinkSync(path);
}
```

Between `readFileSync(path, ...)` and `unlinkSync(path)`, another process could update the metadata file. The archive would contain stale data, and the new data would be lost. This is a classic TOCTOU race.

**Reproduction:** Kill a session while the lifecycle manager is simultaneously updating its metadata. The archive may miss the last update.

**Suggested fix:** Use `renameSync` to move the file to the archive directory (rename is atomic on the same filesystem), then rename it to include the timestamp.

---

### H-03: `kill()` calls `findSessionRecord` which does metadata repair — potential double-repair race

**File:** `session-manager.ts:1884-1995`

```typescript
async function kill(sessionId: SessionId, options?: KillOptions): Promise<KillResult> {
  const located = findSessionRecord(sessionId);
  // ...
  const existingLifecycle = parseCanonicalLifecycle(raw);
  if (existingLifecycle?.session.state === "terminated") {
    try {
      deleteMetadata(sessionsDir, sessionId, true);
    } catch {
      // Already archived by a racing caller.
    }
    return { cleaned: false, alreadyTerminated: true };
  }
```

If two concurrent `kill()` calls race for the same session (e.g., lifecycle manager's auto-cleanup and a manual `ao kill`), both could pass the "already terminated" check before either archives the metadata. The second `deleteMetadata` would archive a second copy with a different timestamp. This is benign but wasteful. More concerning: `findSessionRecord` calls `repairSingleSessionMetadataOnRead`, which writes to the metadata file. If both calls are repairing simultaneously, they could interleave writes.

**Suggested fix:** Use a per-session lock or make the terminated check + archive operation atomic.

---

### H-04: `sessionFromMetadata` creates `PRInfo` with empty required fields

**File:** `utils/session-from-metadata.ts:65-79`

```typescript
pr: prUrl
  ? (() => {
      const parsed = parsePrFromUrl(prUrl);
      return {
        number: lifecycle.pr.number ?? parsed?.number ?? 0,
        url: prUrl,
        title: "",
        owner: parsed?.owner ?? "",
        repo: parsed?.repo ?? "",
        branch: meta["branch"] ?? "",
        baseBranch: "",
        isDraft: prIsDraft,
      };
    })()
  : null,
```

When `parsePrFromUrl` returns null (e.g., malformed URL), `owner` and `repo` are set to empty strings. These empty-string PRInfo objects are then passed to SCM plugin methods like `detectPR`, `getPRState`, `getCISummary`, etc. SCM plugins that don't guard against empty owner/repo will make API calls with empty parameters, causing confusing errors.

**Reproduction:** Set `pr=https://example.com/not-a-real-pr` in session metadata. The next lifecycle poll will attempt to fetch PR state with `owner=""` and `repo=""`.

**Suggested fix:** Return `null` for PRInfo when `parsePrFromUrl` returns null and no lifecycle PR number exists, or at minimum validate owner/repo are non-empty before constructing PRInfo.

---

### H-05: `getActivityFallbackState` can return `active` for entries that were actually `idle`

**File:** `activity-log.ts:170-207`

```typescript
export function getActivityFallbackState(
  activityResult: { entry: ActivityLogEntry; modifiedAt: Date } | null,
  activeWindowMs: number,
  thresholdMs: number,
): ActivityDetection | null {
  // ...
  const ageMs = Math.max(0, Date.now() - entryTs.getTime());
  let ageState: ActivityState;
  if (ageMs <= activeWindowMs) ageState = "active";
  // ...
  const activityRank: Record<string, number> = { active: 0, ready: 1, idle: 2 };
  const entryRank = activityRank[entry.state] ?? 2;
  const ageRank = activityRank[ageState] ?? 2;
  const finalState = ageRank >= entryRank ? ageState : entry.state;
```

If the entry state is `"idle"` (rank 2) and the age is fresh (< activeWindowMs, so ageState is "active", rank 0), then `ageRank (0) >= entryRank (2)` is false, so `finalState = entry.state = "idle"`. That's correct. BUT if the entry state is `"ready"` (rank 1) and the age is fresh, ageRank (0) < entryRank (1), so `finalState = entry.state = "ready"`. This is also correct.

However, if the entry state is `"exited"` (not in the rank map, defaults to 2) and the age is fresh, `finalState = "exited"`. This is correct. But if entry state is `"blocked"` (not in the rank map, defaults to 2) and the age is fresh, `finalState = "blocked"` — but the staleness check above should have caught it. **The problem is `exited` falls through to the age-based decay path at all.** The function doesn't handle `exited` specially, so a fresh `exited` entry could be returned from the fallback. The caller (`getActivityState` in agent plugins) already handles `exited` before calling the fallback, so this is a defense-in-depth concern.

**Suggested fix:** Add `exited` to the early-return path or skip the fallback for `exited` entries.

---

### H-06: `enrichSessionWithRuntimeState` overwrites lifecycle runtime state without considering prior state

**File:** `session-manager.ts:1108-1126`

```typescript
// Activity detection reads JSONL files on disk
session.activitySignal = createActivitySignal("unavailable");
if (plugins.agent) {
  try {
    const detected = await plugins.agent.getActivityState(session, config.readyThresholdMs);
    if (detected !== null) {
      session.activitySignal = classifyActivitySignal(detected, "native");
      session.activity = detected.state;
      session.lifecycle.runtime.state = "alive";      // line 1114
      session.lifecycle.runtime.reason = "process_running";  // line 1115
      session.lifecycle.runtime.lastObservedAt = new Date().toISOString(); // line 1116
```

If the runtime was already confirmed dead by the `isAlive()` check above (lines 1067-1098), and then `getActivityState` returns a non-null result (e.g., from a stale JSONL file), the code at line 1114 **overrides** the dead runtime state back to `"alive"`. The early return at line 1091 should prevent this (it returns after setting exited), but only for the `!alive` case. If the `isAlive` check threw an error (caught at line 1093), execution continues to the activity detection block, which could then overwrite `"probe_failed"` with `"alive"`.

**Reproduction:** A tmux session dies but the agent's JSONL file still exists. `isAlive` throws (e.g., tmux server temporarily unavailable), setting runtime state to `probe_failed`. Then `getActivityState` reads the stale JSONL and the code overwrites runtime state to `alive`.

**Suggested fix:** Guard the `lifecycle.runtime.state = "alive"` assignment with a check that runtime isn't already in a terminal/error state: `if (lifecycle.runtime.state !== "missing" && lifecycle.runtime.state !== "probe_failed")`.

---

### H-07: `parseKeyValueContent` doesn't handle values containing `#`

**File:** `key-value.ts:6-18`

```typescript
export function parseKeyValueContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}
```

Values containing `#` are fine (they're after the `=`), but keys containing `#` would be treated as comments. More importantly, if a value starts with `#` (e.g., `issue=#1234`), the entire line is skipped as a comment because `trimmed.startsWith("#")` is checked before the `=`. This would cause `issue=#1234` to be silently ignored.

**Reproduction:** Create a metadata file with `issue=#1234`. The issue field will not be read.

**Suggested fix:** Move the comment check after the `=` parsing — only treat a line as a comment if it starts with `#` AND has no `=` before the `#`.

---

## Medium

### M-01: `parseTmuxName` regex ambiguity with hyphenated prefixes

**File:** `paths.ts:161-174`

```typescript
export function parseTmuxName(tmuxName: string): {
  hash: string; prefix: string; num: number;
} | null {
  const match = tmuxName.match(/^([a-f0-9]{12})-([a-zA-Z0-9_-]+)-(\d+)$/);
```

The `prefix` group `([a-zA-Z0-9_-]+)` is greedy. For a tmux name like `a3b4c5d6e7f8-my-app-orchestrator-3`, the regex would match `prefix = "my-app-orchestrator"` and `num = "3"`. But for `a3b4c5d6e7f8-my-app-3-5`, the greedy match would give `prefix = "my-app-3"` and `num = "5"`, which is incorrect — the actual prefix is `"my-app"` and the session number is `3-5` (which is invalid anyway). This is a design flaw in the tmux naming convention: without a delimiter between prefix and number, the greedy regex can misparse.

**Suggested fix:** Use a non-greedy match for prefix, or better, use a different delimiter (e.g., `@` or `~`) between prefix and number in the tmux naming convention.

---

### M-02: `generateSessionPrefix` CamelCase heuristic matches single-uppercase-letter words

**File:** `paths.ts:55-78`

```typescript
export function generateSessionPrefix(projectId: string): string {
  // ...
  const uppercase = projectId.match(/[A-Z]/g);
  if (uppercase && uppercase.length > 1) {
    return uppercase.join("").toLowerCase();
  }
```

A project named `APIserver` would get prefix `"as"`, which could collide with another project named `AgentServer` (also `"as"`). The heuristic only works well for true CamelCase (2+ uppercase letters with mixed case between them). Single-uppercase followed by lowercase like `Python` would not match (only 1 uppercase), which is correct.

**Suggested fix:** Consider using the first 3-4 characters for CamelCase words instead of just the uppercase letters, or add a collision detection step.

---

### M-03: `resolvePREnrichmentDecision` doesn't pass `prChecks` from batch enrichment

**File:** `lifecycle-status-decisions.ts:352-372`

```typescript
export function resolvePREnrichmentDecision(
  cachedData: PREnrichmentData,
  options: Pick<OpenPRDecisionInput, "shouldEscalateIdleToStuck" | "idleWasBlocked" | "activityEvidence">,
): LifecycleDecision {
```

The `PREnrichmentData` type includes `ciChecks?: CICheck[]`, but `resolvePREnrichmentDecision` only uses `ciStatus` (derived from `CI_STATUS.FAILING`). Individual CI check names are lost in the decision, so when the lifecycle manager uses this decision, the CI failure details (check names, URLs) are not available. The CI failure details are fetched separately in `maybeDispatchCIFailureDetails`, so this is not a functional bug, but it means the batch enrichment's CI check data is redundant with the later fetch.

**Suggested fix:** This is a design observation rather than a bug. Consider threading `ciChecks` through the decision or documenting that CI details are always fetched separately.

---

### M-04: `maybeAutoCleanupOnMerge` uses `session.activity` which may not be refreshed

**File:** `lifecycle-manager.ts:1585-1586`

```typescript
const activity = session.activity;
const agentIsBusy =
  activity === ACTIVITY_STATE.ACTIVE ||
  activity === ACTIVITY_STATE.WAITING_INPUT ||
  activity === ACTIVITY_STATE.BLOCKED;
```

After `determineStatus` runs, `session.activity` is not updated — only `session.activitySignal` is set. The `session.activity` field is set by `enrichSessionWithRuntimeState` in `session-manager.ts`, not by the lifecycle manager. So if the lifecycle manager's `determineStatus` detected the agent as active via activity signal but `session.activity` is still `null` from the metadata read, the agent would not be considered busy, and cleanup would proceed prematurely.

**Reproduction:** Session with merged PR where the agent is still running (active). If `session.activity` was never set (null from metadata), the agent won't be considered busy, and `kill()` will be called while the agent is still working.

**Suggested fix:** Derive `agentIsBusy` from `session.activitySignal` instead of `session.activity`, or update `session.activity` based on `session.activitySignal` after `determineStatus`.

---

### M-05: `repairSessionMetadataOnRead` can cause excessive I/O on every `list()` call

**File:** `session-manager.ts:564-664`

```typescript
function repairSessionMetadataOnRead(
  sessionsDir: string,
  records: ActiveSessionRecord[],
  sessionPrefix?: string,
): ActiveSessionRecord[] {
```

This function iterates all session records, checks for lifecycle migration, and writes updated metadata for every record that needs repair. On a project with 50+ sessions, every `list()` call triggers this repair path. If most sessions need repair (e.g., after an upgrade), this means 50+ synchronous file writes per `list()` call, which blocks the entire polling cycle.

Additionally, `repairSingleSessionMetadataOnRead` is called for each orchestrator session, writing metadata even if nothing changed (the `Object.keys(updates).length === 0` check prevents the write in that case, but the lifecycle migration check at line 586-602 does NOT have this guard — it always writes if `stateVersion !== "2"`).

**Reproduction:** After upgrading AO, all sessions will have `stateVersion !== "2"`. Every `list()` call re-writes all session metadata until the lifecycle is migrated.

**Suggested fix:** After successful migration, set `stateVersion: "2"` so subsequent reads skip the migration. Also batch the writes or rate-limit repairs.

---

### M-06: `send()` confirmation loop uses deprecated `detectActivity` — can misclassify

**File:** `session-manager.ts:2373-2413`

```typescript
const detectActivityFromOutput = (output: string) => {
  if (!output) return null;
  try {
    return agentPlugin.detectActivity(output);  // deprecated method
  } catch {
    return null;
  }
};
```

The send confirmation relies on `detectActivity` (deprecated terminal-parsing method) to detect delivery. If the agent plugin's `detectActivity` doesn't correctly classify the current agent output (which is likely, since it's deprecated), the confirmation loop may falsely determine the message was delivered, or conversely, loop all 6 attempts without confirming.

**Suggested fix:** Use `getActivityState` or compare raw output differences instead of `detectActivity` for confirmation.

---

### M-07: `populatePREnrichmentCache` only matches PRs to projects via `repo` field

**File:** `lifecycle-manager.ts:360-381`

```typescript
const project = Object.values(config.projects).find((p) => {
  if (!p.repo) return false;
  const slashIdx = p.repo.lastIndexOf("/");
  if (slashIdx < 0) return false;
  const owner = p.repo.slice(0, slashIdx);
  const repo = p.repo.slice(slashIdx + 1);
  return owner === pr.owner && repo === pr.repo;
});
```

If no project has a configured `repo` (e.g., project is local-only with no remote), the PR enrichment batch data will be discarded — the PR won't be matched to any plugin. The fallback individual API calls in `checkSession` will still work, but the batch optimization is lost.

Also, if multiple projects share the same repo (monorepo pattern), only the first matching project's SCM plugin is used. Other projects with different SCM plugins won't have their PRs enriched.

**Suggested fix:** For monorepo scenarios, allow multiple SCM plugins to enrich the same PR.

---

### M-08: `observability.ts` snapshot write is not crash-safe

**File:** `observability.ts:337-341`

```typescript
function writeSnapshot(config: OrchestratorConfig, snapshot: ProcessObservabilitySnapshot): void {
  const filePath = getSnapshotPath(config, snapshot.component);
  snapshot.updatedAt = nowIso();
  atomicWriteJson(filePath, snapshot);
}
```

`atomicWriteJson` writes to a temp file then renames. If the process crashes during `writeFileSync` (writing the temp file), a stale temp file is left on disk. Over time, these accumulate. The code doesn't clean up `.tmp.*` files on startup.

**Suggested fix:** Add cleanup of stale `.tmp.*` files during startup.

---

### M-09: `orchestratorSessionStrategy` normalizes `"delete-new"` and `"ignore-new"` but their semantics differ

**File:** `orchestrator-session-strategy.ts:3-11`

```typescript
export function normalizeOrchestratorSessionStrategy(
  strategy: ProjectConfig["orchestratorSessionStrategy"] | undefined,
): NormalizedOrchestratorSessionStrategy {
  if (strategy === "kill-previous" || strategy === "delete-new") return "delete";
  if (strategy === "ignore-new") return "ignore";
  return strategy ?? "reuse";
}
```

`"delete-new"` is normalized to `"delete"`, but the original `"delete"` strategy deletes existing sessions before spawning. `"delete-new"` was presumably intended to mean "delete the new session if there's a collision" — the opposite behavior. The normalization conflates two potentially different strategies.

**Suggested fix:** If the semantics are actually the same (delete existing orchestrator sessions), document this. If they differ, implement them separately.

---

### M-10: `readAgentReportAuditTrail` reads entire audit file into memory

**File:** `agent-report.ts:296-311`

```typescript
function appendAgentReportAuditEntry(...): void {
  // ...
  if (existsSync(auditFilePath)) {
    const current = readFileSync(auditFilePath, "utf8");
    let entries = current.split("\n").filter((line) => line.length > 0)
      .slice(-(AGENT_REPORT_AUDIT_MAX_ENTRIES - 1));
```

On every audit append, the entire audit file is read into memory, split, filtered, and potentially rewritten. While the max size is 256KB, this is unnecessary I/O for an append operation. The rotation logic is also inconsistent: the size check at line 313 happens after the rewrite logic at lines 299-318, so both paths can execute.

**Suggested fix:** Use a simpler append-only approach with a separate rotation check. Only rotate when the file exceeds the max size, and rotate by truncating the front of the file.

---

### M-11: `checkBlockedAgent` is a no-op for the current `AGENT_REPORTED_STATES`

**File:** `report-watcher.ts:166-192`

```typescript
export function checkBlockedAgent(
  _session: Session,
  report: AgentReport | null,
  now: Date,
  config: ReportWatcherConfig,
): ReportAuditResult | null {
  // ...
  if (report.state === "needs_input") {
    // returns agent_needs_input trigger
  }

  // Note: "blocked" is not in the current AGENT_REPORTED_STATES but we check for it
  // in case it gets added or for forward compatibility
  return null;
```

The function only triggers for `"needs_input"` state. The `"waiting"` state (which means the agent is blocked on external dependencies) is not checked here. This means a stuck agent that reported `"waiting"` will only be caught by the stale report check (after 30 minutes), not immediately.

**Suggested fix:** Consider adding `"waiting"` to the blocked agent check, or document that `waiting` agents are only caught by staleness detection.

---

### M-12: `serializeMetadata` in metadata.ts replaces newlines with spaces — information loss

**File:** `metadata.ts:47-54`

```typescript
function serializeMetadata(data: Record<string, string>): string {
  return (
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v.replace(/[\r\n]/g, " ")}`)
      .join("\n") + "\n"
  );
}
```

Newlines in values are silently replaced with spaces. This means if an agent's summary or user prompt contains newlines, they're lost on write. When read back, the data is different from what was written.

**Reproduction:** Set `userPrompt` to a multi-line string. After write + read, newlines are replaced with spaces.

**Suggested fix:** Use an escape sequence (e.g., `\n`) instead of replacing with spaces, or use a different serialization format for values that may contain newlines.

---

### M-13: `list()` race with metadata mutation — no locking between read and enrichment

**File:** `session-manager.ts:1762-1830`

The `list()` method reads all metadata files, then asynchronously enriches each session (checking runtime liveness, getting activity state, etc.). During the async enrichment, the metadata files can be updated by the lifecycle manager's polling loop (which runs concurrently). The session objects returned by `list()` may reflect a mix of old and new state: old metadata with new activity state, or vice versa.

**Reproduction:** Run `ao status` while the lifecycle manager is actively updating session metadata. The displayed data may be inconsistent (e.g., showing `status: working` but `activity: exited`).

**Suggested fix:** Accept this as inherent to the eventually-consistent design (file-based, no database), but document it. Consider snapshotting the metadata read timestamp for diagnostics.

---

### M-14: `feedback-tools.ts` not audited

This file was not listed in the original source file list (`find` output) but is exported from `index.ts`. It should be audited for the same categories of issues.

---

## Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| Critical | 4 | Race conditions in session ID reservation, shared promise failures, in-place mutation of session objects |
| High | 7 | Atomic write collisions, TOCTOU in archiving, double-kill races, empty PRInfo fields, activity state overwrites |
| Medium | 14 | I/O patterns, naming ambiguity, stale data handling, semantic conflation, information loss |

**Most impactful issues to fix first:**
1. **C-03/C-04** — In-place mutation of session objects by `determineStatus` is the root cause of multiple subtle state bugs
2. **H-06** — Activity detection overriding confirmed-dead runtime state
3. **C-02** — Shared OpenCode promise that can't recover from failure
4. **H-04** — Empty PRInfo fields causing silent API failures
