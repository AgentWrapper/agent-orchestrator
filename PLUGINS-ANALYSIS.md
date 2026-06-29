# Plugin Audit Analysis

Deep audit of all 22 plugins in `packages/plugins/`. Each plugin was reviewed for:
- Full interface implementation (against `types.ts`)
- Unhandled error paths
- Shell injection vectors (`shellEscape` usage)
- Hardcoded secrets or paths
- Activity detection completeness (all 6 states for agents)
- Test coverage gaps

## Critical

### C-01: runtime-tmux: environment variable injection in tmux create
**Plugin:** runtime-tmux
**File:** `packages/plugins/runtime-tmux/src/index.ts:62-63`
**Description:** Environment variables are interpolated directly into tmux arguments without escaping. An env value containing shell metacharacters (spaces, quotes, newlines) can break the tmux command or inject unintended tmux flags.
```ts
envArgs.push("-e", `${key}=${value}`);
```
**Impact:** If an agent plugin produces environment values with special characters, the tmux `new-session` command may fail or behave unexpectedly. This is particularly risky for values like prompts or system prompt content that may contain quotes, newlines, or shell metacharacters.
**Suggested Fix:** Escape both key and value before passing to tmux. At minimum, values containing `=`, spaces, or quotes should be properly quoted or sanitized.

### C-02: runtime-tmux: `getAttachInfo` does not escape handle.id in shell command
**Plugin:** runtime-tmux
**File:** `packages/plugins/runtime-tmux/src/index.ts:178`
**Description:** The `getAttachInfo` method returns a shell command string with an unescaped `handle.id`:
```ts
command: `tmux attach -t ${handle.id}`,
```
While `handle.id` is validated against `SAFE_SESSION_ID` regex at creation time, this method is public and could be called with a handle whose `id` was set through other means. Defense-in-depth says escape it.
**Impact:** If a malformed handle reaches this code, the generated command could be a shell injection vector when displayed or executed.
**Suggested Fix:** Use `shellEscape(handle.id)` in the command string, or validate the handle.id at this point.

### C-03: runtime-tmux: short launch commands sent via `send-keys` without `-l` (literal mode)
**Plugin:** runtime-tmux
**File:** `packages/plugins/runtime-tmux/src/index.ts:79`
**Description:** Short launch commands (<200 chars) are sent via `send-keys` without the `-l` flag:
```ts
await tmux("send-keys", "-t", sessionName, config.launchCommand, "Enter");
```
The `-l` flag sends text literally (no key name interpretation). Without it, tmux interprets special key names. If a launch command contains words like "Enter", "Space", "Backspace", etc., they will be interpreted as key presses rather than literal text. Long commands (>200 chars) correctly use `-l`.
**Impact:** A launch command containing a substring matching a tmux key name (e.g., `echo "Enter your name"`) would be misinterpreted, causing incorrect command execution.
**Suggested Fix:** Always use `-l` for the text portion and send "Enter" separately, matching the pattern already used in `sendMessage()`:
```ts
await tmux("send-keys", "-t", sessionName, "-l", config.launchCommand);
await sleep(300);
await tmux("send-keys", "-t", sessionName, "Enter");
```

## High

### H-01: All non-claude-code agent plugins: `isProcessRunning` timeout is 30s, blocking the lifecycle poll loop
**Plugins:** agent-aider, agent-codex, agent-opencode, agent-cursor
**File:** Each plugin's `src/index.ts` in `isProcessRunning` method
**Description:** All four non-claude-code agent plugins use `timeout: 30_000` for both `tmux list-panes` and `ps -eo pid,tty,args` in `isProcessRunning`. The claude-code plugin correctly uses 5_000ms and adds a ps output cache (`getCachedProcessList`). The other four plugins spawn fresh `ps` calls with 30s timeouts for each session during every poll cycle.
**Impact:** On machines with many sessions or slow process listing, this can make the lifecycle poll loop extremely slow. If N sessions are active, N `ps` calls run with 30s timeouts each.
**Suggested Fix:** (1) Reduce timeout to 5_000ms to match claude-code. (2) Adopt the `getCachedProcessList()` TTL cache pattern from agent-claude-code.

