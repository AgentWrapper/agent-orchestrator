# @aoagents/ao-cli

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

### Patch Changes

- Updated dependencies [845fffd]
- Updated dependencies [0f5ae0b]
- Updated dependencies [fe33bb7]
- Updated dependencies [7c46dc9]
- Updated dependencies [71326bc]
- Updated dependencies [a33b2ba]
  - @aoagents/ao-plugin-runtime-tmux@0.7.0
  - @aoagents/ao-web@0.7.0
  - @aoagents/ao-core@0.7.0
  - @aoagents/ao-plugin-runtime-process@0.7.0
  - @aoagents/ao-plugin-agent-claude-code@0.7.0
  - @aoagents/ao-plugin-agent-codex@0.7.0
  - @aoagents/ao-plugin-agent-aider@0.7.0
  - @aoagents/ao-plugin-agent-opencode@0.7.0
  - @aoagents/ao-plugin-workspace-worktree@0.7.0
  - @aoagents/ao-plugin-workspace-clone@0.7.0
  - @aoagents/ao-plugin-tracker-github@0.7.0
  - @aoagents/ao-plugin-tracker-linear@0.7.0
  - @aoagents/ao-plugin-scm-github@0.7.0
  - @aoagents/ao-plugin-notifier-desktop@0.7.0
  - @aoagents/ao-plugin-notifier-slack@0.7.0
  - @aoagents/ao-plugin-notifier-webhook@0.7.0
  - @aoagents/ao-plugin-notifier-composio@0.7.0
  - @aoagents/ao-plugin-terminal-iterm2@0.7.0
  - @aoagents/ao-plugin-terminal-web@0.7.0
  - @aoagents/ao-plugin-agent-cursor@0.7.0
  - @aoagents/ao-plugin-agent-kimicode@0.7.0
  - @aoagents/ao-plugin-notifier-discord@0.7.0
  - @aoagents/ao-plugin-notifier-openclaw@0.7.0

## 0.6.0

### Patch Changes

- 0f539a3: Fix dashboard 404 after adding a project from the "AO is already running" menu. The CLI now notifies the running daemon to reload its cached config so the new project's page is reachable immediately.
- Updated dependencies
- Updated dependencies
- Updated dependencies [40aeb78]
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @aoagents/ao-core@0.6.0
  - @aoagents/ao-web@0.6.0
  - @aoagents/ao-plugin-runtime-tmux@0.6.0
  - @aoagents/ao-plugin-agent-aider@0.6.0
  - @aoagents/ao-plugin-agent-claude-code@0.6.0
  - @aoagents/ao-plugin-agent-codex@0.6.0
  - @aoagents/ao-plugin-agent-cursor@0.1.4
  - @aoagents/ao-plugin-agent-kimicode@0.1.3
  - @aoagents/ao-plugin-agent-opencode@0.6.0
  - @aoagents/ao-plugin-notifier-composio@0.6.0
  - @aoagents/ao-plugin-notifier-desktop@0.6.0
  - @aoagents/ao-plugin-notifier-discord@0.2.9
  - @aoagents/ao-plugin-notifier-openclaw@0.2.9
  - @aoagents/ao-plugin-notifier-slack@0.6.0
  - @aoagents/ao-plugin-notifier-webhook@0.6.0
  - @aoagents/ao-plugin-runtime-process@0.6.0
  - @aoagents/ao-plugin-scm-github@0.6.0
  - @aoagents/ao-plugin-terminal-iterm2@0.6.0
  - @aoagents/ao-plugin-terminal-web@0.6.0
  - @aoagents/ao-plugin-tracker-github@0.6.0
  - @aoagents/ao-plugin-tracker-linear@0.6.0
  - @aoagents/ao-plugin-workspace-clone@0.6.0
  - @aoagents/ao-plugin-workspace-worktree@0.6.0

## 0.5.0

### Minor Changes

- 3a69722: Remove the deprecated `ao init` command. Use `ao start` instead — it auto-creates the config on first run in an unconfigured repo.

### Patch Changes

