# @aoagents/ao

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

- Updated dependencies [0f5ae0b]
- Updated dependencies [fe33bb7]
- Updated dependencies [7c46dc9]
  - @aoagents/ao-cli@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [0f539a3]
  - @aoagents/ao-cli@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [3a69722]
  - @aoagents/ao-cli@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [2306078]
- Updated dependencies [f09cc72]
- Updated dependencies [f330a1e]
- Updated dependencies [e1bb51f]
- Updated dependencies [f674422]
- Updated dependencies [e7ad928]
- Updated dependencies [4701122]
- Updated dependencies [c8af50f]
- Updated dependencies [bcdda4b]
- Updated dependencies [1cbf657]
  - @aoagents/ao-cli@0.4.0

## 0.2.2

### Patch Changes

- @composio/ao-cli@0.2.2

## 0.2.1

### Patch Changes

- ac625c3: Fix startup onboarding and install reliability:
  - Repair npm global install startup path by improving package resolution and web package discovery hints.
  - Make `ao start` prerequisite installs explicit and interactive for required tools (`tmux`, `git`) with clearer fallback guidance.
  - Keep `ao spawn` preflight check-only for `tmux` (no implicit install).
  - Remove redundant agent runtime re-detection during config generation.

- Updated dependencies [ac625c3]
  - @composio/ao-cli@0.2.1

## 0.2.0

### Minor Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.

### Patch Changes

- Updated dependencies [3a650b0]
  - @composio/ao-cli@0.2.0
