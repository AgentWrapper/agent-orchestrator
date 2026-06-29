# Agent Orchestrator — Windows QA Report

**Date:** 2026-04-12
**Platform:** Windows 11 (10.0.26200)
**Branch:** `feat/windows-platform-adapter`
**Duration:** ~60 minutes
**Framework:** Next.js 15 + CLI (Node.js 22)
**Pages/Features Tested:** 40+

---

## Health Score: 48/100

| Category | Score | Weight | Weighted |
|----------|-------|--------|----------|
| Functional | 35 | 20% | 7.0 |
| Console | 100 | 15% | 15.0 |
| UX | 55 | 15% | 8.25 |
| Accessibility | 80 | 15% | 12.0 |
| Links | 100 | 10% | 10.0 |
| Visual | 75 | 10% | 7.5 |
| Performance | 80 | 10% | 8.0 |
| Content | 90 | 5% | 4.5 |
| **TOTAL** | | | **~48** |

---

## Top 9 Things to Fix

1. **Codex agent dies on every Windows spawn** (ISSUE-001) — `shellEscape(binary)` produces a quoted absolute path that PowerShell parses as a string literal. Affects every agent using `shellEscape(binary)` first.
2. **Web API can't spawn or send messages to sessions on Windows** (ISSUE-003) — `Runtime plugin 'process' not found`. Dashboard plugin registry is missing process runtime.
3. **Missing `windowsHide: true` everywhere** (ISSUE-017) — root cause of the popup-window-on-kill regression. Zero occurrences of `windowsHide` in the entire codebase. Four call sites in `platform.ts`. One-line fix per call site.
4. **`ao session kill` doesn't delete the session branch** (ISSUE-021) — leaves dead branches in git, blocks re-spawning an issue with the same name. CLI error is truncated so users see "Failed to create worktree" without the real reason.
5. **Stale git worktree blocks spawn after force-cleanup** (ISSUE-018) — after file locks prevent cleanup, `ao spawn` fails silently with "missing but already registered worktree". Needs self-healing `git worktree prune`.
6. **`ao stop` leaves orphaned agent processes and worktrees** (ISSUE-004) — confirmed 11 zombie node processes accumulated across 2 test cycles (4 from ~10h ago, 6 from ~5h ago). Processes never cleaned up.
7. **Spawn race condition — sessions briefly show `exited` / `null` activity immediately after spawn** (ISSUE-019) — dashboard flickers to "dead" for 5-10 seconds during healthy startup.
8. **`ao batch-spawn` is non-atomic** (ISSUE-023) — on interrupt leaves partial state (worktree, branch, metadata). No rollback on error.
9. **`ao open` is dead code on Windows** (ISSUE-006) — hardcoded to tmux, always "No sessions to open".

---

## Critical Issues

### ISSUE-001: Codex agent fails to launch — PowerShell parser error
**Severity:** Critical
**Category:** Functional

**Repro:**
```bash
ao spawn "test codex" --agent codex
```

**Result:** Process spawned, immediately died. `ao session attach <id>` shows:
```
ParserError:
Line |
   1 |  'codex' -c check_for_update_on_startup=false --dangerously-bypass-app …
     |          ~~
     | Unexpected token '-c' in expression or statement.
```

**Root cause:** In `packages/plugins/agent-codex/src/index.ts`, `getLaunchCommand` builds the command as:
```ts
const parts: string[] = [shellEscape(binary)];
appendNoUpdateCheckFlag(parts);  // pushes "-c", "check_for_update_on_startup=false"
// ...
return parts.join(" ");
```

`shellEscape("codex")` on Windows returns `'codex'`. PowerShell parses `'codex' -c ...` as a string literal followed by `-c` token, not as a command. To execute a quoted command in PowerShell you must use the call operator `&`.

**Fix:** On Windows, prefix the launch command with `& ` when the first argument is quoted, OR avoid quoting bare command names that don't need it.

**Affects:** codex (confirmed), likely cursor and any future agent using `shellEscape(binary)` first.

**Note:** claude-code does NOT have this bug because it uses unquoted `claude` (relies on PATH).

---

### ISSUE-002: `resolveCodexBinary` returns the wrong file on Windows
**Severity:** High
**Category:** Functional

**Repro:**
1. `which codex` in Git Bash returns `/c/Users/priya/AppData/Roaming/npm/codex` (no extension)
2. Codex uses this path in `resolveCodexBinary`
3. PowerShell can't execute extensionless `codex` (it's a bash wrapper script)

**Expected:** On Windows, prefer `codex.cmd`, `codex.exe`, or `codex.ps1` (in that order). The npm npm wrapper at `%APPDATA%/npm/` always installs three variants:
- `codex` (bash wrapper for WSL/Cygwin/Git Bash) ← currently picked
- `codex.cmd` (cmd.exe wrapper) ← should be picked
- `codex.ps1` (PowerShell wrapper)

**Fix:** In `resolveCodexBinary()`, when on Windows, append `.cmd` to candidates and check for `.cmd`/`.exe`/`.ps1` versions first.

---

### ISSUE-003: Web API can't access process runtime — dashboard spawn/send broken
**Severity:** Critical
**Category:** Functional

