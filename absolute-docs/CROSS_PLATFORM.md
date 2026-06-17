# Cross-Platform Compatibility

> **Read this before merging any change that touches process spawning, path handling, shell commands, network binding, file I/O, runtime/agent/workspace plugins, or anything that does platform-specific work.**
>
> AO ships on macOS, Linux, **and Windows**. All three are first-class — every change must keep all three working.

---

## The Golden Rule

> **Never write `process.platform === "win32"` in new code. Use `isWindows()` from `@aoagents/ao-core`. If you need branching the helper doesn't cover, add it to `packages/core/src/platform.ts` (or one of the targeted helpers in [the inventory](#helper-inventory)) — never inline at the call site.**

This isn't stylistic. The branching in `platform.ts` is centrally tested with `Object.defineProperty(process, "platform", …)` so both Windows and POSIX paths are exercised on every CI runner. Inline `process.platform` checks are invisible to that test pattern, drift out of sync, and produce the bugs that took weeks to track down on the way to shipping the Windows port.

If you find yourself typing `process.platform`:

1. Stop. Look at the [helper inventory below](#helper-inventory) — almost certainly the helper you need already exists.
2. If it doesn't, ask: "Could a future feature also need this branch?" Almost always yes. Add a function to `platform.ts` (or the closest existing helper module) and test both branches.
3. Only if the branch is genuinely a one-off (e.g. a single test guarding a Linux-only assertion) is an inline check acceptable, and even then prefer `isWindows()` for readability.

---

## When to read this file

If your change does **any** of the following, you must read the relevant section below:

| If you're touching… | …read |
|---------------------|-------|
| `process.spawn`, `child_process`, runtime plugins | [The two runtimes](#the-two-runtimes), [Process management](#process-management-gotchas) |
| `process.kill`, signals, process-tree teardown | [Process management](#process-management-gotchas) |
| Anything with file paths (compare, join, walk) | [Paths](#paths) |
| Shell commands (`exec`, command strings) | [Shell](#shell) |
| `server.listen`, sockets, `localhost` | [Networking](#networking) |
| tmux / lsof / pkill / which / coreutils shell-outs | [POSIX-only tools](#posix-only-tools) |
| Adding a new `if (process.platform === "win32")` | [The Golden Rule](#the-golden-rule), [Helper inventory](#helper-inventory) |
| Agent plugins (PATH wrappers, hooks, launch commands) | [Agent plugin helpers](#agent-plugin-helpers) |
| Activity detection / JSONL processing | [Activity-state helpers](#activity-state-helpers) |
| Tests for any of the above | [Testing for cross-platform behaviour](#testing-for-cross-platform-behaviour) |
| Anything else? | At minimum, the [pre-merge checklist](#pre-merge-checklist) |

---

## Helper inventory

Every helper you need to write Windows-safe code. **Memorise the imports — these are the building blocks.**

### Platform check + defaults — `packages/core/src/platform.ts`

```ts
import {
  isWindows,
  getDefaultRuntime,
  getShell,
  killProcessTree,
  findPidByPort,
  getEnvDefaults,
} from "@aoagents/ao-core";
```

| Symbol | Purpose | Notes |
|--------|---------|-------|
| `isWindows(): boolean` | The canonical OS check. **Always use this** instead of `process.platform === "win32"`. | Constant-time. Trivially mockable in tests. |
| `getDefaultRuntime(): "tmux" \| "process"` | Returns `"process"` on Windows, `"tmux"` elsewhere. Used by `ao start` / startup-preflight to default runtime selection. | Don't hardcode `"tmux"`. |
| `getShell(): { cmd, args(command) }` | Resolves the shell for non-interactive command execution. POSIX → `/bin/sh -c`. Windows → priority order: `AO_SHELL` env override → `pwsh` → `powershell.exe` (absolute path, robust to degraded PATH) → `powershell` → `cmd.exe`. Cached. | Use this whenever you need to run *any* shellish string. Don't assume bash. |
| `killProcessTree(pid, signal?)` | Kills a process and its descendants. Windows → `taskkill /T /F /PID <pid>`. POSIX → `process.kill(-pid, signal)` with direct-PID fallback. Guards `pid > 0`. | **Never write `process.kill(-pid, …)` directly.** Negative PIDs are POSIX-only. |
| `findPidByPort(port): Promise<string \| null>` | Finds the LISTENING PID on a port. Windows → parses `netstat -ano`. POSIX → `lsof -ti :PORT -sTCP:LISTEN`. | Use this; don't shell-out yourself. |
| `getEnvDefaults(): { HOME, SHELL, TMPDIR, PATH, USER }` | Returns platform-correct env defaults: Windows reads `USERPROFILE`/`TEMP`/`USERNAME`, POSIX reads `HOME`/`SHELL`/`TMPDIR`/`USER`. | Use instead of hardcoding `/tmp`, `~`, `$HOME`. |
| `_resetShellCache()` | Test-only — clears the cached shell resolution. | `@internal`. |

### Path equality — `packages/cli/src/lib/path-equality.ts`

```ts
import { pathsEqual, canonicalCompareKey } from "../../src/lib/path-equality.js";
```

| Symbol | Purpose |
|--------|---------|
| `pathsEqual(a, b): boolean` | "Same filesystem entry" comparison. Resolves both via `realpathSync` (falls back to literal on error), then lowercases on Windows so `D:\Foo` == `d:\foo`. |
| `canonicalCompareKey(input): string` | Stable Map/Set key for a path. Expands `~`, resolves to absolute, calls `realpathSync`, lowercases on Windows. |

**Rule:** never compare paths with `===`. Always go through these.

### Windows pty-host registry — `packages/core/src/windows-pty-registry.ts`

Only used by Windows runtime code, but exported from `@aoagents/ao-core` so the CLI's `ao stop` can find detached pty-hosts that `taskkill /T` cannot reach.

```ts
import {
  registerWindowsPtyHost,
  unregisterWindowsPtyHost,
  getWindowsPtyHosts,
  clearWindowsPtyHostRegistry,
} from "@aoagents/ao-core";
```

| Symbol | Purpose |
|--------|---------|
| `registerWindowsPtyHost(entry)` | Add/replace a `{sessionId, ptyHostPid, pipePath}` entry in `~/.agent-orchestrator/windows-pty-hosts.json`. Called when `runtime-process` spawns a pty-host. |
| `unregisterWindowsPtyHost(sessionId)` | Remove on session destroy. |
| `getWindowsPtyHosts(): WindowsPtyHostEntry[]` | Return all entries whose PID is still alive (probes via `process.kill(pid, 0)` treating `EPERM` as alive). Auto-prunes dead ones. |
| `clearWindowsPtyHostRegistry()` | Wipe the file (recovery / tests). |

### Pty-host client (Windows pipe protocol) — `packages/plugins/runtime-process/src/pty-client.ts`

Use these whenever you need to talk to a Windows pty-host over its named pipe. The mux WS server, `runtime-process`, and `sweepWindowsPtyHosts` all go through this module — never write to a `\\.\pipe\…` directly.

```ts
import {
  getPipePath,
  connectPtyHost,
  ptyHostSendMessage,
  ptyHostGetOutput,
  ptyHostIsAlive,
  ptyHostKill,
  MessageParser,
  encodeMessage,
} from "@aoagents/ao-plugin-runtime-process";
```

| Symbol | Purpose |
|--------|---------|
| `getPipePath(sessionId)` | Returns `\\.\pipe\ao-pty-<sessionId>`. Don't construct the path manually. |
| `connectPtyHost(pipePath, timeoutMs?)` | Open a `net.Socket` to the named pipe with timeout. |
| `ptyHostSendMessage(pipePath, message)` | Send keystrokes; chunks into ≤512-char pieces with 15 ms gaps to dodge ConPTY input-buffer truncation. |
| `ptyHostGetOutput(pipePath, lines?)` | Request scrollback buffer. Returns `""` on timeout. |
| `ptyHostIsAlive(pipePath)` | Liveness probe; `true` ≡ pipe reachable. |
| `ptyHostKill(pipePath)` | Cooperative shutdown (host disposes ConPTY then exits). Silently succeeds if pipe is unreachable. |
| `MessageParser`, `encodeMessage` | Frame-protocol primitives if you're writing new pty-host integrations. |

### Pty-host sweep — `packages/plugins/runtime-process/src/index.ts`

```ts
import { sweepWindowsPtyHosts } from "@aoagents/ao-plugin-runtime-process";
```

`sweepWindowsPtyHosts(): Promise<{ attempted, gracefullyExited, forceKilled, failed }>` — iterates the registry, sends graceful `MSG_KILL_REQ`, polls up to 500 ms, then `killProcessTree` for stragglers. Called by `ao stop`. **No-op on non-Windows.**

The exit-poll inside this function is the canonical EPERM/ESRCH pattern — copy it whenever you probe a Windows process for liveness:

```ts
while (Date.now() < deadline) {
  try {
    process.kill(entry.ptyHostPid, 0);
  } catch (err: unknown) {
    // EPERM = alive but unsignalable (cross-context on Windows) → fall through to force-kill.
    // ESRCH (or anything else) = process is gone → mark exited.
    if ((err as { code?: string }).code !== "EPERM") {
      exited = true;
    }
    break;
  }
  await new Promise((r) => setTimeout(r, 25));
}
```

### Web-side helpers

```ts
// packages/web/server/tmux-utils.ts
import { validateSessionId, resolvePipePath } from "@/server/tmux-utils";

// packages/web/src/lib/windows-pty-cleanup.ts
import { stopStaleWindowsPtyHosts } from "@/lib/windows-pty-cleanup";
```

| Symbol | Purpose |
|--------|---------|
| `validateSessionId(id): boolean` | Charset/length guard. **Always validate any session ID before using it in a tmux command, named-pipe path, or shell argument** — these are user-controllable inputs. |
| `resolvePipePath(sessionId, projectId?)` | Reads the session metadata file and returns the `pipePath` field stored by `runtime-process`. Returns `null` on non-Windows. Used by the mux WS server when relaying pipe traffic. |
| `stopStaleWindowsPtyHosts(projectDir)` | Defensive sweeper. Uses a PowerShell `Get-CimInstance Win32_Process` query to find pty-hosts whose command line contains a project dir, then `taskkill`'s them. No-op on non-Windows. Use as a recovery escape hatch, not in the hot path. |

### Agent plugin helpers — `packages/core/src/agent-workspace-hooks.ts`

```ts
import { setupPathWrapperWorkspace, buildAgentPath } from "@aoagents/ao-core";
```

| Symbol | Purpose |
|--------|---------|
| `setupPathWrapperWorkspace(workspacePath)` | Installs `~/.ao/bin` PATH wrappers for `gh` / `git` so AO can intercept agent commands. **Cross-platform.** On Windows it generates `.cjs` + `.cmd` wrapper pairs (skipping bash); on Unix it generates the bash equivalents. Every agent plugin that uses PATH-wrapper interception (codex, kimicode, aider, opencode) must call this — never reimplement. |
| `buildAgentPath(basePath?)` | Prepends `~/.ao/bin` to PATH using the right separator (`;` on Windows, `:` on Unix). Use when constructing the agent's env. |

### Activity-state helpers — `packages/core/src/activity-log.ts` and `utils.ts`

```ts
import {
  appendActivityEntry,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  classifyTerminalActivity,
  recordTerminalActivity,
  readLastJsonlEntry,
} from "@aoagents/ao-core";
```

`getActivityFallbackState` is **mandatory** for new agent plugins. See [the agent-plugin section in the root CLAUDE.md](../CLAUDE.md#agent-plugin-implementation-standards) for the full contract — but the relevant cross-platform note is: AO activity JSONL works the same on all platforms, so write your activity-detection logic against it, not against tmux capture-pane / ps output.

### Shell escaping — `packages/core/src/utils.ts`

```ts
import { shellEscape } from "@aoagents/ao-core";
```

`shellEscape(arg)` produces a safely-quoted argument. Always use it when interpolating any value into a shell command line, even on Windows. Windows quoting rules are messier than POSIX and the helper handles them.

### CLI signal forwarding — `packages/cli/src/lib/shell.ts`

```ts
import { forwardSignalsToChild } from "../lib/shell.js";
```

`forwardSignalsToChild(pid, child)` — call **only on POSIX** (`if (!isWindows() && pid)`). On Windows, Ctrl+C reaches the entire console group natively; explicit forwarding is harmful (double-signals).

### Environment variables to know

| Variable | Effect |
|----------|--------|
| `AO_SHELL` | Override `getShell()` resolution. Set to an absolute path or shell name (`pwsh`, `cmd`, `bash`, …). Args are inferred from basename. The supported escape hatch for Git Bash users on Windows. |
| `AO_BASH_PATH` | Used by `script-runner.ts` on Windows to locate bash before falling back to Git Bash auto-detection. WSL bash is intentionally excluded. |

---

## The two runtimes

| Platform | Default runtime | How PTYs work |
|----------|----------------|---------------|
| macOS / Linux | `tmux` | Real tmux server, POSIX signals, Unix sockets |
| Windows | `process` | `node-pty` + ConPTY, named pipes (`\\.\pipe\ao-pty-…`), pty-host helper process |

Pick the runtime via `getDefaultRuntime()`, never hardcode. Plugin code that runs across runtimes must handle both — for Windows that means no `tmux` shell-outs, no SIGTERM/SIGKILL group kills, no POSIX-only tools.

For the architectural detail of how the Windows pty-host, named-pipe protocol, and mux WS Windows branch fit together, see the **"Windows Runtime Architecture"** section at the bottom of [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Process management gotchas

- **`process.kill(pid, 0)` distinguishes liveness on POSIX, but on Windows it can throw `EPERM`** when the target exists in a different security context. Treat `EPERM` as *alive but unsignalable* (fall through to force-kill); only `ESRCH` (or any other code) means the process is gone. The pattern is shown in the [`sweepWindowsPtyHosts` snippet above](#pty-host-sweep--packagespluginsruntime-processsrcindexts) — copy it, don't bare-`catch`. The same pattern lives in `runtime-process` `destroy()` (around line 290) and was the bug fix that prompted this section.
- **Never `process.kill(-pid, …)`** to kill a process group. Negative PIDs are POSIX-only and become a no-op or worse on Windows. Use `killProcessTree()`.
- **Graceful shutdown before SIGKILL on Windows**: SIGKILL'ing the pty-host while ConPTY is mid-spawn orphans `conpty_console_list_agent.exe` and triggers a Windows Error Reporting dialog (`0x800700e8`). Send the cooperative kill (`ptyHostKill`) first, poll for exit ~500 ms, **then** `killProcessTree`.
- **`pid <= 0` guard**: `process.kill(0, …)` signals the *current process group* on Unix. Always guard `pid > 0` before signalling.
- **Detached children**: on Windows `ao start` does NOT detach its dashboard child (so Ctrl+C reaches the whole console group natively); on POSIX it does. Use `detached: !isWindows()` rather than always-`true` or always-`false`.

## Paths

- **Filesystem case-insensitive on Windows (NTFS) and macOS (default APFS)**, case-sensitive on Linux. `D:\Foo` and `d:\foo` are the same directory; `/foo` and `/Foo` are not. Compare paths via `pathsEqual()`, never `===`.
- **Always use `path.join()` / `path.sep`**. Never hardcode `/` or `\` separators. Never split paths on `/` to walk segments.
- **Drive letters and UNC paths exist.** A path can start with `C:\`, `\\?\C:\`, `\\server\share\`, or `D:`. Don't assume paths begin with `/`.
- **Paths can contain spaces** (`C:\Program Files\…`, `C:\Users\Some Name\…`). Always quote when interpolating into shell commands; prefer `execFile` over `exec`.
- **HOME / tmp paths differ**: use `getEnvDefaults()` rather than hardcoding `/tmp`, `~`, or `$HOME`.
- **Drive-letter slugs**: when encoding a path as a filename slug (used by Claude Code's session-JSONL lookup), `C:\Users\dev\project` → `C--Users-dev-project`. Preserve the leading drive-letter dash; don't strip the colon-replacement.

## Shell

- **Default shell on Windows is PowerShell**, not bash. Bash syntax (`&&` chains, `$VAR`, `2>/dev/null`, here-docs) won't work in `cmd.exe` and is only partially supported by PowerShell. When you need to run *anything* shellish from Node, prefer `execFile` with explicit args; if you must use a shell, route through `getShell()`.
- **PowerShell call operator**: a launch command that begins with a quoted absolute path needs `& ` prepended on Windows (e.g. `& "C:\path\to\bin.exe" arg1`) or PowerShell parses the quoted path as a string expression. The `agent-codex` and `agent-kimicode` plugins do this in `formatLaunchCommand`.
- **No `/dev/null`** on Windows — use `NUL`, or just discard the stream in Node.
- **Env vars in PowerShell**: `$env:NAME`, not `$NAME`. Line continuation is backtick (`` ` ``), not backslash.
- **`.cmd` / `.bat` / `.exe` shims**: spawning npm-installed CLIs (e.g. `codex`, `where`) needs `shell: true` on Windows so `PATHEXT` is consulted; otherwise Node only finds extensionless executables. Pattern: `spawn(cmd, args, { shell: isWindows(), windowsHide: true })`.
- **`windowsHide: true`** on every `spawn`/`execFile` you don't want flashing a console window.
- **Always `shellEscape()`** any value that ends up in a shell command line, even on Windows. Windows quoting rules are tricky and the helper handles them.
- **Avoid pipes / redirection in shell strings** — they don't behave consistently across cmd.exe / PowerShell / bash. Build the pipeline in Node with stream APIs instead.
- **`$(cat …)` substitution** doesn't exist in PowerShell or cmd.exe. If you're inlining a file's contents into a command line, read it in Node and pass the contents as an argument (e.g. `--append-system-prompt <content>`).

## Networking

- **Bind to `127.0.0.1` explicitly, not `localhost`**, when starting local servers. On Windows `localhost` resolves to `::1` first; if the server only listens on IPv4 the client stalls ~21 s before the kernel falls back. The same problem reverses if you bind IPv6-only.
- **Named pipes** are the Windows IPC primitive (`\\.\pipe\…`); the relay code already handles them in `mux-websocket.ts` via `handleWindowsPipeMessage`. Don't introduce Unix-socket assumptions in new code paths.
- **Firewall prompts**: any `0.0.0.0` bind on Windows can pop a Windows Defender Firewall prompt the first time it runs. Stick to loopback unless there's a real reason.
- **Pipe path injection**: a pipe path is constructed from a session ID; always validate that ID with `validateSessionId()` before passing to `getPipePath()` or interpolating into any system call.

## POSIX-only tools

`tmux`, `screen`, `lsof`, `pkill`, `which`, most coreutils — gone on Windows. If you need their function, either branch through `platform.ts` or use a Node API instead.

Examples already in `platform.ts`:
- `findPidByPort` uses `netstat -ano` on Windows vs `lsof` elsewhere
- `killProcessTree` uses `taskkill /T /F` vs POSIX signal-based kill
- `getShell` resolves PowerShell on Windows vs `/bin/sh` on POSIX

If you find yourself reaching for a POSIX-only binary in new code, **add the Windows alternative to `platform.ts`** rather than gating the feature.

## Agent plugin specifics (Windows)

When writing or modifying an agent plugin (`packages/plugins/agent-*`), these are the patterns to follow:

- **Use `setupPathWrapperWorkspace`** for PATH-wrapper interception (gh / git). It auto-handles bash vs `.cmd`+`.cjs` wrappers per platform.
- **`isProcessRunning`** must short-circuit on Windows when it would have used tmux or `ps -eo`: `if (isWindows()) return false` (or implement a real Windows check via tasklist / signal-0 with EPERM handling — never assume tmux exists).
- **`detect()`** spawn options should be `{ shell: isWindows(), windowsHide: true }` so `.cmd` shims resolve via `PATHEXT` and no console window flashes.
- **Stderr suppression** — the cursor plugin's `detect()` previously bled stderr to the user's console on Windows; it now uses `stdio: ['ignore', 'pipe', 'ignore']` for the probe. Match that pattern.
- **`getCachedProcessList()`** (Claude Code) should return `""` on Windows — `ps -eo` doesn't exist.
- **`formatLaunchCommand`**: when the binary is at a quoted absolute path, prepend `& ` on Windows so PowerShell parses it as a call.
- **`systemPromptFile`**: instead of `$(cat <file>)` shell substitution, read the file in Node and inline as `--append-system-prompt <content>`.
- **Codex binary resolution**: prefer `.cmd` shims (npm) over `.exe` (Cargo) on Windows; use `where.exe` (not `which`).

## Activity-state helpers

The activity-detection contract in CLAUDE.md is platform-agnostic — same JSONL on all platforms — but the inputs (terminal output) come from different runtimes. Use `recordTerminalActivity` from core (which delegates to `classifyTerminalActivity` → `appendActivityEntry`) so you don't have to think about platform.

The mandatory `getActivityFallbackState` step (see CLAUDE.md "Activity detection architecture") is what keeps the dashboard alive when a native agent API is unavailable — which on Windows happens more often than on Unix because more things shell-out and fail silently. Skipping it has historically broken stuck-detection on Windows.

---

## Testing for cross-platform behaviour

CI runs on Linux, macOS, and Windows. To make platform-specific code reviewable in a single host environment and to catch regressions even when one runner is unavailable:

- Any new function in `platform.ts` (or platform-branching elsewhere) must have **both** an `it.skipIf(process.platform !== "win32")` test and a POSIX test. See `packages/cli/__tests__/lib/path-equality.test.ts` for the pattern (it mocks `process.platform` via `Object.defineProperty` to exercise both branches on a single CI host).
- For process-kill / EPERM-handling code, add a unit test that simulates `process.kill` throwing `{ code: "EPERM" }` and asserts force-kill is still attempted. The `runtime-process` test suite has examples (look for "win32 destroy when graceful shutdown times out").
- Plugin tests that hit a tmux runtime must `skipIf(isWindows())`. Plugin tests that hit `runtime-process` should run on all platforms.
- For path code, test mixed-case inputs and inputs with spaces.

Pattern for mocking platform on Linux CI:

```ts
let originalPlatform: PropertyDescriptor | undefined;
beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
});
afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
```

---

## Pre-merge checklist

Before saying "done" on any feature, verify each of these (or mark N/A with reasoning):

1. **No raw `process.platform` checks** — used `isWindows()` from `@aoagents/ao-core`?
2. **Process spawning** — used `runtime-process` (Windows) or `runtime-tmux` (POSIX) abstractions? Shell-out used `shellEscape` + `getShell` or `execFile`? `windowsHide: true` and `shell: isWindows()` for `.cmd`/`.bat` resolution?
3. **Process killing** — distinguished `EPERM` from `ESRCH`? No negative PIDs? Used `killProcessTree`? Guarded `pid > 0`? Cooperative kill before force-kill on Windows?
4. **Paths** — used `pathsEqual` for comparison? `path.join` for construction? No `===`, no hardcoded `/` or `\`?
5. **Shell** — no bash-isms (`&&` chains, `$(cat)`, `$VAR`, `/dev/null`)? `& ` prefix for quoted-path PowerShell calls? Routed through `getShell()` or used `execFile`?
6. **Networking** — explicit `127.0.0.1` instead of `localhost`? Validated session IDs before constructing pipe paths?
7. **Runtimes** — both `runtime-tmux` and `runtime-process` paths covered? `isProcessRunning` works for tmux TTY *and* PID signal-0 *with EPERM handling*?
8. **Agent plugins** — `setupPathWrapperWorkspace` instead of bash hooks? `getActivityFallbackState` fallback in `getActivityState`?
9. **New platform branching** — went into `platform.ts` (or another shared helper), not inline at call sites?
10. **Tests** — both Windows and POSIX branches covered (mock `process.platform` if you can't run on both)?

If you can't say "yes" or "N/A" to all ten, your change probably breaks Windows.

---

## Quick reference: "where do I import X from?"

```ts
// Platform check, runtime/shell/env defaults, process kill, port lookup
import {
  isWindows, getDefaultRuntime, getShell,
  killProcessTree, findPidByPort, getEnvDefaults,
  shellEscape,
  setupPathWrapperWorkspace, buildAgentPath,
  registerWindowsPtyHost, unregisterWindowsPtyHost,
  getWindowsPtyHosts, clearWindowsPtyHostRegistry,
  appendActivityEntry, readLastActivityEntry,
  checkActivityLogState, getActivityFallbackState,
  classifyTerminalActivity, recordTerminalActivity,
  readLastJsonlEntry,
} from "@aoagents/ao-core";

// Path comparison (CLI package)
import { pathsEqual, canonicalCompareKey }
  from "../../src/lib/path-equality.js";

// Windows pty-host pipe protocol + sweep
import {
  getPipePath, connectPtyHost, ptyHostSendMessage,
  ptyHostGetOutput, ptyHostIsAlive, ptyHostKill,
  MessageParser, encodeMessage,
  sweepWindowsPtyHosts,
} from "@aoagents/ao-plugin-runtime-process";

// Web-side helpers
import { validateSessionId, resolvePipePath }
  from "@/server/tmux-utils";
import { stopStaleWindowsPtyHosts }
  from "@/lib/windows-pty-cleanup";

// CLI-only signal forwarding (POSIX only — guard with !isWindows())
import { forwardSignalsToChild } from "../lib/shell.js";
```

If a helper you need isn't in this list, that's a strong signal you should add it to `platform.ts` (or the closest existing module) rather than write platform-branching at the call site.