- Updated dependencies [dd07b6b]
- Updated dependencies [dd07b6b]
- Updated dependencies [dd07b6b]
  - @aoagents/ao-core@0.5.0
  - @aoagents/ao-web@0.5.0
  - @aoagents/ao-plugin-agent-aider@0.5.0
  - @aoagents/ao-plugin-agent-claude-code@0.5.0
  - @aoagents/ao-plugin-agent-codex@0.5.0
  - @aoagents/ao-plugin-agent-cursor@0.1.3
  - @aoagents/ao-plugin-agent-kimicode@0.1.2
  - @aoagents/ao-plugin-agent-opencode@0.5.0
  - @aoagents/ao-plugin-notifier-composio@0.5.0
  - @aoagents/ao-plugin-notifier-desktop@0.5.0
  - @aoagents/ao-plugin-notifier-discord@0.2.8
  - @aoagents/ao-plugin-notifier-openclaw@0.2.8
  - @aoagents/ao-plugin-notifier-slack@0.5.0
  - @aoagents/ao-plugin-notifier-webhook@0.5.0
  - @aoagents/ao-plugin-runtime-process@0.5.0
  - @aoagents/ao-plugin-runtime-tmux@0.5.0
  - @aoagents/ao-plugin-scm-github@0.5.0
  - @aoagents/ao-plugin-terminal-iterm2@0.5.0
  - @aoagents/ao-plugin-terminal-web@0.5.0
  - @aoagents/ao-plugin-tracker-github@0.5.0
  - @aoagents/ao-plugin-tracker-linear@0.5.0
  - @aoagents/ao-plugin-workspace-clone@0.5.0
  - @aoagents/ao-plugin-workspace-worktree@0.5.0

## 0.4.0

### Minor Changes

- f330a1e: `ao session ls` and `ao status` now hide terminated sessions (`killed`, `terminated`, `done`, `merged`, `errored`, `cleanup`) by default. A dim footer reports how many were hidden and how to surface them. Pass `--include-terminated` to restore the previous unfiltered output.

  Core change: `parseCanonicalLifecycle()` now preserves `pr.state="merged"` when reconstructing legacy metadata with `status=merged` but no `pr=` URL (previously collapsed to `pr.state="none"`, which made `isTerminalSession()` return false for those sessions). Also exports `sessionFromMetadata` so consumers can round-trip flat metadata through the canonical lifecycle.

  **Breaking — JSON output shape:** `ao session ls --json` and `ao status --json` now emit `{ data: [...], meta: { hiddenTerminatedCount: number } }` instead of a bare array. Scripts consuming the JSON must read `.data` for the session list. `--include-terminated` restores full data and reports `hiddenTerminatedCount: 0`.

  The existing `-a, --all` flag still only governs orchestrator visibility on `ao session ls` — it does **not** re-enable terminated sessions. Combine with `--include-terminated` when you want both.

- e7ad928: Allow workers to report non-terminal PR workflow events like `pr-created`, `draft-pr-created`, and `ready-for-review` with optional PR URL/number metadata, while keeping merged and closed PR state SCM-owned.

  **Migration:** `Session` now carries canonical lifecycle truth in `session.lifecycle`
  and explicit activity-evidence metadata in `session.activitySignal`. Third-party
  callers that construct `Session` objects directly must populate those fields or
  route through the core session helpers that synthesize them.

### Patch Changes

- 2306078: Add SQLite-backed activity event logging for session and lifecycle diagnostics, plus `ao events` commands for listing, searching, and inspecting event log stats.
- f09cc72: `ao session ls` hides terminal sessions in text output by default; use `--include-terminated` for the full text list.
- e1bb51f: Fix restore behavior across AO session recovery flows.
  - restore the latest dead-but-restorable orchestrator on `ao start` instead of silently spawning a new orchestrator when tmux is gone
  - make worker session orchestrator navigation prefer the most recently active live orchestrator for the project
  - make permissionless Codex restores preserve dangerous bypass semantics so resumed workers behave like fresh permissionless launches

- f674422: Make project orchestrators deterministic and idempotent.
  - ensure each project uses the canonical `{prefix}-orchestrator` session instead of creating numbered main orchestrators
  - make `ao start`, the dashboard, and the orchestrator API reuse or restore the canonical session
  - keep legacy numbered orchestrators visible as stale sessions without treating them as the main orchestrator

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

- c8af50f: Make `ProjectConfig.repo` optional to support projects without a configured remote.

  **Migration:** `ProjectConfig.repo` is now `string | undefined` instead of `string`.
  External plugins that access `project.repo` directly (e.g. `project.repo.split("/")`) must
  add a null check first. Use a guard like `if (!project.repo) return null;` or a helper that
  throws with a descriptive error.