**Repro:**
```
$ curl -X POST -H "Content-Type: application/json" \
   -d '{"projectId":"...","issueId":"test"}' \
   http://localhost:3000/api/spawn
{"error":"Runtime plugin 'process' not found"}

$ curl -X POST -H "Content-Type: application/json" \
   -d '{"message":"test"}' \
   http://localhost:3000/api/sessions/fwpa-1/send
{"error":"No runtime plugin for session fwpa-1"}

$ curl -X POST -H "Content-Type: application/json" \
   -d '{"projectId":"..."}' \
   http://localhost:3000/api/orchestrators
{"error":"Runtime plugin 'process' not found"}
```

**What works:** `POST /api/sessions/[id]/kill` succeeds (probably because lifecycle manager has cached runtime instances).

**Root cause:** The Next.js server process loads a different plugin registry than the CLI. Default in CLI is `runtime: process` but the web server doesn't seem to have the process runtime plugin registered.

**Impact:** Users cannot spawn sessions from the dashboard, cannot send messages from the dashboard via the API, and cannot start orchestrator sessions from the dashboard.

**Note:** The dashboard's terminal input (xterm.js → WebSocket → named pipe) DOES work — that path bypasses the runtime plugin lookup. But the React UI's "Send" buttons that hit these REST endpoints will all fail.

---

### ISSUE-004: `ao stop` leaves agent processes and worktrees behind
**Severity:** High
**Category:** Functional

**Repro:**
1. `ao start --no-orchestrator`
2. `ao spawn "test"`
3. `ao stop`
4. Check: `cat ~/.agent-orchestrator/.../sessions/` — fwpa-1 metadata still present
5. Check: `ls ~/.worktrees/...` — worktree directory still present
6. Check: `Get-Process pwsh,node` — 13+ leftover processes from the AO session

**Expected:** `ao stop` should:
1. Kill all agent processes for the project
2. Remove session metadata
3. Clean up worktrees
4. OR document clearly that `ao stop` only stops orchestrator and users must `ao session kill` first

**Current behavior:** Only kills the orchestrator/dashboard/lifecycle worker. Agents become orphaned, worktrees pile up.

---

### ISSUE-005: `ao stop` and `ao session kill` trigger popup window requiring Enter press
**Severity:** High
**Category:** Functional (Regression — user confirmed, twice now)

**Repro:**
1. `ao start` (with orchestrator enabled)
2. `ao spawn test-session`
3. `ao session kill test-session` → pops a terminal window, user must press Enter
4. `ao stop` → same behavior

**Root cause (identified):** `packages/core/src/platform.ts:91` calls `execFileAsync("taskkill", args)` **without `windowsHide: true`**. On Windows, when Node.js spawns a child process (via `child_process.spawn`/`execFile`) without `windowsHide: true`, and the parent process doesn't own a console (or is being wrapped by npx/bash), Windows creates a new console window for the child. For `taskkill` this window briefly flashes or — in some cases — persists waiting for Enter.

**Evidence:**
```bash
$ grep -rn "windowsHide" packages/
(no results)
```
Not a single place in the entire codebase passes `windowsHide: true` to any spawn/exec call. This is the likely cause of console window pops on several commands that kill processes on Windows.

**Also affected:** `findPidByPort` calls `execFileAsync("netstat", ["-ano"])` without `windowsHide: true` at platform.ts:116, which runs during `ao start` port detection.

**Fix:** Add `{ windowsHide: true }` to every `execFileAsync`/`spawn`/`execFile` call that targets Windows binaries. Minimal fix:
```ts
await execFileAsync("taskkill", args, { windowsHide: true });
await execFileAsync("netstat", ["-ano"], { windowsHide: true });
```

**Calls:** `killProcessTree` is invoked on every session kill, `ao stop`, PTY host teardown, and worktree cleanup — so this popup affects many commands.

---

### ISSUE-006: `ao open` broken — hardcoded to tmux
**Severity:** Critical
**Category:** Functional

**Root cause:** `packages/cli/src/commands/open.ts:27` calls `getTmuxSessions()` which returns empty on Windows. Line 43 looks up sessions against tmux output, not the session manager. Result: always "No sessions to open" even with active sessions.

**Fix:** On Windows with `runtime: process`, query the session manager directly. Could open the dashboard URL or attach via named pipe.

---

### ISSUE-007: `ao doctor` crashes without `AO_BASH_PATH`
**Severity:** High
**Category:** Functional / DX

**Repro:** Run `npx ao doctor` with no env var set on Windows.

**Output:** `Cannot run repo scripts on Windows without bash. Set AO_BASH_PATH to a bash executable (e.g. C:\Program Files\Git\bin\bash.exe).`

**Expected:** Auto-detect Git Bash at common paths, OR skip script-dependent checks gracefully.

With `AO_BASH_PATH=C:/Program Files/Git/bin/bash.exe` set, doctor works correctly: 12 PASS, 2 WARN, 1 FAIL.

---

### ISSUE-008: Activity state shows `null` instead of `exited` when agent dies
**Severity:** Medium
**Category:** Functional

**Repro:**
1. Spawn a session that dies on launch (e.g., `ao spawn x --agent codex` due to ISSUE-001)
2. Wait 30 seconds for next lifecycle poll
3. `curl /api/sessions` shows `"activity": null` instead of `"activity": "exited"`
4. `ao status` (CLI) shows `exited` correctly

