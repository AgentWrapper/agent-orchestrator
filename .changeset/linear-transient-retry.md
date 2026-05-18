---
"@aoagents/ao-plugin-tracker-linear": patch
---

Retry transient Linear API HTTP failures in the direct transport to reduce flakes from brief 5xx/429 responses.
