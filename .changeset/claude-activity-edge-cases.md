---
"@aoagents/ao-plugin-agent-claude-code": patch
---

Harden Claude Code activity detection against five real-world edge cases identified during PR #1927's analysis:

1. **Bookkeeping types → false-active.** `file-history-snapshot`, `attachment`, `pr-link`, `queue-operation`, `permission-mode`, `last-prompt`, `ai-title`, `agent-color`, `agent-name`, `custom-title` were falling through to the `default` switch branch and showing as `active` for 30s after Claude finished a turn. They now correctly map to `ready`/`idle` by age. Likely root cause of "Claude looks busy when it's done" reports.

2. **Multi-session disambiguation.** `findLatestSessionFile` picked newest-mtime, which is the wrong session's JSONL when two Claude sessions are running in the same workspace. Now prefers the UUID-named file (`<projectDir>/<claudeSessionUuid>.jsonl`) when `session.metadata.claudeSessionUuid` is set, falling back to newest-mtime otherwise.

3. **Symlinked workspaces.** `toClaudeProjectPath` was a pure string transform — symlink paths produced different slugs than what Claude itself wrote. Added `resolveWorkspaceForClaude(path)` that runs `realpathSync` (with fallback) and used it in all three slug-computing sites (`getClaudeActivityState`, `getSessionInfo`, `getRestoreCommand`).

4. **Process regex too narrow.** `(?:^|\/)claude(?:\s|$)` was missing several legitimate install variants — `.claude`, `claude-code`, `claude.exe`, `claude.js`, and npm shims like `node /opt/.../@anthropic-ai/claude-code/cli.js`. Broadened to `(?:^|\/)(?:\.)?claude(?:[-.][\w-]+)*(?:[\s/]|$)`; still rejects look-alikes (`claudia`, `claudine`).

5. **Silent permission-denied.** `findLatestSessionFile` was swallowing every `readdir` error silently — a missing `~/.claude/projects/<slug>/` (ENOENT) is normal, but a permission-denied (EACCES/EPERM) or fd-exhausted (EMFILE) misconfig left the session looking permanently `idle` on the dashboard with zero telemetry. Now logs a single `console.warn` for non-ENOENT errors.

193/193 plugin tests pass. No public-API change. New helper `resolveWorkspaceForClaude` is re-exported from `index.ts` for downstream consumers.