- bcdda4b: Tighten the session lifecycle review follow-ups by debouncing report-watcher reactions, restoring the shared Geist/JetBrains font setup, wiring recovery validation to real agent activity probes, adding direct coverage for `ao report`, activity-signal classification, and dashboard lifecycle audit panels, fixing the remaining lifecycle-state regressions around legacy merged-session rehydration and malformed canonical payload parsing, making agent-report metadata writes atomic, persisting canonical payloads for legacy sessions on read, stabilizing detecting evidence hashes, and removing the remaining inline-style cleanup debt from the session detail view. Follow-on fixes also split the Session Detail view into smaller components, harden PR URL parsing and wrapper capture for GitHub Enterprise and GitLab-style hosts, redact sensitive observability payload fields, bound on-disk audit logs, and align cleanup wording with the current merged-session lifecycle policy.
- 1cbf657: Split orchestrator-only detail views from worker detail views, add an auditable history for `ao acknowledge` / `ao report`, and preserve canonical `needs_input` / `stuck` lifecycle states when polling only has weak or unchanged evidence.
- Updated dependencies [2306078]
- Updated dependencies [b0d0994]
- Updated dependencies [faaddb1]
- Updated dependencies [0cf0190]
- Updated dependencies [f330a1e]
- Updated dependencies [a862327]
- Updated dependencies [331f1ce]
- Updated dependencies [e465a47]
- Updated dependencies [703d584]
- Updated dependencies [e1bb51f]
- Updated dependencies [08667c8]
- Updated dependencies [eca3001]
- Updated dependencies [f674422]
- Updated dependencies [62353eb]
- Updated dependencies [bd36c7b]
- Updated dependencies [e7ad928]
- Updated dependencies [ca8c4cc]
- Updated dependencies [7b82374]
- Updated dependencies [4701122]
- Updated dependencies [c8af50f]
- Updated dependencies [bcdda4b]
- Updated dependencies [eb7314b]
- Updated dependencies [a8bc746]
- Updated dependencies [a8bc746]
- Updated dependencies [1cbf657]
- Updated dependencies [c447c7c]
- Updated dependencies [a45eb32]
- Updated dependencies [7072143]
- Updated dependencies [a8bc746]
- Updated dependencies [e518562]
- Updated dependencies [fed25d5]
- Updated dependencies [ed2dcea]
  - @aoagents/ao-core@0.4.0
  - @aoagents/ao-plugin-agent-codex@0.4.0
  - @aoagents/ao-plugin-agent-claude-code@0.4.0
  - @aoagents/ao-web@0.4.0
  - @aoagents/ao-plugin-agent-opencode@0.4.0
  - @aoagents/ao-plugin-scm-github@0.4.0
  - @aoagents/ao-plugin-tracker-github@0.4.0
  - @aoagents/ao-plugin-agent-aider@0.4.0
  - @aoagents/ao-plugin-agent-cursor@0.1.2
  - @aoagents/ao-plugin-agent-kimicode@0.1.1
  - @aoagents/ao-plugin-notifier-composio@0.4.0
  - @aoagents/ao-plugin-notifier-desktop@0.4.0
  - @aoagents/ao-plugin-notifier-discord@0.2.7
  - @aoagents/ao-plugin-notifier-openclaw@0.2.7
  - @aoagents/ao-plugin-notifier-slack@0.4.0
  - @aoagents/ao-plugin-notifier-webhook@0.4.0
  - @aoagents/ao-plugin-runtime-process@0.4.0
  - @aoagents/ao-plugin-runtime-tmux@0.4.0
  - @aoagents/ao-plugin-terminal-iterm2@0.4.0
  - @aoagents/ao-plugin-terminal-web@0.4.0
  - @aoagents/ao-plugin-tracker-linear@0.4.0
  - @aoagents/ao-plugin-workspace-clone@0.4.0
  - @aoagents/ao-plugin-workspace-worktree@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [5315e4e]
  - @composio/ao-web@0.2.2

## 0.2.1

### Patch Changes

- ac625c3: Fix startup onboarding and install reliability:
  - Repair npm global install startup path by improving package resolution and web package discovery hints.
  - Make `ao start` prerequisite installs explicit and interactive for required tools (`tmux`, `git`) with clearer fallback guidance.
  - Keep `ao spawn` preflight check-only for `tmux` (no implicit install).
  - Remove redundant agent runtime re-detection during config generation.

## 0.2.0

### Minor Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.

### Patch Changes

- Updated dependencies [3a650b0]
  - @composio/ao-core@0.2.0
  - @composio/ao-web@0.2.0
  - @composio/ao-plugin-agent-claude-code@0.2.0
  - @composio/ao-plugin-agent-aider@0.2.0
  - @composio/ao-plugin-agent-codex@0.2.0
  - @composio/ao-plugin-agent-opencode@0.2.0
  - @composio/ao-plugin-notifier-composio@0.2.0
  - @composio/ao-plugin-notifier-desktop@0.2.0
  - @composio/ao-plugin-notifier-openclaw@0.1.1
  - @composio/ao-plugin-notifier-slack@0.2.0
  - @composio/ao-plugin-notifier-webhook@0.2.0
  - @composio/ao-plugin-runtime-process@0.2.0
  - @composio/ao-plugin-runtime-tmux@0.2.0
  - @composio/ao-plugin-scm-github@0.2.0
  - @composio/ao-plugin-terminal-iterm2@0.2.0
  - @composio/ao-plugin-terminal-web@0.2.0
  - @composio/ao-plugin-tracker-github@0.2.0
  - @composio/ao-plugin-tracker-linear@0.2.0
  - @composio/ao-plugin-workspace-clone@0.2.0
  - @composio/ao-plugin-workspace-worktree@0.2.0
