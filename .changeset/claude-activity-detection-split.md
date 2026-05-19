---
"@aoagents/ao-plugin-agent-claude-code": patch
---

Split Claude Code activity-detection logic out of `index.ts` into a dedicated `activity-detection.ts` module. Removes two unreachable switch branches (`case "permission_request"` → `waiting_input` and `case "error"` → `blocked`) that targeted JSONL types Claude never actually emits — `waiting_input` and `blocked` now flow exclusively through the terminal-regex → AO activity-JSONL path. No behavior change for any real Claude session; internal refactor.