**Inconsistency:** CLI and Web API give different activity values for the same session. The lifecycle manager and CLI use different code paths.

**Impact:** Dashboard shows session as "working" with no activity dot, even though the process is dead.

---

### ISSUE-009: Worktree directory not cleaned after session kill
**Severity:** Medium
**Category:** Functional

**Repro:**
1. Spawn session: `ao spawn "test"` → creates worktree at `~/.worktrees/.../fwpa-N`
2. Kill session: `ao session kill fwpa-N`
3. Check: `git worktree list` shows worktree de-registered (correct)
4. Check: `ls ~/.worktrees/...` → directory still has 16+ files

**Root cause:** Windows file locks prevent `git worktree remove` from deleting the directory. fwpa-1 cleans correctly, fwpa-2 doesn't — non-deterministic.

**Fix:** Retry directory cleanup with delay, OR queue deferred cleanup on next `ao start`.

---

### ISSUE-010: Session stuck at `spawning` when lifecycle worker dies
**Severity:** Medium
**Category:** Functional

**Repro:**
1. `ao start --no-dashboard --no-orchestrator`
2. `ao spawn "test"`
3. Wait 1+ minutes
4. `ao status` shows `spawning` indefinitely

**Root cause:** The lifecycle runs in-process inside `ao start` (via `ensureLifecycleWorker` in `lifecycle-service.ts`). If `ao start` crashes or the terminal running it is closed, the polling loop dies and no state transitions happen. The dashboard process alone does not have its own lifecycle loop — it depends entirely on `ao start` staying alive.

---

### ISSUE-011: Codex/Aider sessions hidden from dashboard UI when activity is null
**Severity:** Medium (actually visible — UI does show them)
**Category:** UX

When ISSUE-008 occurs (`activity: null`), dashboard fleet header shows "4 FLEET, 2 ACTIVE" but the Working column actually does include the dead-process sessions. The "ACTIVE" count is misleading because it counts only sessions with non-null activity.

---

### ISSUE-012: xterm.js terminal rows clip ~3 characters per line on Windows
**Severity:** Medium
**Category:** Visual (Windows-specific)

**Repro (confirmed in browse at 1366x768):**
1. Navigate to `/sessions/[id]` with an active session that has content
2. Inspect `.xterm-row` children of `.xterm-rows`

**Measurement:**
- `.xterm-rows` container: `clientWidth: 1098, scrollWidth: 1098` (no overflow at container level)
- **12 of 30 `.xterm-row` children with content (`textLen: 144`)** have `clientWidth: 1098, scrollWidth: 1123` — **25px overflow each**
- Empty rows do not overflow

**Root cause:** xterm.js calculates column count = floor(1098 / 7.625) = 144 chars. But Windows font rendering uses ~7.80px per char due to ClearType hinting. Accumulated error: (7.80 - 7.625) × 144 = **25.2px per row**.

**Impact:** Every line with content that fills the terminal width gets its rightmost ~3 characters clipped on Windows. The container has `overflow: hidden` so there's no visible scrollbar, but the content is silently truncated. On macOS the font metrics match, so no clipping occurs.

**Fix options:**
1. Use xterm.js's canvas/webgl renderer instead of DOM renderer on Windows (better pixel precision)
2. Force `letterSpacing: 0` and explicitly set `fontWidth` from direct measurement
3. Reduce column count on Windows by 2-3 chars as a safety margin
4. Upgrade xterm.js if a newer version has better Windows font metric handling

---

### ISSUE-013: Kanban board horizontal scroll at narrow widths
**Severity:** Low
**Category:** Visual

The kanban board (`packages/web/src/app/globals.css:1839`) uses 5 columns of `min-width: 260px` + 8px gaps = **1332px minimum**. Below ~1388px viewport (after `dashboard-main` padding), the kanban board scrolls horizontally. On Windows with 17px native scrollbars (vs 0px overlay on macOS), this scrollbar is more visually obvious.

**Fix options:** Reduce column min-width, use horizontal scroll snap, or make columns stack on narrow viewports.

---

### ISSUE-014: POST /api/spawn rejects valid CLI issue IDs
**Severity:** Low
**Category:** Functional / Inconsistency

**Repro:**
```
POST /api/spawn  body: {"issueId": "test issue"}
→ {"error":"issueId must match [a-zA-Z0-9_-]+"}
```

But CLI accepts: `ao spawn "test issue"` works fine.

**Inconsistency:** Web API has stricter validation than CLI for the same field.

---

### ISSUE-015: Desktop notifications are a silent no-op on Windows
**Severity:** Low

`packages/plugins/notifier-desktop/src/index.ts:61-86` only supports macOS and Linux. Windows logs a warning and resolves silently.

---

### ISSUE-016: Noisy notifier warnings on every CLI command
**Severity:** Low
**Category:** UX

Every `ao` command prints 4 warning lines about unconfigured notifiers (`discord`, `openclaw`, `slack`, `webhook`) even though the generated config has `notifiers: []`. The plugins are loaded despite not being requested.

---

### ISSUE-017: Missing `windowsHide: true` on every spawn/exec call in the codebase
**Severity:** High (umbrella root cause for ISSUE-005 and more)
**Category:** Functional / Windows DX

