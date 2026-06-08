---
"@aoagents/ao-plugin-agent-claude-code": minor
"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
---

feat(agent-claude-code): support Claude Code's classifier-based `auto` permission mode

Adds a new `auto` value to `AgentPermissionMode`. When set, the claude-code plugin emits `--permission-mode auto` instead of `--dangerously-skip-permissions`, letting Claude Code's built-in classifier decide per tool whether to prompt. Existing `permissionless` and `auto-edit` behavior is unchanged. Other agent plugins fall through to their default behavior for `auto` (documented in the type's JSDoc).
