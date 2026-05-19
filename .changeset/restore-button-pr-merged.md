---
"@aoagents/ao-web": patch
---

fix(web): show Restore button for every exited session, including pr_merged

The Restore button was hidden for sessions exited with `pr_merged` reason (legacy
status `cleanup`) on the dashboard kanban and absent altogether from the
session-detail "Terminal ended" panel. The core `isRestorable()` helper already
allowed restoring these sessions; the dashboard helpers were out of sync. Fixes
#1907.

- `isDashboardSessionRestorable` now gates on `NON_RESTORABLE_STATUSES` only,
  matching core's `isRestorable`. Merged-but-running sessions remain
  non-restorable (lifecycle isn't terminal).
- `DoneCard` no longer hides Restore for merged sessions.
- `SessionEndedSummary` exposes a prominent `Restore session` button next to
  `Open PR` / `Back to dashboard`, so users don't have to find the small
  header icon.