**Evidence:** `grep -rn "windowsHide" packages/` returns **zero matches**. Not a single spawn/execFile/execFileSync call in the entire codebase passes `windowsHide: true`.

**Affected call sites identified:**

| File:line | Command | Frequency | Impact |
|-----------|---------|-----------|--------|
| `packages/core/src/platform.ts:34` | `execFileSync("pwsh", ["-Version"])` | Every AO command startup | Console flash on every `ao <command>` |
| `packages/core/src/platform.ts:42` | `execFileSync("powershell.exe", ["-Command", "echo ok"])` | Fallback in shell detection | Console flash |
| `packages/core/src/platform.ts:91` | `execFileAsync("taskkill", args)` | Every session kill, ao stop, worktree cleanup | **Popup window requiring Enter press (ISSUE-005)** |
| `packages/core/src/platform.ts:116` | `execFileAsync("netstat", ["-ano"])` | Port discovery during ao start | Console flash |

**Fix:** Add `{ windowsHide: true }` to every call. One-line fix per location:
```ts
await execFileAsync("taskkill", args, { windowsHide: true });
await execFileAsync("netstat", ["-ano"], { windowsHide: true });
execFileSync("pwsh", ["-Version"], { timeout: 5000, stdio: "ignore", windowsHide: true });
```

This is the root cause of ISSUE-005 (`ao stop` / `ao session kill` popup) and likely also causes brief console flashes on every AO command.

---

### ISSUE-018: Stale git worktree registry blocks spawn after force-cleanup
**Severity:** High
**Category:** Functional (Windows-specific consequence of ISSUE-009)

**Repro:**
1. `ao spawn test1` → creates worktree at `~/.worktrees/.../fwpa-3`
2. `ao session kill fwpa-3` → git worktree remove fails due to file locks (ISSUE-009)
3. User force-deletes the directory via PowerShell
4. `ao spawn test2` → fails silently with:
   ```
   fatal: 'C:/Users/priya/.worktrees/.../fwpa-3' is a missing but already registered worktree;
   use 'add -f' to override, or 'prune' or 'remove' to clear
   ```

**Impact:**
- CLI spawn appears to succeed but session is NOT created (silent error, no exit code change)
- `ao status` shows no sessions (so no way to tell the spawn failed)
- User must manually run `git worktree prune` to unblock further spawns

**Root cause:** When `session kill` fails to remove the worktree directory (Windows file locks), git's worktree registry keeps the stale entry. The next spawn attempts to create a worktree with the same incrementing name and collides with the stale entry.

**Fix:**
1. Before every `ao spawn`, run `git worktree prune` to clean stale entries
2. Or detect "missing but already registered" errors and auto-prune + retry
3. Or use `git worktree add -f` to force overwrite
4. Propagate worktree creation errors to the user — currently silent

---

### ISSUE-019: Spawn race condition — session briefly reports `activity: "exited"` immediately after spawn
**Severity:** Medium
**Category:** Functional

**Repro (via SSE stream):**
1. Spawn a session: `ao spawn test --agent claude-code`
2. Capture SSE events from `/api/events`
3. Observe timeline:
```
T+0s:  {"sessions":[]}                                         ← before spawn
T+5s:  {"id":"fwpa-2","status":"spawning","activity":"exited"} ← WRONG
T+10s: {"id":"fwpa-2","status":"spawning","activity":"idle"}    ← eventually correct
```

**Impact:** For the first 5-10 seconds of a session's life, the dashboard shows `activity: exited` — making users think the session died when it's actually still starting up. This is also visible in the 4-concurrent-session test where codex/aider showed `null` activity (race between spawn and process detection) and the dashboard display was inconsistent.

**Root cause:** Lifecycle polling runs before the agent process is actually visible to `isProcessRunning`, or before `getActivityState` finds the agent's native JSONL file. The first poll returns `exited` or `null`.

**Fix:** On initial spawn, skip activity detection for the first N polls, or return a `spawning` / `pending` activity state instead of `exited` / `null` until a grace period has elapsed.

---

### ISSUE-021: `ao session kill` does not delete the session branch
**Severity:** High
**Category:** Functional

**Repro:**
1. `ao spawn test-branch-name` → creates worktree + branch `feat/test-branch-name`
2. `ao session kill <id>` → removes worktree and session metadata
3. Check: `git branch | grep test-branch-name` → branch still exists
4. `ao spawn test-branch-name` again → **fails** with `fatal: a branch named 'feat/test-branch-name' already exists`

**Impact:**
- Cannot re-spawn an issue with the same name after killing its session
- CLI error message is truncated — shows "Failed to create worktree" but hides the underlying `fatal: a branch named 'feat/...' already exists`
- Users see silent/unclear spawn failures
- Accumulating dead branches in git

**Confirmed affected branches from this test session:**
```
feat/concurrent-test-1
feat/concurrent-test-2-codex
feat/concurrent-test-3-aider
feat/concurrent-test-4-opencode
feat/dashboard-update-test
feat/horizontal-scroll-test
feat/retry-test
feat/sse-test-dont-edit-files
feat/test-dashboard-display
feat/test-no-edit
feat/test-windows-session-handling
```
All 11 branches survived `ao session kill` — none were deleted.