### H-02: agent-aider, agent-cursor: `hasRecentCommits` uses `git log` with a 60s window — false positives
**Plugins:** agent-aider (`src/index.ts:40-48`), agent-cursor (`src/index.ts:40-48`)
**Description:** Both plugins check for commits within the last 60 seconds to determine if the agent is "active". However, this operates on the shared git repository (via worktree). If ANY process makes a commit in the worktree (e.g., a post-create hook, a git hook, a background process), the agent will falsely report as "active" even if it's idle or crashed.
```ts
const { stdout } = await execFileAsync(
  "git", ["log", "--since=60 seconds ago", "--format=%H"],
  { cwd: workspacePath, timeout: 5_000 },
);
```
**Impact:** False "active" states prevent the lifecycle manager from correctly detecting idle/stuck/exited sessions, leading to missed escalations and stuck sessions.
**Suggested Fix:** Filter commits by author/committer, or cross-reference with the agent's known activity patterns. Alternatively, remove this check entirely and rely on the JSONL fallback + native signal, which is more reliable.

### H-03: agent-claude-code: `getActivityState` returns "idle" when no session file exists yet
**Plugin:** agent-claude-code
**File:** `packages/plugins/agent-claude-code/src/index.ts:747`
**Description:** When no JSONL session file is found, `getActivityState` returns `{ state: "idle", timestamp: session.createdAt }`. This is incorrect for a freshly spawned session — it should return `"active"` (or at least `"ready"`) since the process IS running and the session was JUST created.
```ts
if (!sessionFile) {
  return { state: "idle", timestamp: session.createdAt };
}
```
**Impact:** A freshly spawned Claude Code session will appear as "idle" in the dashboard until the first JSONL entry is written. The lifecycle manager may incorrectly believe the agent is stuck or idle during the initial setup phase.
**Suggested Fix:** Check the session age — if `session.createdAt` is recent (within the active window), return `"active"` instead of `"idle"`. Or return `"ready"` since the process is running but hasn't started work yet.

### H-04: workspace-worktree, workspace-clone: `postCreate` commands run via `sh -c` without validation
**Plugins:** workspace-worktree (`src/index.ts:358`), workspace-clone (`src/index.ts:238`)
**Description:** Post-create commands from `agent-orchestrator.yaml` are executed directly via `sh -c`. While the code comments say "commands run with full shell privileges — they come from trusted YAML config", there is no validation of the command content. If the YAML config is user-controlled in a multi-user environment, this is a command injection vector.
```ts
await execFileAsync("sh", ["-c", command], { cwd: info.path });
```
**Impact:** Arbitrary command execution if the config file is tampered with or comes from an untrusted source.
**Suggested Fix:** Document this as an accepted risk for single-user contexts. For multi-user deployments, consider adding a command allowlist or sandboxing mechanism. At minimum, log the commands being executed for auditability.

### H-05: scm-gitlab: `verifyGitLabToken` uses SHA-256 hashing before comparison, weakening the secret
**Plugin:** scm-gitlab
**File:** `packages/plugins/scm-gitlab/src/index.ts:138-139`
**Description:** The GitLab token verification hashes both the secret and the provided token with SHA-256 before comparing. While this avoids timing attacks, it effectively reduces the comparison to SHA-256 collisions rather than the full secret space. More importantly, the GitLab webhook token is a simple static token (not HMAC), so the correct approach is a direct comparison or timing-safe string comparison, not hashing.
```ts
function verifyGitLabToken(secret: string, providedToken: string): boolean {
  const toDigest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(toDigest(secret), toDigest(providedToken));
}
```
**Impact:** Hashing the inputs before comparison means two different tokens that hash to the same value would be accepted (theoretically possible with SHA-256 length extension or collision attacks, though practically very unlikely). The real issue is that this is semantically wrong — GitLab webhook tokens are static, not HMAC'd, so a simple timing-safe comparison of the raw strings is the correct approach.
**Suggested Fix:** Use a direct timing-safe comparison of the raw token strings:
```ts
function verifyGitLabToken(secret: string, providedToken: string): boolean {
  const a = Buffer.from(secret, "utf-8");
  const b = Buffer.from(providedToken, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```
