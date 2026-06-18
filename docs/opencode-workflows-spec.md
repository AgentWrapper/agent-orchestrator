# OpenCode Workflow Spec (Agent Orchestrator)

This document defines intended behavior for Agent Orchestrator when `agent: opencode` is selected, including edge cases and expected outcomes.

## Scope

- CLI workflows: `ao start`, `ao spawn`, `ao status`, `ao send`, `ao session cleanup`, `ao session restore`, `ao session remap`.
- Core lifecycle paths in `SessionManager` and plugin resolution.
- OpenCode session mapping and deletion semantics.

## Configuration Contract

- `defaults.agent: opencode` or `projects.<id>.agent: opencode` selects the OpenCode agent plugin.
- `projects.<id>.orchestratorSessionStrategy` controls orchestrator session behavior:
  - `reuse`: reuse existing alive orchestrator runtime; otherwise restart and reuse mapped OpenCode session id when available.
  - `delete`: destroy alive runtime, delete previously mapped/discovered OpenCode orchestrator sessions, then start fresh.
  - `ignore`: destroy alive runtime and start fresh without deleting prior OpenCode sessions.
  - `delete-new` and `kill-previous` normalize to `delete`.
  - `ignore-new` normalizes to `ignore`.
- `projects.<id>.opencodeIssueSessionStrategy` controls issue-session reuse for `ao spawn` with OpenCode:
  - `reuse` (default): reuse mapped OpenCode session for same issue when available.
  - `delete`: delete mapped OpenCode sessions for same issue, then spawn fresh.
  - `ignore`: spawn fresh without deleting prior issue sessions.

## Workflow Behavior

## 1) Plugin Resolution

- CLI must resolve `opencode` via `getAgentByName` and `getAgent` without error.
- Core plugin registry built-ins must include `@aoagents/ao-plugin-agent-opencode` under slot `agent`.
- Expected failure mode: unknown agent names fail fast with `Unknown agent plugin: <name>`.

## 2) `ao start` (orchestrator session)

- Always delegates orchestrator session lifecycle to `SessionManager.spawnOrchestrator`.
- For `orchestratorSessionStrategy: reuse`:
  - if existing runtime is alive, return existing session without creating a new runtime.
  - if existing runtime is dead and metadata contains `opencodeSessionId`, pass it to launch config for continuation.
- For `delete` strategy:
  - delete mapped/discovered OpenCode orchestrator sessions (`AO:<prefix>-orchestrator`) before launching new orchestrator.
- For `ignore` strategy:
  - do not delete old OpenCode sessions; launch fresh runtime.

## 3) `ao spawn`

- Uses selected agent (default/project/override) and launches OpenCode command from plugin launch config.
- Worker sessions write persistent system instructions to `worker-prompt-<session>.md`.
- OpenCode launch behavior:
  - no mapped id: run with `--title AO:<session>` and then continue via discovered session id.
  - mapped id (`agentConfig.opencodeSessionId`): launch directly with `--session <id>`.
- For OpenCode workers, core writes `OPENCODE_CONFIG` with an `instructions` array pointing at the worker prompt file instead of mutating workspace `AGENTS.md`.
- The explicit user request remains separate task text and is forwarded as `prompt` only when present.
- OpenCode orchestrators still use workspace `AGENTS.md` for persisted system prompt context.
- Model/subagent/task prompt inputs are forwarded into OpenCode launch command.

## 4) `ao send`

- Resolves agent by project config; when session metadata indicates OpenCode and mapping missing, core `send()` attempts title-based discovery and persists mapping.
- Sends message through runtime plugin handle; fails if session/runtime cannot be resolved.
- Busy detection is plugin-driven (`detectActivity`).

## 5) `ao status`

- Uses project/default configured agent for session enrichment and activity checks.
- Must not fail solely because project default agent is `opencode`.
- Fallback mode (no config) uses `claude-code` for best-effort tmux introspection only.

## 6) `ao session cleanup`

- Never cleans up orchestrator sessions (by explicit `role=orchestrator` or `-orchestrator` suffix).
- For OpenCode sessions with mapped `opencodeSessionId`:
  - on cleanup kill path, delete corresponding OpenCode session first, then archive AO session metadata.
  - archived sessions with mapping are cleaned once; `opencodeCleanedAt` prevents repeated deletion attempts.
- If OpenCode delete returns "session not found", treat as already cleaned.

## 7) `ao session restore`

- For OpenCode session restore, mapping is required.
- If mapping missing:
  - attempt title discovery using longer interactive timeout.
  - if still missing, fail with non-restorable error (`OpenCode session mapping is missing`).
- Restore must recreate runtime with preserved metadata/session fields and keep mapping persisted.
- For restored OpenCode workers, core recreates `OPENCODE_CONFIG` from the saved worker prompt file when it exists.
- For restored OpenCode orchestrators, core rewrites workspace `AGENTS.md` from the saved orchestrator prompt file.

## 8) `ao session remap`

- Only valid for OpenCode sessions.
- `remap(session, force=false)`:
  - reuse existing mapping if present; otherwise discover and persist.
- `remap(session, force=true)`:
  - always re-discover by title and overwrite persisted mapping.
- If discovery fails, return explicit mapping-missing error.

## Edge Cases and Expected Outcomes

- OpenCode binary missing: OpenCode-specific operations relying on `opencode session ...` discovery/deletion degrade gracefully where coded (discovery returns none), and explicit operations report mapping/deletion errors when required.
- Corrupted `runtimeHandle` metadata: `send` fails with `Corrupted runtime handle`.
- Existing orchestrator metadata present but runtime dead under `reuse`: restart runtime and pass mapped `opencodeSessionId` when available.
- Duplicate OpenCode sessions with same AO title: title match drives selection for remap/discovery (no timestamp ranking).
- Archived OpenCode sessions already cleaned: `cleanup` skips duplicate deletion via `opencodeCleanedAt`.
- Unknown project/agent: fail fast with clear error.

## Revalidation Baseline (Current)

- Unit/integration validation that should remain green for OpenCode workflows:
  - `@aoagents/ao-plugin-agent-opencode` tests.
  - `@aoagents/ao-core` tests: `session-manager.test.ts`, `plugin-registry.test.ts`.
  - `@aoagents/ao-cli` tests: `plugins.test.ts`, `start.test.ts`, `session.test.ts`, `send.test.ts`, `status.test.ts`.
  - `@aoagents/ao-integration-tests` with `test:integration` (includes `agent-opencode.integration.test.ts`, conditionally skipped tests where prerequisites are unavailable).
