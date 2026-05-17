---
"@aoagents/ao-core": patch
---

fix(core): persist resolved per-session permissions/model/subagent so restore preserves spawn-time selection

When a session is restored (via the dashboard card **Restore** action or `ao session resume`), the agent was being re-launched against whatever the project's *current* `agentConfig` resolved to — silently dropping the session's original spawn-time permissions / model / subagent if the project config had drifted in the meantime. Affected every agent plugin that reads `project.agentConfig?.permissions` in `getRestoreCommand` (`claude-code`, `codex`, `opencode`, `kimicode`).

Fix (Approach B — zero plugin file changes):

- At spawn (`_spawnInner`, `spawnOrchestrator`), persist `selection.permissions` / `selection.model` / `selection.subagent` into session metadata as `spawnedPermissions` / `spawnedModel` / `spawnedSubagent`.
- `resolveSelectionForSession` reads those keys back from metadata and passes them to `resolveAgentSelection` as the new `persistedPermissions` / `persistedModel` / `persistedSubagent` inputs (mirroring the existing `persistedAgent` pattern).
- `resolveAgentSelection` writes the persisted values into `selection.agentConfig` so the existing `projectConfigForLaunch.agentConfig` propagation path carries them all the way to each plugin's `getRestoreCommand`. Plugin interfaces and plugin files are untouched.

Legacy sessions (persisted before this PR) lack the new metadata keys and fall back to current project defaults — they were already losing this on restore and we're not regressing them, just fixing the path for new sessions.

Orchestrator forced-permissionless rule is unchanged (still enforced at `agentLaunchConfig` / `projectConfigForLaunch` construction in `session-manager.ts`). Closes #1475.
