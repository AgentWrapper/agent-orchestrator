# @aoagents/ao-web

## 0.6.0

### Patch Changes

- Drop `=` prefix from `set-option` invocation in `mux-websocket` so tmux accepts the option without erroring out (#1715).
- Bound the PTY re-attach loop with a grace-period counter reset to prevent runaway reconnect attempts (#1640).
- Disable xterm scrollback to prevent terminal right-side clipping (#1678).
- Updated dependencies
- Updated dependencies [40aeb78]
- Updated dependencies
- Updated dependencies
  - @aoagents/ao-core@0.6.0
  - @aoagents/ao-plugin-runtime-tmux@0.6.0
  - @aoagents/ao-plugin-agent-claude-code@0.6.0
  - @aoagents/ao-plugin-agent-codex@0.6.0
  - @aoagents/ao-plugin-agent-cursor@0.1.4
  - @aoagents/ao-plugin-agent-kimicode@0.1.3
  - @aoagents/ao-plugin-agent-opencode@0.6.0
  - @aoagents/ao-plugin-scm-github@0.6.0
  - @aoagents/ao-plugin-tracker-github@0.6.0
  - @aoagents/ao-plugin-tracker-linear@0.6.0
  - @aoagents/ao-plugin-workspace-worktree@0.6.0

## 0.5.0

### Patch Changes

- dd07b6b: Fix direct terminal attach and keep mux routing project-scoped. Switches `resolveExactTmuxName` from `execFileSync` to a promisified `execFile` so slow tmux calls no longer stall the WebSocket message handler, and propagates async through `TerminalManager.open` / `subscribe` and the pty `onExit` reattach path. Also drops a duplicate `.kanban-board` grid rule in `globals.css`.
- dd07b6b: Render an empty-state in the project sidebar when no projects are configured. Fresh-install users previously saw a blank sidebar with no way to open the Add Project modal; the sidebar now shows a small empty-state with the `+` button wired up.
- Updated dependencies [dd07b6b]
  - @aoagents/ao-core@0.5.0
  - @aoagents/ao-plugin-agent-claude-code@0.5.0
  - @aoagents/ao-plugin-agent-codex@0.5.0
  - @aoagents/ao-plugin-agent-cursor@0.1.3
  - @aoagents/ao-plugin-agent-kimicode@0.1.2
  - @aoagents/ao-plugin-agent-opencode@0.5.0
  - @aoagents/ao-plugin-runtime-tmux@0.5.0
  - @aoagents/ao-plugin-scm-github@0.5.0
  - @aoagents/ao-plugin-tracker-github@0.5.0
  - @aoagents/ao-plugin-tracker-linear@0.5.0
  - @aoagents/ao-plugin-workspace-worktree@0.5.0

## 0.4.0

### Patch Changes

- b0d0994: Improve Claude Code and Codex session cost estimates to account for cached-token spend, make Codex restore commands fall back to approval prompts for worker sessions instead of blindly reusing dangerous bypass flags, and register the Codex plugin in the web dashboard so native activity detection works there.
- 0cf0190: Make session detail agent reports collapsible and add explicit audit attribution for the session, actor, and report source command.
- e1bb51f: Fix restore behavior across AO session recovery flows.
  - restore the latest dead-but-restorable orchestrator on `ao start` instead of silently spawning a new orchestrator when tmux is gone
  - make worker session orchestrator navigation prefer the most recently active live orchestrator for the project
  - make permissionless Codex restores preserve dangerous bypass semantics so resumed workers behave like fresh permissionless launches

- 08667c8: Keep closed-unmerged sessions actionable in the dashboard by removing them from the done lane unless the runtime actually ended, and hide restore controls for merged sessions that are intentionally non-restorable.
- eca3001: Fix DirectTerminal "can't find session" when the project uses a wrapped storageKey. `ao-core` names tmux sessions as `{storageKey}-{sessionId}`, where `storageKey` can be either a bare 12-char hash or the legacy wrapped form `{hash}-{projectName}` (e.g. `361287ebbad1-smx-foundation`). The web resolver only handled the bare-hash form, so lookups for sessions like `sf-orchestrator-1` against the tmux name `361287ebbad1-smx-foundation-sf-orchestrator-1` always returned `null` and the terminal never attached (#1486).

  The resolver now looks up the owning storageKey on disk (from the session record at `~/.agent-orchestrator/{storageKey}/sessions/{sessionId}`) and asks tmux for the exact `{storageKey}-{sessionId}` name. The on-disk record is the authoritative disambiguator, so sessions whose IDs happen to be suffixes of other session IDs (e.g. looking up `app-1` while `my-app-1` exists in the same project) cannot be falsely matched. If the on-disk record is missing, the resolver still recovers bare-hash sessions via the tmux session listing as a fallback.

- f674422: Make project orchestrators deterministic and idempotent.
  - ensure each project uses the canonical `{prefix}-orchestrator` session instead of creating numbered main orchestrators
  - make `ao start`, the dashboard, and the orchestrator API reuse or restore the canonical session
  - keep legacy numbered orchestrators visible as stale sessions without treating them as the main orchestrator

- ca8c4cc: Model activity evidence explicitly across lifecycle inference and dashboard rendering so missing or failed probes cannot spuriously produce idle or stuck interpretations. This also stabilizes repeated polls by preserving stronger prior lifecycle states when the only new evidence is weak or unavailable.
- c8af50f: Make `ProjectConfig.repo` optional to support projects without a configured remote.

  **Migration:** `ProjectConfig.repo` is now `string | undefined` instead of `string`.
  External plugins that access `project.repo` directly (e.g. `project.repo.split("/")`) must
  add a null check first. Use a guard like `if (!project.repo) return null;` or a helper that
  throws with a descriptive error.

- bcdda4b: Tighten the session lifecycle review follow-ups by debouncing report-watcher reactions, restoring the shared Geist/JetBrains font setup, wiring recovery validation to real agent activity probes, adding direct coverage for `ao report`, activity-signal classification, and dashboard lifecycle audit panels, fixing the remaining lifecycle-state regressions around legacy merged-session rehydration and malformed canonical payload parsing, making agent-report metadata writes atomic, persisting canonical payloads for legacy sessions on read, stabilizing detecting evidence hashes, and removing the remaining inline-style cleanup debt from the session detail view. Follow-on fixes also split the Session Detail view into smaller components, harden PR URL parsing and wrapper capture for GitHub Enterprise and GitLab-style hosts, redact sensitive observability payload fields, bound on-disk audit logs, and align cleanup wording with the current merged-session lifecycle policy.
- eb7314b: Refactor SessionDetail.tsx by extracting the topbar header, PR card, and unresolved comment thread into dedicated components. The previously-orphaned SessionDetailPRCard, session-detail-utils, and session-detail-agent-actions modules are now wired in. All files are under the 400-line component limit.
- 1cbf657: Split orchestrator-only detail views from worker detail views, add an auditable history for `ao acknowledge` / `ao report`, and preserve canonical `needs_input` / `stuck` lifecycle states when polling only has weak or unchanged evidence.
- a45eb32: Decouple canonical session state from PR state so workers stay idle while waiting on reviews or merged/closed PR decisions, stop cleanup from auto-killing merged PR sessions, and make the dashboard/rendered labels follow canonical PR truth instead of inferring it from legacy lifecycle aliases.
- 7072143: Expose split session, PR, and runtime lifecycle truth in dashboard API payloads, render that truth directly in session cards and detail views, and extend lifecycle observability with structured transition evidence, reasons, and recovery context while preserving legacy metadata compatibility.
- e518562: Add a dashboard control to copy observability diagnostics and page context to the clipboard for support and issue reports.
- fed25d5: Show GitHub compare and copy-branch actions on session PR detail when the PR has merge conflicts.
- Updated dependencies [2306078]
- Updated dependencies [b0d0994]
- Updated dependencies [faaddb1]
- Updated dependencies [f330a1e]
- Updated dependencies [a862327]
- Updated dependencies [331f1ce]
- Updated dependencies [e465a47]
- Updated dependencies [703d584]
- Updated dependencies [e1bb51f]
- Updated dependencies [f674422]
- Updated dependencies [62353eb]
- Updated dependencies [bd36c7b]
- Updated dependencies [e7ad928]
- Updated dependencies [ca8c4cc]
- Updated dependencies [7b82374]
- Updated dependencies [4701122]
- Updated dependencies [c8af50f]
- Updated dependencies [bcdda4b]
- Updated dependencies [a8bc746]
- Updated dependencies [a8bc746]
- Updated dependencies [1cbf657]
- Updated dependencies [c447c7c]
- Updated dependencies [a45eb32]
- Updated dependencies [7072143]
- Updated dependencies [a8bc746]
- Updated dependencies [ed2dcea]
  - @aoagents/ao-core@0.4.0
  - @aoagents/ao-plugin-agent-codex@0.4.0
  - @aoagents/ao-plugin-agent-claude-code@0.4.0
  - @aoagents/ao-plugin-agent-opencode@0.4.0
  - @aoagents/ao-plugin-scm-github@0.4.0
  - @aoagents/ao-plugin-tracker-github@0.4.0
  - @aoagents/ao-plugin-agent-cursor@0.1.2
  - @aoagents/ao-plugin-agent-kimicode@0.1.1
  - @aoagents/ao-plugin-runtime-tmux@0.4.0
  - @aoagents/ao-plugin-tracker-linear@0.4.0
  - @aoagents/ao-plugin-workspace-worktree@0.4.0

## 0.2.2

### Patch Changes

- 5315e4e: Fix runtime terminal websocket connectivity for npm-installed/prebuilt runs and harden project validation across API routes.
  - add runtime terminal config endpoint (`/api/runtime/terminal`) so the browser can read runtime-selected ports
  - make direct terminal client resolve websocket target from runtime config before connect/reconnect
  - add AbortController (1.5s) to runtime config fetch so a slow endpoint cannot block WebSocket connection
  - prevent repeated runtime config fetches on reconnect when the endpoint is unavailable
  - centralize project existence check via `validateConfiguredProject` (uses `Object.hasOwn` to avoid prototype-chain bypass)
  - apply semantic project validation to `/api/spawn`, `/api/issues`, `/api/verify`, and `/api/orchestrators`
  - return deterministic `404 Unknown project` from all routes for non-configured project IDs
  - normalize dashboard project filter to configured project IDs to prevent invalid query state propagation

## 0.2.0

### Minor Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.

### Patch Changes

- Updated dependencies [3a650b0]
  - @composio/ao-core@0.2.0
  - @composio/ao-plugin-agent-claude-code@0.2.0
  - @composio/ao-plugin-agent-opencode@0.2.0
  - @composio/ao-plugin-runtime-tmux@0.2.0
  - @composio/ao-plugin-scm-github@0.2.0
  - @composio/ao-plugin-tracker-github@0.2.0
  - @composio/ao-plugin-tracker-linear@0.2.0
  - @composio/ao-plugin-workspace-worktree@0.2.0
