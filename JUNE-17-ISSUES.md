# June 17 Issues

QC/QA sweep run on `2026-06-17` against local `main` at `0cec42f73c8c64bcab84c54e9f6b9dc526b868e0`.

## Scope

Commands run:

- `pnpm install`
- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm test`
- `pnpm --filter @aoagents/ao-web test`
- `pnpm test:integration`
- `pnpm dev`

Environment:

- macOS arm64
- Node `v25.2.0`
- pnpm `8.15.4`

Notes:

- I accidentally filed these findings upstream in `AgentWrapper/agent-orchestrator` and then closed them all as `not planned` because this fork was the intended target.
- The local fork `ch1kim0n1/parallel-agents` has GitHub issues disabled, so this file is the local ledger for the run.

## High-Level Results

- `pnpm build`: passed
- `pnpm typecheck`: passed
- `pnpm lint`: failed
- `pnpm format:check`: failed
- `pnpm test`: failed
- `pnpm --filter @aoagents/ao-web test`: failed
- `pnpm test:integration`: passed
- Manual `pnpm dev` smoke: exposed multiple UI/runtime issues

## Findings

### 1. `/agentmesh` shows fake demo data when the real API fails

Severity: high

Observed behavior:

- `GET /api/agentmesh/tasks` returned `500` with `{"error":"Failed to list tasks"}`.
- The page still rendered fake tasks like `TASK-1`, `Fix login bug`, `ISSUE-123`.
- The QA panel showed hardcoded fake findings, including a fake API key and fake SQL injection example.

Relevant files:

- `packages/web/src/components/TaskBoard.tsx`
- `packages/web/src/components/QALoopStatus.tsx`
- `packages/web/src/app/agentmesh/page.tsx`

### 2. Dashboard empty state shows `Reconnecting…` when no config exists

Severity: medium

Observed behavior:

- With no local `agent-orchestrator.yaml`, `/` showed:
  - `No projects yet. Click + to add one.`
  - `Orchestrator failed to load`
  - `No agent-orchestrator.yaml found. Run \`ao start\` to create one.`
  - live status `Reconnecting…`
- Browser logs repeatedly warned from `useSessionEvents`.

Relevant files:

- `packages/web/src/hooks/useSessionEvents.ts`
- `packages/web/src/lib/client-fetch.ts`

### 3. `@aoagents/ao` binary is missing after install/build

Severity: high

Observed behavior:

- `pnpm install` warned that it failed to create `packages/ao/node_modules/.bin/ao`.
- After `pnpm build`, `packages/ao/node_modules/.bin/ao` was still absent.
- `pnpm --filter @aoagents/ao exec ao --version` failed with `Command "ao" not found`.

Relevant files:

- `packages/ao/package.json`
- `packages/cli/dist/index.js` dependency timing / packaging flow

### 4. Root lint is broken by `packages/agentmesh-adapters`

Severity: medium

Observed behavior:

- `pnpm lint` failed.
- `packages/agentmesh-adapters` contributed 71 lint findings.
- Main error classes:
  - duplicate imports
  - unused vars
  - explicit `any`

Representative files:

- `packages/agentmesh-adapters/src/aider-adapter.ts`
- `packages/agentmesh-adapters/src/claude-code-adapter.ts`
- `packages/agentmesh-adapters/src/codex-adapter.ts`
- `packages/agentmesh-adapters/src/cursor-adapter.ts`
- `packages/agentmesh-adapters/src/devin-adapter.ts`

### 5. Root lint is broken by `packages/agentmesh-core`

Severity: medium

Observed behavior:

- `packages/agentmesh-core` contributed 74 lint findings.
- Main error classes:
  - explicit `any`
  - unused vars
  - `preserve-caught-error`

Representative files:

- `packages/agentmesh-core/src/coordination-service.ts`
- `packages/agentmesh-core/src/cost-tracker.ts`
- `packages/agentmesh-core/src/lock-manager.ts`
- `packages/agentmesh-core/src/policy-engine.ts`
- `packages/agentmesh-core/src/task-manager.ts`

### 6. Root lint is broken by `packages/agentmesh-cli`

Severity: medium

Observed behavior:

- `packages/agentmesh-cli` contributed 57 lint findings.
- Main error classes:
  - duplicate imports
  - unused vars
  - explicit `any`

Representative file:

- `packages/agentmesh-cli/src/index.ts`

### 7. Lint emits an ESLint 10 migration warning

Severity: low

Observed behavior:

- `pnpm lint` emitted:
  - `ESLintIgnoreWarning: The ".eslintignore" file is no longer supported.`
- The repo already defines `ignores` in `eslint.config.js`, so `.eslintignore` is stale/noisy.

Relevant files:

- `.eslintignore`
- `eslint.config.js`

### 8. `pnpm format:check` fails across 319 files on clean `main`

Severity: medium

Observed behavior:

- `pnpm format:check` failed with:
  - `Code style issues found in 319 files. Run Prettier with --write to fix.`

Impact:

- Formatting is not a usable contributor gate because a clean checkout already fails.

### 9. OpenCode session mapping tests are failing in `packages/core`

Severity: high

Observed behavior from `pnpm test`:

- `session-manager/lifecycle.test.ts > kill > purges mapped OpenCode session when requested` timed out
- `session-manager/lifecycle.test.ts > kill > skips purge when mapped OpenCode session id is invalid` failed assertion
- `session-manager/query.test.ts > get > auto-discovers and persists OpenCode session mapping when missing` timed out
- `session-manager/spawn.test.ts > spawn > spawnOrchestrator > deletes previous OpenCode orchestrator sessions before starting` timed out

### 10. Reviewer worktree pruning test times out

Severity: medium

Observed behavior from `pnpm test`:

- `code-review-manager.test.ts > prepareGitReviewerWorkspace > prunes stale git worktree metadata when the reviewer workspace directory is gone` timed out after 5s

### 11. Activity-events migration success test times out

Severity: medium

Observed behavior from `pnpm test`:

- `activity-events-migration.test.ts > emits migration.completed with totals when migration succeeds` timed out after 5s

### 12. `ao-web` test suite crashes on hosts without `tmux`

Severity: medium

Observed behavior:

- `pnpm --filter @aoagents/ao-web test` failed with:
  - `FAIL server/__tests__/direct-terminal-ws.integration.test.ts`
  - `Error: spawnSync tmux ENOENT`

Likely cause:

- `packages/web/server/__tests__/direct-terminal-ws.integration.test.ts` uses `describe.skip` logic for `tmux`, but still has top-level `beforeAll()` setup that calls `execFileSync(TMUX, ...)`.

### 13. `AGENTS.md` references a missing checked-in bug triage skill

Severity: low

Observed behavior:

- `AGENTS.md` instructs agents to load `skills/bug-triage/SKILL.md`.
- That path does not exist in this checkout.

Relevant lines:

- `AGENTS.md` lines 36-48

## Extra Observations

- `pnpm install` warned that the lockfile was not compatible with the installed pnpm version. The repo declares `packageManager: pnpm@9.15.4`, while this run used pnpm `8.15.4`.
- During `pnpm dev`, the session patch polling path spammed `500` errors when config was missing, and the direct-terminal broadcaster kept logging repeated session fetch failures.

## Suggested Next Pass

1. Fix the `/agentmesh` fake-data fallback first.
2. Repair the `@aoagents/ao` binary packaging flow.
3. Restore green contributor gates in this order: lint, format, root tests, web tests.
4. Clean up onboarding/empty-state behavior when config is absent.