Or better, use `crypto.timingSafeEqual` with length-normalized buffers (pad shorter one).

### H-06: agent-codex: `model_instructions_file` config key passed unescaped to `-c` flag
**Plugin:** agent-codex
**File:** `packages/plugins/agent-codex/src/index.ts:467`
**Description:** The system prompt file path is passed to Codex's `-c` config flag, but only the file path is shell-escaped, not the entire `key=value` string. Codex may interpret the `=` sign or other characters differently:
```ts
parts.push("-c", `model_instructions_file=${shellEscape(config.systemPromptFile)}`);
```
**Impact:** If `systemPromptFile` contains special characters, the config override may not parse correctly. The `shellEscape` call wraps the value in single quotes, which should be safe for the shell, but the config key format (`key='value'`) may not be what Codex expects.
**Suggested Fix:** Verify that Codex handles single-quoted values in `-c` flags. If not, consider alternative escaping or passing the config via environment variable.

## Medium

### M-01: tracker-github: `updateIssue` makes multiple sequential API calls for a single update
**Plugin:** tracker-github
**File:** `packages/plugins/tracker-github/src/index.ts:263-328`
**Description:** `updateIssue` makes up to 4 separate `gh` CLI calls (state, remove-labels, add-labels, assignee, comment) for a single update. Each is a separate process spawn with a 30s timeout. A batch approach using the GitHub API directly would be more efficient.
**Impact:** Performance degradation when updating multiple fields. If one call fails partway through, the issue is left in a partially updated state.
**Suggested Fix:** Consider using `gh api` with a single GraphQL mutation to update multiple fields atomically.

### M-02: tracker-linear: `updateIssue` is extremely chatty — makes 4-6 API roundtrips
**Plugin:** tracker-linear
**File:** `packages/plugins/tracker-linear/src/index.ts:437-575`
**Description:** Updating a Linear issue requires: (1) fetch issue UUID + team ID, (2) fetch workflow states, (3) update state, (4) fetch users, (5) update assignee, (6) fetch existing labels, (7) fetch label IDs, (8) update labels, (9) add comment. That's up to 9 GraphQL requests for a single update.
**Impact:** Severe performance degradation. Linear API rate limits may be hit. The update is also non-atomic.
**Suggested Fix:** Use Linear's `issueUpdate` mutation which accepts multiple fields in a single call. Pre-cache workflow state IDs and label IDs to avoid repeated lookups.

### M-03: agent-claude-code: `psCache` is module-level, not per-instance — tests can leak state
**Plugin:** agent-claude-code
**File:** `packages/plugins/agent-claude-code/src/index.ts:423-424`
**Description:** The `psCache` variable is module-level (not scoped to the agent instance). If multiple `create()` calls are made, they share the same cache. This also means tests that don't call `resetPsCache()` between tests can get stale results.
```ts
let psCache: { output: string; timestamp: number; promise?: Promise<string> } | null = null;
```
**Impact:** Test flakiness if cache isn't properly reset. In production, multiple agent instances sharing a cache is actually desirable for performance, so this is a minor concern.
**Suggested Fix:** Document that `resetPsCache()` must be called in `beforeEach`. The module-level cache is appropriate for production use.

