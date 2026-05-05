---
"@aoagents/ao-plugin-workspace-worktree": patch
---

Auto-recover from orphaned worktrees on session spawn.

Previously, if a prior `ao start` was killed before it could clean up — by Ctrl-C, kill -9, system sleep, or any error during setup — the orchestrator worktree would stay registered with git even after its directory was removed. Every subsequent `ao start` for that project then failed with:

```
fatal: 'orchestrator/<name>' is already checked out at '/path/that/no/longer/exists'
```

Two fixes in `workspace.create()`:

1. Always run `git worktree prune` at the start. This clears registry entries pointing to paths git no longer sees on disk.
2. After prune, look up which worktree (if any) currently owns the target branch. If it's at the path we'd create anyway, reuse it instead of failing — this is the common orchestrator-restart case. If the branch is checked out at a different path, throw a clear error that names the offending path so users know exactly what to remove.

Closes the long-standing "spawn failure leaves orphaned worktrees, re-spawn fails" issue.
