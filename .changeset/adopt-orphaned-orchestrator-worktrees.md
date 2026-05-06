---
"@aoagents/ao-core": patch
---

Adopt existing managed orchestrator worktrees instead of failing to create a fresh one. Previously, a leftover worktree from a prior run could block `spawnOrchestrator` with a "worktree already exists" error; spawn now detects and reuses the matching managed worktree. Also normalizes CRLF in `parseWorktreeList` (Windows), filters prunable/deleted entries in `findManagedWorkspace`, and applies `GIT_TIMEOUT` to all internal `git()` calls.