### M-04: agent-codex: `sessionFileCache` is module-level — never cleared between sessions
**Plugin:** agent-codex
**File:** `packages/plugins/agent-codex/src/index.ts:431`
**Description:** The `sessionFileCache` is a module-level `Map` that caches session file paths for 30 seconds. The `_resetSessionFileCache()` export exists for tests, but the cache can grow unboundedly if many different workspace paths are used over time (each workspace gets its own cache entry that expires but is never removed).
```ts
const sessionFileCache = new Map<string, { path: string | null; expiry: number }>();
```
**Impact:** Minor memory leak in long-running processes with many different workspace paths. The 30s TTL means stale entries don't cause incorrect behavior.
**Suggested Fix:** Add periodic cleanup of expired entries, or use a LRU cache with a size limit.

### M-05: scm-github: `getAutomatedComments` fetches ALL review comments then filters for bots
**Plugin:** scm-github
**File:** `packages/plugins/scm-github/src/index.ts:870-946`
**Description:** The method fetches all review comments (paginated, up to 100 per page) and then filters client-side for bot authors. For PRs with many human review comments, this is wasteful.
**Impact:** Performance issue on PRs with hundreds of review comments. API rate limit consumption.
**Suggested Fix:** Use the GitHub GraphQL API to filter by author at the query level, or use the REST API's filtering capabilities.

### M-06: All agent plugins except claude-code: No `blocked` state detection in `detectActivity`
**Plugins:** agent-aider, agent-codex, agent-opencode, agent-cursor
**File:** Each plugin's `detectActivity` method
**Description:** None of these four plugins return `"blocked"` from `detectActivity`. While the JSONL-based `getActivityState` can detect blocked states, the `detectActivity` function (used by `recordActivity` to classify terminal output) never produces `"blocked"`. This means the AO activity JSONL will never contain `"blocked"` entries from terminal output for these agents.
**Impact:** If the native signal source (session list API, git commits, etc.) is unavailable, `getActivityState` falls back to JSONL, which will never contain "blocked" entries. The agent could be stuck in an error loop and the dashboard would show "active" or "idle" instead of "blocked".
**Suggested Fix:** Add error-detection patterns to `detectActivity` for each agent's specific error output (e.g., Codex's error messages, Aider's crash output, OpenCode's error states). Agent-cursor's comment about this is instructive — they explicitly chose not to detect "blocked" because terminal-based detection is unreliable. This is a reasonable trade-off, but it should be documented.

### M-07: notifier-desktop: `sendNotification` rejects on error, causing unhandled promise rejection if caller doesn't catch
**Plugin:** notifier-desktop
**File:** `packages/plugins/notifier-desktop/src/index.ts:60-88`
**Description:** The `sendNotification` function rejects the promise if `osascript` or `notify-send` fails. The `notify` method calls it with `await`, so errors propagate up. If the caller (lifecycle manager) doesn't handle notification errors gracefully, a desktop notification failure could crash or stall the notification pipeline.
**Impact:** Non-critical — notification failures should not break the orchestrator. But the error propagation could cause noisy error logs or unhandled rejections in some call paths.
**Suggested Fix:** Wrap `sendNotification` in try/catch within `notify` and log the error instead of throwing.

### M-08: agent-cursor: `processName: "agent"` is extremely generic — matches many processes
**Plugin:** agent-cursor
**File:** `packages/plugins/agent-cursor/src/index.ts:158`
**Description:** The Cursor agent's `processName` is `"agent"`. The regex in `isProcessRunning` tries to handle this with `\.?agent\b`, but this still matches processes like "agent-monitor", "ssh-agent", "gpg-agent", etc. The `detect()` method checks `--help` output for Cursor-specific markers, which is good, but `isProcessRunning` uses a broader regex.
```ts
const processRe = /(?:^|\/)\.?agent\b(?:\s|$)/;
```
**Impact:** False positives in `isProcessRunning` when other "agent" processes run on the same TTY. This could make a dead Cursor session appear alive.
**Suggested Fix:** Consider matching the full binary path or using a more specific process name. The `\b` word boundary helps but "agent" is too common a word to reliably match. Consider checking `/proc/PID/cmdline` or the full process path for a Cursor-specific prefix.

