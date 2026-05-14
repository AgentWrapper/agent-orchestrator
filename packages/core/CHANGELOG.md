# @aoagents/ao-core

## 0.7.0

### Minor Changes

- 0f5ae0b: feat: native Windows support

  AO now runs natively on Windows. The default runtime on Windows is `process`
  (ConPTY via `node-pty` + named pipes — no tmux, no WSL); the dashboard,
  agents (claude-code, codex, kimicode, aider, opencode, cursor), `ao doctor`,
  and `ao update` all work out of the box. Each session gets a small detached
  pty-host helper that wraps a ConPTY behind `\\.\pipe\ao-pty-<sessionId>`,
  registered so `ao stop` can reach it.

  A new cross-platform abstraction layer (`packages/core/src/platform.ts`)
  centralises every platform branch behind helpers like `isWindows()`,
  `getDefaultRuntime()`, `getShell()`, `killProcessTree()`, `findPidByPort()`,
  and `getEnvDefaults()`. Path comparison uses `pathsEqual` /
  `canonicalCompareKey` to handle NTFS case-insensitivity. PATH wrappers for
  agent plugins (`gh`, `git`) ship as `.cjs` + `.cmd` shims on Windows;
  `script-runner` runs `.ps1` siblings of `.sh` scripts via PowerShell. New
  `ao-doctor.ps1` / `ao-update.ps1` shipped.

  `ao open` is now cross-platform: it sources sessions from `sm.list()`
  instead of `tmux list-sessions` (so `runtime-process` sessions on Windows
  appear), and the open action branches per OS — `open-iterm-tab` stays the
  macOS path, native handling on Windows and Linux.

  Behaviour on macOS and Linux is unchanged. Every Windows path is gated
  behind `isWindows()`; `runtime-tmux` and the bash hook flows are untouched.

  See `docs/CROSS_PLATFORM.md` for the developer reference (helper inventory,
  EPERM-vs-ESRCH gotcha, PowerShell-vs-bash differences, pre-merge checklist).
  The Windows runtime architecture (pty-host, pipe protocol, registry, sweep,
  mux WS Windows branch) is documented in `docs/ARCHITECTURE.md`.

