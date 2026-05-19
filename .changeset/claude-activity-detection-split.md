---
"@aoagents/ao-core": patch
"@aoagents/ao-plugin-agent-claude-code": patch
---

Split Claude Code activity-detection logic out of `index.ts` into a dedicated `activity-detection.ts` module. Removes two unreachable switch branches (`case "permission_request"` → `waiting_input` and `case "error"` → `blocked`) that targeted JSONL types Claude never actually emits. `waiting_input` continues to flow through the AO activity-JSONL safety net added in #1903.

Closes the `blocked` gap for Claude Code: extend `readLastJsonlEntry` in core to also surface top-level `subtype` and `level` fields, and map `{type:"system", level:"error"}` → `blocked` in the cascade. This catches Claude's real api_error shape (`{type:"system", subtype:"api_error", level:"error", cause:{code:"ConnectionRefused"|"FailedToOpenSocket"|...}}`) so a session stuck in the API retry loop now reports `blocked` instead of `ready`. New fields on `readLastJsonlEntry` are additive and don't break existing callers (Codex, OpenCode, Aider).