### M-09: All notifier plugins: No deduplication or rate limiting
**Plugins:** notifier-desktop, notifier-slack, notifier-webhook, notifier-composio, notifier-openclaw, notifier-discord
**Description:** None of the notifier plugins implement any form of notification deduplication or rate limiting. If the lifecycle manager emits many events for the same session in quick succession (e.g., rapid state transitions), all notifications are sent immediately. This can result in notification spam.
**Impact:** Users may receive dozens of notifications in seconds for a single session. This is a UX issue, not a correctness issue.
**Suggested Fix:** Consider adding a notification cooldown or deduplication layer in the orchestrator's notification dispatcher (not in individual plugins, since dedup should be cross-plugin).

### M-10: workspace-clone: `clone` command uses `--reference` without `--dissociate`
**Plugin:** workspace-clone
**File:** `packages/plugins/workspace-clone/src/index.ts:83-91`
**Description:** The clone uses `--reference` for object sharing but doesn't use `--dissociate`. This means the clone remains dependent on the source repository's objects. If the source repository is repacked or garbage collected, the clone may become corrupted.
**Impact:** Clone corruption if the source repository is maintained (gc, repack) while clones exist.
**Suggested Fix:** Add `--dissociate` after the initial clone to copy all referenced objects into the clone, making it independent.

