---
"@aoagents/ao-core": minor
"@aoagents/ao-plugin-agent-aider": patch
"@aoagents/ao-plugin-agent-codex": patch
"@aoagents/ao-plugin-agent-cursor": patch
"@aoagents/ao-plugin-agent-opencode": patch
---

Add `recordActivityViaTerminal(classifier)` factory to core and use it to replace the identical 5-line `recordActivity` wrapper in the aider, codex, cursor, and opencode plugins. Same behavior, less boilerplate for future AO-activity-JSONL plugins.
