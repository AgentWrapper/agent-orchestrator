# Quick Start

This is the shortest repo-local path to run AgentMesh and confirm the main flows still work.

## Prerequisites

- Node `20.18.3+`
- `pnpm`
- `git`
- `gh`
- At least one agent CLI installed

On Windows, `tmux` is not required. AgentMesh uses the `process` runtime by default.

## Fast path

From the repo root:

```bash
pnpm install
pnpm build
node packages/ao/bin/ao.js doctor
node packages/ao/bin/ao.js start
```

If your default Windows Node is older than `20.18.3`, use:

```powershell
npx -y node@20.18.3 "$env:APPDATA\npm\node_modules\pnpm\bin\pnpm.cjs" install
npx -y node@20.18.3 "$env:APPDATA\npm\node_modules\pnpm\bin\pnpm.cjs" build
npx -y node@20.18.3 packages/ao/bin/ao.js doctor
npx -y node@20.18.3 packages/ao/bin/ao.js start
```

## What to expect

- The dashboard should open at `http://localhost:3000`.
- The main board should load at `/`.
- The AgentMesh task board should load at `/agentmesh`.
- A legacy-storage warning can appear on startup. It is non-blocking; run `ao migrate-storage`
  later if you want to clean it up.
- Missing notifier credentials can also warn on startup. Those warnings do not block local runs.

## Minimum smoke test

1. Open `http://localhost:3000/agentmesh`.
2. Create a task with a title and description.
3. Leave the branch field blank so AgentMesh auto-generates a worker branch.
4. Click `Start`.
5. Confirm the task moves from `Created` to `Building`.

## Useful checks

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

For only the route regressions that were added around the live run:

```bash
pnpm --filter @aoagents/ao-web test -- src/__tests__/agentmesh-task-route.test.ts src/__tests__/agentmesh-task-start-route.test.ts
```
