# @aoagents/ao-plugin-agent-claude-code

## 0.9.0

### Minor Changes

- 7d9b862: Replace Claude Code terminal-regex activity detection with platform-event hooks (#1941).

  Claude Code emits a lifecycle hook on every state transition that matters
  (`PermissionRequest`, `StopFailure`, `Notification`, `Stop`, `PreToolUse`,
  …). Until now, AO ignored all but one of them and tried to infer the
  same information by regex-matching Claude's rendered terminal output —
  fragile by construction. Every Claude UI tweak (footer wording, status
  verb, spinner glyph) broke a heuristic; PR #1932 spent 15 commits
  patching the sharpest edges.

  This release pivots:

  **`@aoagents/ao-plugin-agent-claude-code`** now installs two scripts per
  workspace:
  - `metadata-updater` — unchanged; PostToolUse(Bash) extracts gh/git
    side-effects (PR URL, branch, merge status).
  - `activity-updater` — new; registered on every hook that carries
    activity information (SessionStart, UserPromptSubmit, PreToolUse,
    PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
    PermissionRequest, Stop, StopFailure, SubagentStart, SubagentStop,
    PreCompact, PostCompact). The script reads the JSON payload from
    stdin, maps `hook_event_name` to an activity state, and appends a
    JSONL entry to `{workspace}/.ao/activity.jsonl` with `source: "hook"`.

  Notification is filtered by `notification_type` so `auth_success` /
  `elicitation_*` no longer false-fire `waiting_input` (the RFC's blanket
  "Notification → waiting_input" would have regressed here).

  The terminal-regex layer (`classifyTerminalOutput`, ~80 LOC of
  patterns + `agent.recordActivity`) is retired. `detectActivity` stays on
  the Agent interface for other agents but is now a stable `return "idle"`
  stub for Claude — the JSONL-backed cascade is the only source of truth
  for active / ready / waiting_input / blocked.

  **`@aoagents/ao-core`** extends `ActivityLogEntry.source` and
  `ActivitySignalSource` with a `"hook"` value so the new entries are
  parseable and their provenance is visible in telemetry. No downstream
  consumer needs changes — the cascade has always read whatever source
  appeared in the JSONL, and the new tests assert hook-sourced entries
  flow through `checkActivityLogState` / `getActivityFallbackState`
  identically to terminal-sourced ones.

  Idempotent install: calling `setupWorkspaceHooks` twice keeps exactly
  one entry per event and preserves user-installed hooks alongside ours.
  Cross-platform: bash + Node (.cjs) variants behave identically against a
  shared 52-case scenario table.

### Patch Changes

- a610601: Split Claude Code activity-detection logic out of `index.ts` into a dedicated `activity-detection.ts` module. Removes two unreachable switch branches (`case "permission_request"` → `waiting_input` and `case "error"` → `blocked`) that targeted JSONL types Claude never actually emits. `waiting_input` continues to flow through the AO activity-JSONL safety net added in #1903.

  Closes the `blocked` gap for Claude Code: extend `readLastJsonlEntry` in core to also surface top-level `subtype` and `level` fields, and map `{type:"system", level:"error"}` → `blocked` in the cascade. This catches Claude's real api_error shape (`{type:"system", subtype:"api_error", level:"error", cause:{code:"ConnectionRefused"|"FailedToOpenSocket"|...}}`) so a session stuck in the API retry loop now reports `blocked` instead of `ready`. New fields on `readLastJsonlEntry` are additive and don't break existing callers (Codex, OpenCode, Aider).

- 8c71bde: Harden Claude Code activity detection against five real-world edge cases identified during PR #1927's analysis:
  1. **Bookkeeping types → false-active.** `file-history-snapshot`, `attachment`, `pr-link`, `queue-operation`, `permission-mode`, `last-prompt`, `ai-title`, `agent-color`, `agent-name`, `custom-title` were falling through to the `default` switch branch and showing as `active` for 30s after Claude finished a turn. They now correctly map to `ready`/`idle` by age. Likely root cause of "Claude looks busy when it's done" reports.
  2. **Multi-session disambiguation.** `findLatestSessionFile` picked newest-mtime, which is the wrong session's JSONL when two Claude sessions are running in the same workspace. Now prefers the UUID-named file (`<projectDir>/<claudeSessionUuid>.jsonl`) when `session.metadata.claudeSessionUuid` is set, falling back to newest-mtime otherwise.
  3. **Symlinked workspaces.** `toClaudeProjectPath` was a pure string transform — symlink paths produced different slugs than what Claude itself wrote. Added `resolveWorkspaceForClaude(path)` that runs `realpathSync` (with fallback) and used it in all three slug-computing sites (`getClaudeActivityState`, `getSessionInfo`, `getRestoreCommand`).
  4. **Process regex too narrow.** `(?:^|\/)claude(?:\s|$)` was missing several legitimate install variants — `.claude`, `claude-code`, `claude.exe`, `claude.js`, and npm shims like `node /opt/.../@anthropic-ai/claude-code/cli.js`. Broadened to `(?:^|\/)(?:\.)?claude(?:[-.][\w-]+)*(?:[\s/]|$)`; still rejects look-alikes (`claudia`, `claudine`).
  5. **Silent permission-denied.** `findLatestSessionFile` was swallowing every `readdir` error silently — a missing `~/.claude/projects/<slug>/` (ENOENT) is normal, but a permission-denied (EACCES/EPERM) or fd-exhausted (EMFILE) misconfig left the session looking permanently `idle` on the dashboard with zero telemetry. Now logs a single `console.warn` for non-ENOENT errors.

  193/193 plugin tests pass. No public-API change. New helper `resolveWorkspaceForClaude` is re-exported from `index.ts` for downstream consumers.

- Updated dependencies [73bed33]
- Updated dependencies [a610601]
- Updated dependencies [7d9b862]
- Updated dependencies [6d48022]
- Updated dependencies [fcedb25]
- Updated dependencies [94981dc]
- Updated dependencies [2980570]
- Updated dependencies [d5d0f07]
  - @aoagents/ao-core@0.9.0

## 0.8.0

### Minor Changes

- Distinguish indeterminate agent process probes from definitive process-missing results, and raise ps probe timeouts to avoid bulk runtime_lost terminations when ps or tmux cannot return a reliable verdict.

### Patch Changes

- Updated dependencies
  - @aoagents/ao-core@0.8.0

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

### Patch Changes

- Updated dependencies [0f5ae0b]
- Updated dependencies [fe33bb7]
- Updated dependencies [7c46dc9]
  - @aoagents/ao-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies
- Updated dependencies [40aeb78]
- Updated dependencies
- Updated dependencies
  - @aoagents/ao-core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [dd07b6b]
  - @aoagents/ao-core@0.5.0

## 0.4.0

### Patch Changes

- b0d0994: Improve Claude Code and Codex session cost estimates to account for cached-token spend, make Codex restore commands fall back to approval prompts for worker sessions instead of blindly reusing dangerous bypass flags, and register the Codex plugin in the web dashboard so native activity detection works there.
- e465a47: Fix `toClaudeProjectPath` to fold underscores (and any other non-alphanumeric character) to dashes, matching Claude Code's actual on-disk slug encoding. Previously only `/`, `.`, and `:` were normalized, so AO project data dirs of the form `<sanitized>_<hash>` produced slugs that pointed to non-existent directories — `getSessionInfo` and `getRestoreCommand` could never locate the session JSONL, `claudeSessionUuid` never got persisted, and restoring orchestrator/worker sessions in any multi-project setup failed with a 409 "getRestoreCommand returned null". Fixes #1611.
- Updated dependencies [2306078]
- Updated dependencies [faaddb1]
- Updated dependencies [f330a1e]
- Updated dependencies [a862327]
- Updated dependencies [331f1ce]
- Updated dependencies [703d584]
- Updated dependencies [f674422]
- Updated dependencies [62353eb]
- Updated dependencies [bd36c7b]
- Updated dependencies [e7ad928]
- Updated dependencies [ca8c4cc]
- Updated dependencies [7b82374]
- Updated dependencies [4701122]
- Updated dependencies [c8af50f]
- Updated dependencies [bcdda4b]
- Updated dependencies [1cbf657]
- Updated dependencies [c447c7c]
- Updated dependencies [a45eb32]
- Updated dependencies [7072143]
- Updated dependencies [ed2dcea]
  - @aoagents/ao-core@0.4.0

## 0.2.0

### Patch Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.
- Updated dependencies [3a650b0]
  - @composio/ao-core@0.2.0
