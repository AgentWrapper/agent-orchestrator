---
"@aoagents/ao-cli": patch
---

Fix `ao update` skipping the rebuild when compiled output is stale at the current commit. The rebuild used to fire only when the fetch advanced the local SHA, so a manual `git pull`, a branch switch, an interrupted earlier build, or a manual `pnpm clean` could leave `dist/` out of sync with `src/` while `ao update` reported "Already on latest version" and never rebuilt. The rebuild is now gated on whether the build output is actually in sync with HEAD (tracked via a gitignored `node_modules/.ao-build-sha` marker plus a build-output existence check), and a new `ao update --force-rebuild` flag forces a rebuild on demand. Applies to git/source installs on both bash and PowerShell.
