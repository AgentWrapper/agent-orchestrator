---
"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
"@aoagents/ao": minor
"@aoagents/ao-plugin-runtime-process": minor
"@aoagents/ao-plugin-runtime-tmux": minor
"@aoagents/ao-plugin-agent-claude-code": minor
"@aoagents/ao-plugin-agent-codex": minor
"@aoagents/ao-plugin-agent-aider": minor
"@aoagents/ao-plugin-agent-opencode": minor
"@aoagents/ao-plugin-workspace-worktree": minor
"@aoagents/ao-plugin-workspace-clone": minor
"@aoagents/ao-plugin-tracker-github": minor
"@aoagents/ao-plugin-tracker-linear": minor
"@aoagents/ao-plugin-scm-github": minor
"@aoagents/ao-plugin-notifier-desktop": minor
"@aoagents/ao-plugin-notifier-slack": minor
"@aoagents/ao-plugin-notifier-webhook": minor
"@aoagents/ao-plugin-notifier-composio": minor
"@aoagents/ao-plugin-terminal-iterm2": minor
"@aoagents/ao-plugin-terminal-web": minor
"@aoagents/ao-web": minor
---

feat: native Windows support

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
