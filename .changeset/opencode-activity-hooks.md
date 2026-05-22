---
"@aoagents/ao-plugin-agent-opencode": minor
---

Replace OpenCode terminal-regex activity detection with platform-event hooks.

OpenCode exposes a plugin/event system (`.opencode/plugins/`) that streams 25+
lifecycle events. Until now, AO inferred activity by regex-matching OpenCode's
rendered terminal output — and `waiting_input` had no authoritative source at
all, only a fragile prompt heuristic.

This release pivots OpenCode to the same hook-driven model as Claude Code and
Codex:

- `setupWorkspaceHooks` installs an auto-loaded activity plugin into the
  workspace's `.opencode/plugins/` and excludes it from git (worktree-aware
  `info/exclude`) so it never lands in the agent's PRs.
- The plugin maps `permission.asked` → `waiting_input`, `session.error` →
  `blocked`, `session.idle` → `ready`, and tool/file/message events → `active`,
  writing them to `.ao/activity.jsonl` with `source: "hook"`. It no-ops without
  `AO_SESSION_ID` and honors `AO_OPENCODE_HOOK_ACTIVITY=0` as an opt-out.
- `getActivityState` now prefers fresh hook entries over the polled
  `opencode session list` API for every state; the session-list API remains the
  fallback when no hook entry exists.
- `recordActivity` is removed — the plugin is the sole JSONL writer, so
  terminal-derived writes can no longer shadow authoritative hook events. The
  terminal `detectActivity` classifier remains as the lifecycle's last resort.
