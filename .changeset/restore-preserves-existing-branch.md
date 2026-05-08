---
"@aoagents/ao-plugin-workspace-worktree": patch
---

Restoring a session whose worktree directory was cleaned up but whose branch still existed locally would 422 with `fatal: a branch named <X> already exists`. The recovery path in `workspace.restore()` unconditionally fell through to `git worktree add -b`, even when the local branch was present (which `destroy()` deliberately preserves). The catch now checks for the local branch and re-attaches it without `-b`/`-B`, preserving the session's commits. (#1741)
