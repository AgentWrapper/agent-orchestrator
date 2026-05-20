# @aoagents/ao-plugin-tracker-github

## 0.8.0

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

- c8af50f: Make `ProjectConfig.repo` optional to support projects without a configured remote.

  **Migration:** `ProjectConfig.repo` is now `string | undefined` instead of `string`.
  External plugins that access `project.repo` directly (e.g. `project.repo.split("/")`) must
  add a null check first. Use a guard like `if (!project.repo) return null;` or a helper that
  throws with a descriptive error.

- a8bc746: tracker-github: cache `gh issue view` responses in-process (5 min TTL, bounded LRU)

  The lifecycle worker polls `getIssue` and `isCompleted` repeatedly for the same
  issue across a session. In a 5-session tier-5 bench run (10 min), trace data
  showed the same `(repo, issue)` pair fetched 64+ times with >97% duplicate rate.

  This change caches the full `Issue` object per `(repo, identifier)` for 5
  minutes inside each `createGitHubTracker()` instance. `isCompleted` now routes
  through `getIssue` to share the cache. `updateIssue` invalidates the cache
  entry on any mutation. Failures are not cached.

  Expected reduction: ~744 `gh issue view` calls per tier-5 run → ~15 calls.

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

- Updated dependencies [3a650b0]
  - @composio/ao-core@0.2.0
