---
"@aoagents/ao-web": patch
---

Fix Done/Terminated section on the dashboard not scrolling. The dashboard body now scrolls as a single page — kanban above, Done/Terminated below — so older terminated sessions are reachable when many accumulate. Restores the pre-Warm-Terminal-refresh behavior by dropping the `flex: 1` that was making `.kanban-board-wrap` greedily consume all remaining body height and defeat the body's `overflow-y: auto`.
