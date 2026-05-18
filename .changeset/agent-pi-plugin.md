---
"@aoagents/ao-plugin-agent-pi": minor
"@aoagents/ao-cli": minor
"@aoagents/ao-core": patch
---

Add pi.dev agent plugin (`@aoagents/ao-plugin-agent-pi`). Pi sessions can now be spawned per worktree alongside the existing claude-code, codex, aider, and opencode peers. Reads native pi JSONL at `~/.pi/agent/sessions/` for activity state and uses pi's per-message `usage.cost.total` for cost tracking. Wires the plugin into the CLI registry, auto-detection, and the core BUILTIN_PLUGINS list.
