---
"@aoagents/ao-core": minor
"@aoagents/ao-plugin-agent-claude-code": minor
---

Replace Claude Code terminal-regex activity detection with platform-event hooks (#1941).

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