### M-11: agent-opencode: `getLaunchCommand` generates a complex multi-line shell script — fragile
**Plugin:** agent-opencode
**File:** `packages/plugins/agent-opencode/src/index.ts:249-258`
**Description:** When no existing session is found, the launch command is a 3-statement shell script with pipes, variable capture, and fallback logic:
```ts
return [
  `SES_ID=$(${runCommand} | node -e ${shellEscape(captureScript)})`,
  `if [ -z "$SES_ID" ]; then SES_ID=$(opencode session list --format json | node -e ...); fi`,
  `[ -n "$SES_ID" ] && exec opencode --session "$SES_ID"${resumeOptionsSuffix}; echo ${missingSessionError} >&2; exit 1`,
].join("; ");
```
This is fragile — any failure in the pipe or variable capture silently fails. The `node -e` scripts are minified inline, making debugging extremely difficult.
**Impact:** Session creation failures are hard to diagnose. The command is also potentially truncation-prone when sent via tmux (though the runtime-tmux plugin handles long commands with temp scripts).
**Suggested Fix:** Extract the session discovery logic into a standalone script file (similar to claude-code's `metadata-updater.sh`). Write it to disk, make it executable, and invoke it. This would be more debuggable and maintainable.

### M-12: scm-github: No `enrichSessionsPRBatch` for most plugins — only scm-github has it
**Plugin:** scm-github (only)
**File:** `packages/plugins/scm-github/src/index.ts:1041-1046`
**Description:** The `enrichSessionsPRBatch` optimization is only implemented for scm-github. The scm-gitlab plugin does not implement it, meaning GitLab-based projects make individual API calls per PR per poll cycle.
**Impact:** Performance degradation for projects using GitLab with many active sessions.
**Suggested Fix:** Implement `enrichSessionsPRBatch` for scm-gitlab using GitLab's GraphQL API (or REST batch endpoints).

### M-13: tracker-gitlab: `listIssues` uses `-O json` but `-P` for pagination
**Plugin:** tracker-gitlab
**File:** `packages/plugins/tracker-gitlab/src/index.ts:130-133`
**Description:** The `listIssues` method uses `-O json` (output format) and `-P` (per-page limit). However, `-O` is a `glab` flag for "output format" and `-P` is for "page size". The flag names differ from the GitHub tracker (`--json` and `--limit`). This is correct for `glab` but worth noting for consistency.
**Impact:** No functional issue, but if `glab` flag meanings change, both this and the clone pattern could break.
**Suggested Fix:** Document the expected `glab` version in the plugin description.

### M-14: workspace-worktree: `destroy` doesn't delete branches after worktree removal
**Plugin:** workspace-worktree
**File:** `packages/plugins/workspace-worktree/src/index.ts:159-181`
**Description:** The `destroy` method explicitly does NOT delete the branch after removing the worktree, with a comment explaining that auto-deleting branches risks removing pre-existing local branches. While this is a deliberate design decision, it means stale branches accumulate over time.
**Impact:** Over many sessions, dozens of stale branches accumulate in the repository. This is a known trade-off documented in the code.
**Suggested Fix:** Consider adding a separate cleanup command (`ao cleanup branches`) that safely deletes merged branches, rather than doing it in `destroy`.

## Test Coverage Assessment

### Agent Plugins

| Plugin | Test File | Methods Tested | Missing Tests |
|--------|-----------|----------------|---------------|
| agent-claude-code | `index.test.ts` + `activity-detection.test.ts` | getLaunchCommand, getEnvironment, detectActivity, getActivityState (6 states), isProcessRunning, getSessionInfo, getRestoreCommand, setupWorkspaceHooks | postLaunchSetup not tested; psCache TTL behavior not tested; METADATA_UPDATER_SCRIPT bash logic not integration-tested |
| agent-codex | `index.test.ts` + `app-server-client.test.ts` + `package-version.test.ts` | getLaunchCommand, getEnvironment, detectActivity, getActivityState (6 states + fallbacks), isProcessRunning, getSessionInfo, getRestoreCommand, setupWorkspaceHooks, recordActivity | Binary resolution (`resolveCodexBinary`) not tested; session file cache TTL not tested |
| agent-aider | `index.test.ts` | getLaunchCommand, getEnvironment, detectActivity, getActivityState (exited, waiting_input, active via commits, active/ready/idle via chat mtime, JSONL fallback), isProcessRunning, getSessionInfo | `hasRecentCommits` false positive scenario not tested; `getChatHistoryMtime` error paths not tested |
| agent-opencode | `index.test.ts` | getLaunchCommand, getEnvironment, detectActivity, getActivityState (6 states + native + fallback), isProcessRunning, getSessionInfo, getRestoreCommand | `buildSessionIdCaptureScript` and `buildSessionLookupScript` inline node scripts not tested; session list API failure paths |
| agent-cursor | `index.test.ts` | getLaunchCommand, getEnvironment, detectActivity, getActivityState (6 states), isProcessRunning, getSessionInfo, setupWorkspaceHooks | `getCursorSessionMtime` symlink rejection not tested; `extractCursorSummary` path traversal protection not tested |

### Runtime Plugins

| Plugin | Test File | Methods Tested | Missing Tests |
|--------|-----------|----------------|---------------|
| runtime-tmux | `__tests__/index.test.ts` | create, destroy, sendMessage, getOutput, isAlive, getMetrics, getAttachInfo | Environment variable with special characters; long command temp script cleanup; multiline message paste-buffer |

### Workspace Plugins

| Plugin | Test File | Methods Tested | Missing Tests |
|--------|-----------|----------------|---------------|
| workspace-worktree | `__tests__/index.test.ts` | create, destroy, list, exists, restore, postCreate (symlinks) | Concurrent create race condition; branch name collision retry; `postCreate` command execution |
| workspace-clone | `__tests__/index.test.ts` | create, destroy, list, exists, restore, postCreate | `--reference` without `--dissociate`; clone failure cleanup; partial clone on disk |

### Tracker Plugins

| Plugin | Test File | Methods Tested | Missing Tests |
|--------|-----------|----------------|---------------|
| tracker-github | `test/index.test.ts` | getIssue, isCompleted, issueUrl, branchName, generatePrompt, listIssues, updateIssue, createIssue | `stateReason` fallback (older gh versions); `issueLabel` edge cases |
| tracker-linear | `test/index.test.ts` + `composio-transport.test.ts` | getIssue, isCompleted, issueUrl, branchName, generatePrompt, listIssues, updateIssue, createIssue | Composio transport timeout; `createIssue` without teamId; `workspaceSlug` URL generation |
| tracker-gitlab | `test/index.test.ts` | getIssue, isCompleted, issueUrl, branchName, generatePrompt, listIssues, updateIssue, createIssue | `glab` CLI error handling; host extraction from owner |

### SCM Plugins

| Plugin | Test File | Methods Tested | Missing Tests |
|--------|-----------|----------------|---------------|
| scm-github | `test/index.test.ts` + `graphql-batch.test.ts` | detectPR, getPRState, getCIChecks, getCISummary, getReviews, getReviewDecision, getPendingComments, getAutomatedComments, getMergeability, webhook verification/parsing | `mergePR`, `closePR`, `assignPRToCurrentUser`, `checkoutPR`, `getPRSummary`, `resolvePR` |
| scm-gitlab | `test/index.test.ts` | detectPR, getPRState, getCIChecks, getCISummary, getReviews, getPendingComments, getAutomatedComments, getMergeability, webhook verification/parsing | `mergePR`, `closePR`, `getPRSummary`, `getReviewDecision` edge cases |

### Notifier Plugins

| Plugin | Test File | Methods Tested | Missing Tests |
|--------|-----------|----------------|---------------|
| notifier-desktop | `index.test.ts` | notify, notifyWithActions (macOS + Linux) | Error handling when osascript/notify-send fails; unsupported platform |
| notifier-slack | `index.test.ts` | notify, notifyWithActions, post | Error handling for HTTP failures; webhook URL validation |
| notifier-webhook | `index.test.ts` | notify, notifyWithActions, post | Retry logic (exponential backoff); custom headers |
| notifier-composio | `index.test.ts` | notify, notifyWithActions, post | SDK loading failure; timeout behavior |
| notifier-openclaw | `index.test.ts` | notify, notifyWithActions, post | Health summary persistence; token resolution from config file |
| notifier-discord | `index.test.ts` | notify, notifyWithActions, post | Rate limit (429) handling with Retry-After; thread_id URL construction |

### Terminal Plugins

| Plugin | Test File | Methods Tested | Missing Tests |
|--------|-----------|----------------|---------------|
| terminal-iterm2 | `index.test.ts` | openSession, openAll, isSessionOpen | AppleScript execution failure; non-macOS platform |
| terminal-web | `index.test.ts` | openSession, openAll, isSessionOpen | Dashboard URL configuration |

## Summary

**Critical:** 3 issues — environment variable injection in runtime-tmux, unescaped handle.id in getAttachInfo, send-keys without `-l` flag
**High:** 6 issues — excessive timeouts in isProcessRunning, false positive git commit checks, incorrect idle state for new sessions, unvalidated postCreate commands, GitLab token verification, codex config flag escaping
**Medium:** 14 issues — API chattiness in trackers, module-level caches, notification spam, clone fragility, opencode launch command complexity, missing batch optimization for GitLab

**Test coverage** is generally good for agent plugins (all test the 6 activity states and JSONL fallback). SCM plugins have excellent coverage (scm-github is the most comprehensive test file in the project). Tracker plugins have solid coverage with tracker-linear being exemplary. Notifier and terminal plugins have basic but adequate coverage.

**Key test gaps by severity:**
- **agent-aider**: Missing `getActivityState` test for `exited` state (required per CLAUDE.md). Missing `detect()` tests.
- **agent-opencode**: Missing `getActivityState` test for `exited` state. Missing `detect()` tests.
- **agent-claude-code**: `getRestoreCommand` not tested. The main `index.test.ts` does not test `getActivityState` (it's in a separate `activity-detection.test.ts`).
- **agent-cursor**: `getSessionInfo` has minimal tests (no cost extraction, malformed JSONL, or empty file handling).
- **No agent plugin tests** verify concurrent access to shared state (psCache, sessionFileCache).
- **No `detect()` tests** for agent-aider and agent-opencode (cursor and claude-code have them).