- fe33bb7: Worker sessions now learn how to message the orchestrator that spawned them. When a project has an orchestrator running, the worker's system prompt gains a "Talking to the Orchestrator" section with the literal `ao send <prefix>-orchestrator "<message>"` command (rendered at prompt-build time, no env var, no shell-syntax variants). `ao send` itself now auto-prefixes outgoing messages with `[from $AO_SESSION_ID]` when invoked from inside an AO session, so the receiver always knows who's writing — symmetric across worker→orchestrator, orchestrator→worker, and worker→worker. Humans running `ao send` from a normal terminal stay unprefixed. (#1786)
- 7c46dc9: feat(release): weekly release train — channels, onboarding, dashboard banner, cron

  Ships the full release pipeline described in `release-process.html`:
  - **Cron-driven nightly canary.** `.github/workflows/canary.yml` triggers via
    `schedule: '0 18 * * 5,6,0,1,2'` (23:30 IST Fri–Tue) plus `workflow_dispatch`.
    Bake window (Wed–Thu) pauses scheduled nightlies; the captain re-cuts via
    workflow_dispatch when a fix lands. Stable `release.yml` publishes via
    `changesets/action`. `.changeset/config.json` adds the snapshot template
    (`{tag}-{commit}`). `@aoagents/ao-web` stays in the linked group and ships
    alongside `@aoagents/ao-cli` (it's a workspace:_ runtime dep, so marking it
    private would 404 every `npm install -g @aoagents/ao` after publish).
    `scripts/check-publishable-deps.mjs` runs in both release.yml and canary.yml
    before the publish step and fails CI if a publishable package depends on a
    `private: true` package via workspace:_.
  - **Update channels.** New `updateChannel` field in the global config schema
    (`stable | nightly | manual`, default `manual` so existing users see no
    surprise installs). `update-check.ts` reads `dist-tags[channel]` from the
    npm registry, compares prerelease versions segment-by-segment so SHA-suffixed
    nightlies sort correctly, and skips notices entirely on `manual`.
  - **Soft auto-install + active-session guard.** On stable/nightly, `ao update`
    skips the confirm prompt and just installs. Before installing it lists
    sessions and refuses with `N session(s) active. Run \`ao stop\` first.`if
any are in`working`/`idle`/`needs_input`/`stuck`. Same guard duplicated
in `POST /api/update` so the dashboard returns a structured 409.
  - **Onboarding question.** `ao start` prompts once for the channel if unset;
    dismissal persists `manual`. `ao config set updateChannel <value>` (and
    `installMethod`) lets users change it later.
  - **Dashboard banner.** `GET /api/version` reads the same cache file as the
    CLI. `UpdateBanner` (Tailwind only, `var(--color-*)` tokens) appears at the
    top of the dashboard when `isOutdated`. Click POSTs to `/api/update`;
    dismissal persists per-version in `localStorage`.
  - **Bun + Homebrew detection.** New install-method classifiers for
    `~/.bun/install/global/` (auto-installs `bun add -g @aoagents/ao@<channel>`)
    and `/Cellar/ao/` (notice only — `brew upgrade ao` to avoid clobbering
    brew's symlinks). `installMethod` config field overrides path detection.

  Supersedes #1525 (incorporates the canary + release infrastructure with the
  cron / no-stale-SHA-guard / no-merged-PR-comment modifications called out in
  the design doc).

## 0.6.0

### Minor Changes

- Wire activity events into `lifecycle-manager` failure paths so failures surface as activity entries for downstream consumers (#1620).
- 40aeb78: Add optional per-project `env` block to `ProjectConfig` that forwards string-to-string env vars into worker session runtimes (e.g. pin `GH_TOKEN` per project). AO-internal vars (`AO_SESSION`, `AO_PROJECT_ID`, etc.) always take precedence.

### Patch Changes

- Disable the tmux status bar in the runtime-tmux plugin and clean up dead code in core (#1711).
- Disable tmux status bar at session creation (#1683). The change touched dead code; the actual user-visible fix landed in #1711.

## 0.5.0

### Patch Changes

- dd07b6b: Adopt existing managed orchestrator worktrees instead of failing to create a fresh one. Previously, a leftover worktree from a prior run could block `spawnOrchestrator` with a "worktree already exists" error; spawn now detects and reuses the matching managed worktree. Also normalizes CRLF in `parseWorktreeList` (Windows), filters prunable/deleted entries in `findManagedWorkspace`, and applies `GIT_TIMEOUT` to all internal `git()` calls.

## 0.4.0

### Minor Changes

- faaddb1: Sessions whose PRs are detected as merged now auto-terminate (tmux kill + worktree remove + metadata archive) instead of lingering in the active `sessions/` directory with a `merged` status. `ao status` and `ao session ls` stay clean without an external watchdog.

  Enabled by default. Guarded by an idleness check so in-flight agents are not killed mid-task; deferred cleanups retry on each lifecycle poll until the agent idles or a 5-minute grace window elapses.

  Opt out or tune via the new top-level `lifecycle` config in `agent-orchestrator.yaml`:

  ```yaml
  lifecycle:
    autoCleanupOnMerge: false # preserve merged worktrees for inspection
    mergeCleanupIdleGraceMs: 300000 # grace window before forcing cleanup
  ```

  `sessionManager.kill()` now takes an optional `reason` (`"manually_killed" | "pr_merged" | "auto_cleanup"`) and returns `KillResult` (`{ cleaned, alreadyTerminated }`) instead of `void`. All existing call sites ignore the return value so this is backward-compatible in practice.

  Closes #1309. Part of #536.

- 331f1ce: Enrich lifecycle events with PR/issue context for webhook consumers. All events now carry `data.context` with `pr` (url, title, number, branch), `issueId`, `issueTitle`, `summary`, and `branch` when available, plus `data.schemaVersion: 2`.

  Additional changes:
  - Persist `issueTitle` in session metadata during spawn so it survives across restarts and is available for event enrichment.
  - Refactor `executeReaction()` to accept a `Session` object instead of separate `sessionId`/`projectId` arguments.
  - Add `maybeDispatchCIFailureDetails()` — when a session enters `ci_failed`, the agent receives a follow-up message with the failed check names and URLs (deduped via fingerprint so subsequent polls don't re-send the same failure set).
  - `bugbot-comments` reaction dispatches an enriched message listing every automated comment inline, so the agent doesn't need to re-fetch via `gh api`.

- e7ad928: Allow workers to report non-terminal PR workflow events like `pr-created`, `draft-pr-created`, and `ready-for-review` with optional PR URL/number metadata, while keeping merged and closed PR state SCM-owned.

  **Migration:** `Session` now carries canonical lifecycle truth in `session.lifecycle`
  and explicit activity-evidence metadata in `session.activitySignal`. Third-party
  callers that construct `Session` objects directly must populate those fields or
  route through the core session helpers that synthesize them.

- 7b82374: Add centralized lifecycle transitions and report watcher for agent monitoring.
  - **Lifecycle transitions (#137)**: Centralize all lifecycle state mutations through `applyLifecycleDecision()` for consistent timestamp handling, atomic metadata persistence, and observability.
  - **Detecting bounds (#138)**: Add time-based (5 min) and attempt-based (3 attempts) bounds to detecting state with evidence hashing to prevent counter reset on unchanged probe results.
  - **Report watcher (#140)**: Background trigger system that audits agent reports for anomalies (no_acknowledge, stale_report, agent_needs_input) and integrates with the reaction engine.

  New exports:
  - `applyLifecycleDecision`, `applyDecisionToLifecycle`, `buildTransitionMetadataPatch`, `createStateTransitionDecision`
  - `DETECTING_MAX_ATTEMPTS`, `DETECTING_MAX_DURATION_MS`, `hashEvidence`, `isDetectingTimedOut`
  - `auditAgentReports`, `checkAcknowledgeTimeout`, `checkStaleReport`, `checkBlockedAgent`, `shouldAuditSession`, `getReactionKeyForTrigger`, `DEFAULT_REPORT_WATCHER_CONFIG`, `REPORT_WATCHER_METADATA_KEYS`

- c8af50f: Make `ProjectConfig.repo` optional to support projects without a configured remote.

  **Migration:** `ProjectConfig.repo` is now `string | undefined` instead of `string`.
  External plugins that access `project.repo` directly (e.g. `project.repo.split("/")`) must
  add a null check first. Use a guard like `if (!project.repo) return null;` or a helper that
  throws with a descriptive error.

- c447c7c: Improve lifecycle detection to use bounded `detecting` retries when runtime, process, and activity evidence disagree, and make recovery validation escalate probe uncertainty for human review instead of treating it as cleanup-safe death.

### Patch Changes

- 2306078: Add SQLite-backed activity event logging for session and lifecycle diagnostics, plus `ao events` commands for listing, searching, and inspecting event log stats.
- f330a1e: `ao session ls` and `ao status` now hide terminated sessions (`killed`, `terminated`, `done`, `merged`, `errored`, `cleanup`) by default. A dim footer reports how many were hidden and how to surface them. Pass `--include-terminated` to restore the previous unfiltered output.

  Core change: `parseCanonicalLifecycle()` now preserves `pr.state="merged"` when reconstructing legacy metadata with `status=merged` but no `pr=` URL (previously collapsed to `pr.state="none"`, which made `isTerminalSession()` return false for those sessions). Also exports `sessionFromMetadata` so consumers can round-trip flat metadata through the canonical lifecycle.

  **Breaking — JSON output shape:** `ao session ls --json` and `ao status --json` now emit `{ data: [...], meta: { hiddenTerminatedCount: number } }` instead of a bare array. Scripts consuming the JSON must read `.data` for the session list. `--include-terminated` restores full data and reports `hiddenTerminatedCount: 0`.

  The existing `-a, --all` flag still only governs orchestrator visibility on `ao session ls` — it does **not** re-enable terminated sessions. Combine with `--include-terminated` when you want both.

- a862327: Stop carrying forward `stuck` / `probe_failure` session truth when the runtime is still confirmed alive and activity is merely unavailable, and degrade that combination to `detecting` until stronger evidence arrives.
- 703d584: fix(core): prevent double-billing reaction attempts on changes_requested transition

  The enriched review dispatch in `maybeDispatchReviewBacklog` now sends directly via
  `sessionManager.send` when the transition handler already called `executeReaction` for
  the same reaction key. This prevents the attempt counter from incrementing twice in a
  single poll cycle, which would cause premature escalation for projects with `retries: 1`.

  Also moves the review backlog throttle timestamp after the SCM fetch so a failed
  `getReviewThreads` call doesn't block retries for 2 minutes.

- f674422: Make project orchestrators deterministic and idempotent.
  - ensure each project uses the canonical `{prefix}-orchestrator` session instead of creating numbered main orchestrators
  - make `ao start`, the dashboard, and the orchestrator API reuse or restore the canonical session
  - keep legacy numbered orchestrators visible as stale sessions without treating them as the main orchestrator

- 62353eb: Harden worker branch refresh during lifecycle polling by preserving branch metadata through transient detached Git states, skipping orchestrators and active open PRs, and preventing duplicate branch adoption within a single poll cycle.
- bd36c7b: Keep lifecycle observability and batch diagnostic logs out of user-visible terminal stderr by routing them into AO's observability audit files instead, while preserving structured traces for debugging and regression coverage.
- ca8c4cc: Model activity evidence explicitly across lifecycle inference and dashboard rendering so missing or failed probes cannot spuriously produce idle or stuck interpretations. This also stabilizes repeated polls by preserving stronger prior lifecycle states when the only new evidence is weak or unavailable.
- 4701122: opencode: bound /tmp blast radius and consolidate session-list cache

  Addresses review feedback on PR #1478:
  - **TMPDIR isolation.** Every `opencode` child we spawn now points at
    `~/.agent-orchestrator/.bun-tmp/` via `TMPDIR`/`TMP`/`TEMP`. Bun's
    embedded shared-library extraction lands there instead of the system
    `/tmp`, so the cli janitor only ever sweeps AO-owned files. Other
    users' or other applications' Bun artifacts on a shared host can no
    longer be touched by the regex.
  - **Single shared session-list cache.** Core and the agent-opencode
    plugin previously kept independent caches; per poll cycle the system
    spawned at least two `opencode session list` processes instead of
    one. Both consumers now use the shared cache exported from
    `@aoagents/ao-core` (`getCachedOpenCodeSessionList`).
  - **TTL no longer covers the send-confirmation loop.** The cache TTL
    dropped from 3s to 500ms so the
    `updatedAt > baselineUpdatedAt` delivery signal in
    `sendWithConfirmation` actually fires. Concurrent callers still
    share the in-flight promise.
  - **Delete invalidates the cache.** `deleteOpenCodeSession` now calls
    `invalidateOpenCodeSessionListCache()` on success so reuse, remap,
    and restore code paths cannot observe a deleted session id within
    the TTL window.
  - **Janitor reliability.** `sweepOnce` now filters synchronously
    before allocating per-file promises (matters on hosts with thousands
    of `/tmp` entries), and `stopBunTmpJanitor()` is now async and awaits
    any in-flight sweep so SIGTERM cannot exit while `unlink` is mid-flight.
  - **Janitor observability.** The sweep callback in `ao start` now logs
    successful reclaims, not just errors, so operators can confirm the
    janitor is doing useful work.

- bcdda4b: Tighten the session lifecycle review follow-ups by debouncing report-watcher reactions, restoring the shared Geist/JetBrains font setup, wiring recovery validation to real agent activity probes, adding direct coverage for `ao report`, activity-signal classification, and dashboard lifecycle audit panels, fixing the remaining lifecycle-state regressions around legacy merged-session rehydration and malformed canonical payload parsing, making agent-report metadata writes atomic, persisting canonical payloads for legacy sessions on read, stabilizing detecting evidence hashes, and removing the remaining inline-style cleanup debt from the session detail view. Follow-on fixes also split the Session Detail view into smaller components, harden PR URL parsing and wrapper capture for GitHub Enterprise and GitLab-style hosts, redact sensitive observability payload fields, bound on-disk audit logs, and align cleanup wording with the current merged-session lifecycle policy.
- 1cbf657: Split orchestrator-only detail views from worker detail views, add an auditable history for `ao acknowledge` / `ao report`, and preserve canonical `needs_input` / `stuck` lifecycle states when polling only has weak or unchanged evidence.
- a45eb32: Decouple canonical session state from PR state so workers stay idle while waiting on reviews or merged/closed PR decisions, stop cleanup from auto-killing merged PR sessions, and make the dashboard/rendered labels follow canonical PR truth instead of inferring it from legacy lifecycle aliases.
- 7072143: Expose split session, PR, and runtime lifecycle truth in dashboard API payloads, render that truth directly in session cards and detail views, and extend lifecycle observability with structured transition evidence, reasons, and recovery context while preserving legacy metadata compatibility.
- ed2dcea: Split worker session prompts into persistent system instructions and task-only input, materialize OpenCode worker/orchestrator instructions into session-scoped `AGENTS.md`, and keep restore behavior aligned with the updated AO prompt markers.

## 0.2.0

### Minor Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.
