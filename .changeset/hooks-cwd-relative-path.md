---
"@aoagents/ao-plugin-agent-claude-code": patch
---

Root Claude Code hook commands at `$CLAUDE_PROJECT_DIR` so they resolve when the agent's cwd is a worktree sub-directory (a bare relative `.claude/*-updater.{sh,cjs}` path previously failed with "No such file or directory" on every tool call).