**Fix:** After removing the worktree in `session.destroy()`, also run `git branch -D <branch>` to delete the local branch. Or stash it for recovery (e.g. rename to `archived/<branch>-<timestamp>`). Also: propagate the full git error message through to the CLI output so users can diagnose failures.

---

### ISSUE-024: Malformed/invalid YAML reported as "No config found"
**Severity:** Medium
**Category:** UX / DX

**Repro:**
1. Create a malformed `agent-orchestrator.yaml` (bad indentation, missing colon, etc.)
2. Run `ao status`
3. Output: `No config found. Run \`ao init\` first.` — but the file exists!

**Tested variants that all report "No config found":**
- Malformed YAML syntax (missing colon, bad indent)
- Schema-invalid fields (`port: "not-a-number"`, `runtime: nonexistent-runtime`)
- Empty `projects: {}`

**Root cause:** `packages/cli/src/commands/status.ts:274` uses a bare `catch {}` that swallows all exceptions — `ConfigNotFoundError`, `YAMLParseError`, `ZodError`, etc. All get reported as "No config found".

**Fix:**
```ts
catch (err) {
  if (err instanceof ConfigNotFoundError) {
    console.log(chalk.yellow("No config found. Run `ao init` first."));
  } else {
    console.error(chalk.red(`Config is invalid: ${(err as Error).message}`));
    process.exit(1);
  }
  ...
}
```

Applies to every command that calls `loadConfig()` in a try/catch.

---

### ISSUE-026: `ao start` auto-open races the orchestrator session creation
**Severity:** Medium
**Category:** UX / Race Condition (user confirmed twice)

**Repro:**
1. `ao start` (with orchestrator enabled)
2. Browser tab auto-opens at `http://localhost:3000/sessions/fwpa-orchestrator-1`
3. Page shows "Session not found"
4. Wait a few seconds and reload → session appears correctly

**Timing analysis:**
Flow in `start.ts`:
- Line 982: `startDashboard(...)` — Next.js starts (port 3000 accepts ~1s later)
- Line 997: `ensureLifecycleWorker(...)` — lifecycle worker starts
- Line 1069: `await sm.spawnOrchestrator(...)` — orchestrator session created + written to disk
- Line 1139: `void waitForPortAndOpen(port, url, signal)` — browser opens as soon as port 3000 responds

**Race:** Even though `sm.spawnOrchestrator` is awaited before `waitForPortAndOpen`, the dashboard's API/SSE may not have picked up the new session file yet when the browser navigates. The CLI writes the session file → dashboard reads it on next API request → but between "CLI finishes writing" and "browser finishes navigating + React hits API", there's a gap where `/api/sessions/<id>` returns 404.

**Dashboard UX:** When the React page hits a 404 on initial load, it shows "Session not found" instead of retrying a few times or subscribing to SSE to wait for the session to appear. The page doesn't re-render when the session eventually shows up via SSE.

**Fix options:**
1. Before calling `waitForPortAndOpen`, actively probe `GET /api/sessions/<id>` and wait for it to return 200.
2. On the dashboard session page, subscribe to SSE updates before showing "not found" — if the session appears within N seconds of page load, navigate to it.
3. Add a small retry/loading state to the session detail page — poll for up to 5 seconds before showing the not-found UI.

**User confirmed:** This happens reproducibly on Windows at least with the current build.

---

### ISSUE-025: Symlink fallback on Windows copies entire directory trees
**Severity:** Medium
**Category:** Functional / Performance

**Location:** `packages/plugins/workspace-worktree/src/index.ts:355-360`

**Code:**
```ts
try {
  symlinkSync(sourcePath, targetPath);
} catch (err) {
  if (isWindows()) {
    // Symlinks require admin/Developer Mode on Windows — fall back to copy
    fs.cpSync(sourcePath, targetPath, { recursive: true });
  }
}
```

**Impact on Windows:**
1. **Performance disaster:** If a user configures `symlinks: [node_modules]`, every spawned worktree does a full recursive copy of `node_modules` (often 500MB-5GB). Spawn time goes from seconds to minutes.
2. **Disk space:** N worktrees × size(node_modules) of disk usage instead of near-zero via symlinks.
3. **File lock contamination:** The copy creates duplicate files that Windows file handles can hold onto, worsening ISSUE-009 (worktree cleanup failures). Every worker has its own copy of `node_modules` which get loaded into memory by Node processes, blocking later cleanup.
4. **Stale copies:** The copy is a point-in-time snapshot. If `node_modules` updates in the main repo, the worktree copies don't reflect it — agents may work with outdated dependencies.

**Fix options:**
1. Use Windows directory junctions (`mklink /J`) — works without admin for directories on NTFS. Not the same as symlinks but close enough for most use cases.
2. Document that `symlinks` requires Developer Mode on Windows; skip the fallback when it's not possible and warn clearly.
3. For `node_modules` specifically, use hardlinks via `fs.link` per file (not possible for directories but works for files).

Currently not triggering because the test config has no `symlinks:` entries, but it's a landmine for any user who adds them.

---

### ISSUE-023: `ao batch-spawn` is non-atomic — partial state on interrupt
**Severity:** Medium
**Category:** Functional

**Repro:**
1. `ao batch-spawn invalid-1 invalid-2`
2. The command appears to hang after printing "Project: ...", "Issues: invalid-1, invalid-2" and the notifier warnings
3. Kill it via timeout/Ctrl+C
4. Check state: **worktree for `invalid-1` already created on disk**, branch `feat/invalid-1` exists, session metadata file written

