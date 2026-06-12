---
"@aoagents/ao-cli": patch
---

Fix `ao status --include-terminated` counting terminated sessions as active in the footer summary. The flag now only affects visibility — terminated sessions are never counted as "active sessions" or orchestrators in the summary line.
