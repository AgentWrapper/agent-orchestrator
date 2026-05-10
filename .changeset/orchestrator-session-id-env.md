---
"@aoagents/ao-core": minor
"@aoagents/ao-plugin-agent-claude-code": minor
"@aoagents/ao-plugin-agent-codex": minor
"@aoagents/ao-plugin-agent-opencode": minor
"@aoagents/ao-plugin-agent-aider": minor
"@aoagents/ao-plugin-agent-cursor": minor
"@aoagents/ao-plugin-agent-kimicode": minor
---

Worker sessions now receive their orchestrator's session ID as `AO_ORCHESTRATOR_SESSION_ID` in the environment, and the base agent prompt teaches them to message the orchestrator via `ao send $AO_ORCHESTRATOR_SESSION_ID "[from $AO_SESSION_ID] <message>"` when they genuinely cannot proceed alone. Reuses the existing `ao send` transport — no new CLI verb, no new file format. Orchestrator sessions do not receive this env var (an orchestrator is not its own parent). (#1786)