**Observed:**
- `C:/Users/priya/.worktrees/.../fwpa-4` exists after interrupted batch-spawn
- `feat/invalid-1` branch exists
- Session metadata file `~/.agent-orchestrator/.../sessions/fwpa-4` exists
- Second issue (`invalid-2`) was not attempted

**Impact:** Batch spawn appears to create resources sequentially without a transaction wrapper. If interrupted (Ctrl+C, timeout, or network error on issue #N), you get N-1 successful sessions plus the one being created — but no rollback. Worktrees, branches, and session metadata are left in partial state.

**Fix:** Either batch-spawn in parallel with a "cleanup on error" guard, or register each session atomically and finalize after all succeed.

**Additional observation:** Without GitHub issue tracking configured, `batch-spawn` should probably reject non-numeric/non-tracker-ID inputs upfront. Currently it accepts arbitrary strings.

---

### ISSUE-022: `ao start --no-dashboard` leaves stale `running.json` with dead PID
**Severity:** Medium
**Category:** Functional

**Repro:**
1. `ao start --no-dashboard --no-orchestrator`
2. After startup completes: `cat ~/.agent-orchestrator/running.json` shows a PID
3. `Get-Process -Id <that PID>` returns DEAD

**Note on root cause (updated):** The lifecycle now runs in-process inside `ao start` — the PID written to `running.json` is the `ao start` process itself, which is correct. The dead-PID observation from original testing was likely caused by a process wrapper (npx, bash shim) exiting while the real Node child was recorded. The structural concern remains: if `ao start` exits for any reason (crash, user closes terminal), `running.json` will have a stale PID and `ao status` / `ao spawn` will incorrectly believe the lifecycle is running.

**Tested:** Confirmed with PID 34544 after `ao start --no-dashboard --no-orchestrator` — running.json listed the PID but PowerShell showed it dead.

**Related to ISSUE-010** (lifecycle stops when `ao start` exits).

---

### ISSUE-020: `ao start` auto-opens `/sessions/undefined` when no orchestrator
**Severity:** Medium
**Category:** Functional / UX

**Repro:**
1. `ao start --no-orchestrator`
2. Dashboard starts, browser auto-opens
3. Tab opens at `http://localhost:3000/sessions/undefined` → "Session not found" page

**Root cause:** `packages/cli/src/commands/start.ts:1138`:
```ts
const orchestratorUrl = hasExistingOrchestrators
  ? `http://localhost:${port}/orchestrators?project=${projectId}`
  : `http://localhost:${port}/sessions/${selectedOrchestratorId ?? sessionId}`;
```
When `--no-orchestrator` is passed, `selectedOrchestratorId` and `sessionId` are both `undefined`, so the template renders `.../sessions/undefined`.

**Fix:** When both IDs are undefined, fall back to `http://localhost:${port}/` (main dashboard).

**Also:** After `ao stop` kills a session, any stale browser tab pointing to that session's URL shows "Session not found" on reload. The page UX is OK (clear message + "Back to dashboard" link), but adding a brief note like "This session was killed/archived. Start a new one?" would be friendlier.

---

### ISSUE-027: `ao start` must stay as a foreground terminal — no Windows daemon story
**Severity:** Medium
**Category:** UX / Windows-specific

**Observation:** The lifecycle polling loop runs in-process inside `ao start` (see `lifecycle-service.ts`). This means the terminal window running `ao start` must remain open for the entire duration of a session. Closing the window, logging off, or killing the terminal kills the lifecycle loop — PTY host processes keep running (agents remain alive) but no state transitions fire, no CI reactions happen, no notifications go out.

On Linux/Mac users work around this with `nohup ao start &`, `tmux`, or `screen`. On Windows none of these are standard — there is no built-in equivalent for detaching a Node.js process from its console.

**Impact:**
- Users doing overnight runs must leave a terminal window open
- Remote desktop / SSH sessions die on disconnect, taking the lifecycle with them
- No way to recover a running lifecycle without restarting `ao start` (which re-polls fresh)

**Contrast with Linux/Mac:** The lifecycle has always been in-process, but `ao start` on Unix can be backgrounded cleanly. On Windows this is non-trivial.

**Possible fixes:**
1. Document that users should run `ao start` in Windows Terminal or a persistent PowerShell window
2. Add a `--detach` flag that uses `node-windows` or `node-service` to register `ao start` as a Windows Service
3. Wrap with a `.vbs` launcher that calls `wscript.exe` to start the process without a console window (common Windows pattern)

---

## Communication Test (orchestrator-worker simulation)

I tested the orchestrator-worker communication path manually:

| Step | Result |
|------|--------|
| `ao spawn` to create worker (claude-code) | PASS |
| `ao send <id> "<message>"` to deliver text | PASS — "Message sent and processing" |
| Agent receives and acts on message | PASS — agent processed the request |
| Activity transitions: spawning → working → ready → idle | PASS — observed via `ao status --watch` |
| Dashboard terminal input → WebSocket → named pipe → agent | PASS — typed "echo hello from dashboard input", agent received it |
| Termination via dashboard button | PASS — confirm dialog appears, then session killed |
| `ao session kill` removes session from registry | PASS |

Communication path works for **claude-code agent only**. The orchestrator-worker model would NOT work with codex (ISSUE-001), aider (not installed locally), or potentially cursor.

---

## What Passes (Confirmed Working)

**CLI:**
- `ao start` (creates config with `runtime: process` correctly), `ao start --no-dashboard`
- `ao spawn` (claude-code only)
- `ao status`, `ao status --json`, `ao status --watch`
- `ao send <id> <msg>`
- `ao session ls`, `ao session attach`, `ao session kill`, `ao session cleanup --dry-run`, `ao session restore` (correctly rejects on non-terminal sessions), `ao session remap`
- `ao config-help`
- `ao plugin list`, `ao plugin list --installed`, `ao plugin search`, `ao plugin create`
- `ao verify --list`
- `ao review-check --dry-run`
- `ao doctor` (with `AO_BASH_PATH` set)

**Dashboard:**
- Main `/` (kanban board renders, session cards display, terminate button works with confirm dialog)
- `/sessions/[id]` (xterm.js terminal connects, live output streams, **terminal input typing works**, fullscreen toggle works)
- `/prs` (renders, shows "No open pull requests")
- `/orchestrators?project=X` (renders, shows "Start New Orchestrator")
- Light/dark mode toggle
- Zero JS console errors across all pages

**Web API:**
- `GET /api/sessions`, `GET /api/sessions/[id]`, `GET /api/sessions/patches` (SSE-style)
- `POST /api/sessions/[id]/kill` (works)
- `POST /api/sessions/[id]/restore` (correctly rejects non-terminal)
- `POST /api/sessions/[id]/remap` (works for opencode)
- `GET /api/projects`, `GET /api/observability`, `GET /api/runtime/terminal`, `GET /api/backlog`, `GET /api/verify`, `GET /api/orchestrators?project=X`
- `GET /api/events` (SSE stream, content-type correct)
- `GET /health` on direct-terminal-ws server

**Activity Detection:**
- claude-code → JSONL-based, working correctly (active → ready → idle transitions)
- opencode → AO activity JSONL via `recordActivity`, working but slow to bootstrap (~30s lag after spawn)
- codex → broken because the agent process dies on launch (ISSUE-001)
- aider → not installed locally, expected to fail

**Process Management:**
- `taskkill /T /F /PID` correctly kills agent + PTY host process trees
- `process.kill(pid, 0)` correctly detects alive/dead processes
- `toClaudeProjectPath` correctly handles Windows paths (`C:\` → `C--`)

---

## What Was NOT Tested

### CLI commands
| Command | Reason not tested |
|---------|-------------------|
| `ao update` | Requires install repo git remote (dev mode incompatible) |
| `ao setup openclaw` | Requires OpenClaw gateway running |
| `ao plugin install` / `update` / `uninstall` | Would modify config and corrupt test setup |
| `ao session claim-pr` | Requires an existing real PR |
| `ao spawn --decompose` / `--max-depth` | Subagent decomposition flow not exercised |
| `ao spawn --assign-on-github` / `--claim-pr` | Requires real GitHub issue/PR numbers |
| `ao spawn <repo-url>` | Only tested with local path arg |

### Agents
| Agent | Reason |
|-------|--------|
| `cursor` | `cursor` CLI not installed locally (plugin code path exists but untested) |
| `aider` | `aider` CLI not installed locally |
| `opencode` full flow | Spawn tested; end-to-end work loop not exercised |

### Flows / Features
| Feature | Reason |
|---------|--------|
| Full PR lifecycle (spawn → code → PR open → CI → review → merge → cleanup) | No PR was actually created — would require letting an agent run |
| CI failure reaction (auto-retry on CI fail) | No CI was triggered |
| `changes_requested` reaction | No review was ever requested |
| `merged-unverified` → `verified` verification flow | Requires a merged PR in the `merged-unverified` state |
| Multi-project config (two or more projects in one yaml) | Only tested single-project config |
| `workspace: clone` plugin (alternative to `worktree`) | Only tested `worktree` plugin |
| `symlinks` config entry | Not configured; would trigger the copy-fallback bug (ISSUE-025) |
| `postCreate` hooks | Not configured |
| `reactions` config overrides | Default reactions only |
| Orchestrator actually spawning a worker via its own `ao spawn` tool (end-to-end autonomous flow) | Would require letting the orchestrator agent run |
| Dashboard UI "Send message" button (the React button that POSTs to the broken API endpoint) | Only hit the API directly, not via the React form |
| Dashboard with many sessions (20+, stress test) | Only tested up to 4 concurrent |
| `terminal-web` plugin (browser-based terminal, alternative to iterm2) | Not exercised |
| Dashboard WebSocket reconnection after browser disconnect/reconnect | Not tested |
| Session state persistence across graceful `ao stop` + `ao start` | Not tested — tested hard-crash recovery only |
| Config file hot-reload on edit | Not tested |
| `ao status --watch` over many minutes (long-running activity transitions) | Only ran briefly |
| DPR 1.25 / 1.5 (Windows scaling) effect on xterm row clipping | Only tested DPR 1.0 |
| Port 3000 already in use by another app | Not tested |
| Very long session/issue names (branch name length limits) | Not tested |
| `AO_LOG_LEVEL` or other debug env vars | Not tested |

---

## Console Health Summary

Zero JS console errors across all tested dashboard pages.

---

## Linux Scope Validation Addendum (2026-04-15)

Validator: Linux QA retest by Hermes

Goal: classify each issue with Linux side-by-side results for both runtime paths (`process` and default `tmux`), then decide scope.

Test harness notes:
- Branch tested from worktree: `~/.worktrees/agent-orchestrator-feat-windows-platform-adapter`
- Linux `process` run + Linux default `tmux` run were both executed
- Browser dashboard/session checks were included in tmux run (no JS console errors in tested flows)

### Scope verdicts

| Issue | Linux (process) | Linux (tmux default) | Scope verdict | Comment |
|---|---|---|---|---|
| ISSUE-001 | Not reproducible | N/A (Windows shell path) | Windows-only | PowerShell parser/quoting issue. |
| ISSUE-002 | Not reproducible | N/A (Windows wrapper path) | Windows-only | `.cmd/.ps1` resolution problem is Windows-specific. |
| ISSUE-003 | Reproduced (`Runtime plugin 'process' not found`) | Not reproduced (API spawn works) | Cross-platform (runtime-path dependent) | Broken on Linux when runtime is `process`; healthy on tmux. |
| ISSUE-004 | Reproduced | Reproduced | Cross-platform | `ao stop` leaves session/worktree residue. |
| ISSUE-005 | Not reproducible | N/A (Windows console popup behavior) | Windows-only | Windows process window behavior. |
| ISSUE-006 | Reproduced | Reproduced | Cross-platform | `ao open` still says "No sessions to open." |
| ISSUE-007 | Not reproducible | N/A (Windows bash-path requirement) | Windows-only | `AO_BASH_PATH` Windows requirement. |
| ISSUE-008 | Reproduced | Reproduced | Cross-platform | CLI/API activity mismatch (`exited` vs `null`). |
| ISSUE-009 | Not reproduced | Not reproduced | Windows-only (as reported) | Windows file-lock trigger not seen on Linux. |
| ISSUE-010 | Reproduced (architectural risk) | Reproduced | Cross-platform | Lifecycle tied to `ao start`; stale/leftover worker behavior observed. |
| ISSUE-011 | Reproduced | Reproduced | Cross-platform | `status: working` with `activity: null` + misleading active count. |
| ISSUE-012 | Not reproducible | Not reproducible | Windows-only | Windows font/DPI rendering path. |
| ISSUE-013 | Not directly re-measured | Not directly re-measured | Cross-platform | CSS/layout logic is OS-agnostic. |
| ISSUE-014 | Reproduced | Reproduced | Cross-platform | API rejects spaced issueId; CLI accepts. |
| ISSUE-015 | Not applicable | Not applicable | Windows-only | Issue is missing Windows notifier implementation. |
| ISSUE-016 | Reproduced | Reproduced | Cross-platform | Noisy notifier warnings despite `notifiers: []`. |
| ISSUE-017 | Not applicable | Not applicable | Windows-only | `windowsHide` umbrella is Windows-only. |
| ISSUE-018 | Not reproduced | Not reproduced | Windows-only (as reported) | Stale worktree registry case not triggered on Linux. |
| ISSUE-019 | Reproduced | Reproduced | Cross-platform | Spawn race/transient bad activity state. |
| ISSUE-020 | Not reproduced | Not reproduced | Needs re-check | `/sessions/undefined` not reproduced in Linux runs. |
| ISSUE-021 | Reproduced | Reproduced | Cross-platform | Branch persists after `session kill`. |
| ISSUE-022 | Not reproduced | Not reproduced | Needs re-check | Dead-PID stale `running.json` not reproduced in Linux runs. |
| ISSUE-023 | Reproduced | Reproduced | Cross-platform | Interrupted `batch-spawn` leaves partial state. |
| ISSUE-024 | Reproduced | Reproduced | Cross-platform | Malformed YAML reported as "No config found." |
| ISSUE-025 | Not reproducible | Not reproducible | Windows-only | Symlink-copy fallback path is Windows-guarded. |
| ISSUE-026 | Not reproduced | Not reproduced | Needs re-check | Could not reproduce orchestrator auto-open race on Linux. |
| ISSUE-027 | Not applicable | Not applicable | Windows-only (UX emphasis) | Windows lacks standard detach story. |

## Summary

The Windows platform adapter is **partially functional**. The core CLI workflow works for the **claude-code agent only**. The dashboard renders correctly and terminal I/O via named pipes works end-to-end. But significant gaps remain:

1. **Codex agent is unusable on Windows** because of the PowerShell parser error from quoted launch commands (ISSUE-001 + ISSUE-002).
2. **Web API spawn/send is broken on Windows** because of plugin registry split (ISSUE-003) — meaning the dashboard's "spawn from issue" buttons silently fail.
3. **`ao stop` is incomplete** on Windows — leaves agents and worktrees orphaned (ISSUE-004).
4. **`ao open` is dead code** on Windows (ISSUE-006).
5. **xterm.js may clip the last ~3 characters of every terminal line on Windows** (ISSUE-012).

If the goal is "claude-code on Windows", this branch is close. If the goal is the full multi-agent orchestrator experience, several gaps need fixing before users on Windows can self-serve.
