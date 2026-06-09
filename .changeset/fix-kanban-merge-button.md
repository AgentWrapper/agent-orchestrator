---
"@aoagents/ao-web": patch
---

fix: pass onMerge callback to AttentionZone in kanban view and parse merge error responses

The merge button on kanban session cards was a no-op because `onMerge` was not passed
to the `AttentionZone` component. The optional chain `onMerge?.()` silently did nothing.
Also improved the error toast to show human-readable blocker messages instead of raw JSON.
