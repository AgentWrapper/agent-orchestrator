---
"@aoagents/ao-web": patch
---

Fix direct terminal attach and keep mux routing project-scoped. Switches `resolveExactTmuxName` from `execFileSync` to a promisified `execFile` so slow tmux calls no longer stall the WebSocket message handler, and propagates async through `TerminalManager.open` / `subscribe` and the pty `onExit` reattach path. Also drops a duplicate `.kanban-board` grid rule in `globals.css`.
