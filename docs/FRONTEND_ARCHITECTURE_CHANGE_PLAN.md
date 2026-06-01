# Frontend Architecture Change Plan

> Status: draft · Scope: `packages/web` · Last updated: 2026-05-17

## Purpose

This document captures the frontend architecture changes we plan to make to keep the dashboard server-rendered, live-updating, and maintainable as the UI grows.

The current architecture is directionally correct: Next.js App Router renders an SSR snapshot, the client hydrates into a live dashboard, and the mux WebSocket streams both session updates and terminal data. The changes below are about tightening boundaries, reducing render cascades, and making the implementation easier to extend without rewriting the app.

## Goals

- Keep the dashboard **SSR-first** for fast initial load and graceful failure states.
- Keep WebSocket updates **patch-based** and cheap.
- Use REST refreshes only as a **repair/fallback path** when membership changes or data is stale.
- Keep core/session/plugin logic on the server; expose only serialized dashboard DTOs to React.
- Reduce large client components by moving route data loading and state orchestration into focused modules.
- Preserve the existing mux terminal architecture.

## Non-goals

- No new frontend state-management dependency.
- No rewrite of the design system or visual language.
- No database or persistent client cache.
- No changes to core plugin interfaces unless a frontend feature explicitly requires it.

## Current architecture snapshot

```text
agent-orchestrator.yaml / global config
  -> web server getServices()
  -> sessionManager.listCached()
  -> serialize Session -> DashboardSession
  -> Next.js server route renders initial page
  -> client Dashboard hydrates
  -> MuxProvider connects to WebSocket
  -> session patches update UI
  -> REST /api/sessions repairs stale or changed membership
```

Important files:

- `packages/web/src/app/layout.tsx` — app shell and providers.
- `packages/web/src/app/page.tsx` — dashboard server route.
- `packages/web/src/lib/dashboard-page-data.ts` — SSR dashboard data loader.
- `packages/web/src/lib/services.ts` — server-only service singleton.
- `packages/web/src/lib/serialize.ts` — core session to dashboard DTO mapping.
- `packages/web/src/components/Dashboard.tsx` — main dashboard client UI.
- `packages/web/src/hooks/useSessionEvents.ts` — live session state reducer.
- `packages/web/src/providers/MuxProvider.tsx` — browser WebSocket provider.
- `packages/web/server/mux-websocket.ts` — terminal/session WebSocket mux server.
- `packages/web/src/components/SessionDetail.tsx` — session detail UI.
- `packages/web/src/app/sessions/[id]/page.tsx` — current session detail route.

## Planned changes

### 1. Formalize the data boundary

Create and consistently use one frontend DTO boundary:

```text
core Session -> serialize.ts -> DashboardSession -> React components
```

Changes:

- Keep all core-only imports out of client components where possible.
- Centralize dashboard-safe serialization in `src/lib/serialize.ts`.
- Treat `DashboardSession` as the only session shape consumed by UI components.
- Keep server-only service access behind `src/lib/services.ts` and API routes.

Success criteria:

- Client components do not need to understand core session internals.
- API route responses and SSR props use the same dashboard DTOs.

### 2. Tighten live session state

Improve `useSessionEvents` so live updates do not cause unnecessary render cascades.

Changes:

- Dedupe `reset` actions by content before allocating new session arrays.
- Preserve existing references when incoming data is unchanged.
- Dedupe `attentionLevels` in the same way.
- Keep WebSocket patches lightweight: `id`, `status`, `activity`, `attentionLevel`, `lastActivityAt`.
- Use `/api/sessions` only when membership changes or a stale refresh is needed.

Success criteria:

- A no-op WebSocket snapshot does not re-render the whole dashboard.
- A 15s fallback refresh with identical data preserves stable references.

### 3. Split the dashboard into smaller render units

`Dashboard.tsx` should remain the orchestration component, but list-heavy UI should move into memoized children.

Changes:

- Keep `Dashboard.tsx` responsible for page-level state and routing.
- Extract memoized subcomponents for project groups, session rows, and Kanban sections where needed.
- Use stable callbacks for list rows and sidebar actions.
- Avoid inline large JSX blocks for repeated rows.

Success criteria:

- Updating one session does not reconcile every row in the sidebar/Kanban.
- Rename inputs, popovers, and mobile menus keep local UI state during live updates.

### 4. Keep mux WebSocket as the single live transport

The mux WebSocket should continue to carry both terminal data and session patches.

Changes:

- Keep `MuxProvider` as the single browser WebSocket owner.
- Batch session snapshots arriving close together before updating React state.
- On reconnect, trigger one REST refresh to repair any missed membership changes.
- Keep terminal operations isolated behind `openTerminal`, `writeTerminal`, `resizeTerminal`, and `closeTerminal`.

Success criteria:

- Multiple rapid session transitions produce one visible UI update batch.
- Reconnects recover to an accurate session list without a manual refresh.
- Terminal behavior remains unchanged.

### 5. Convert session detail to SSR-first shape

The session detail route currently contains too much client-side fetch and lifecycle logic. We will reshape it to match the dashboard pattern.

Target shape:

```text
app/sessions/[id]/page.tsx        server component
  -> load initial session/sidebar data
  -> render SessionPageClient

SessionPageClient.tsx             client component
  -> useSessionEvents / mux updates
  -> derive page state
  -> render SessionDetail once
```

Changes:

- Move initial route data loading to the server page.
- Add a focused `SessionPageClient.tsx` for live updates and interaction state.
- Reuse the existing live-session update path instead of custom parallel polling logic.
- Render `SessionDetail` through one primary branch instead of duplicate prop branches.

Success criteria:

- Session detail has one source of truth for live session data.
- Loading, missing, error, and ready states are explicit.
- The route is easier to test and reason about.

### 6. Document frontend implementation patterns

Add a frontend patterns document after the first implementation pass.

Proposed file:

- `docs/FRONTEND_PATTERNS.md`

Topics:

- SSR snapshot + client live patch pattern.
- DTO boundary rules.
- When to use mux patches vs REST refresh.
- Memoized list rendering guidelines.
- Loading/error state as discriminated unions.
- Avoiding state/ref shadowing in client components.

## Implementation order

1. Stabilize `useSessionEvents` references.
2. Memoize/extract sidebar and list rows.
3. Batch mux session updates and refresh after reconnect.
4. Refactor session detail route to SSR-first + client wrapper.
5. Add `docs/FRONTEND_PATTERNS.md` based on the final implemented pattern.

Each step should ship independently with tests.

## Test plan

- Unit-test `useSessionEvents` reducer behavior for no-op resets and snapshots.
- Add component tests proving focused rename/sidebar UI does not lose state during session updates.
- Test mux reconnect behavior with a mocked WebSocket/session refresh.
- Test session detail loading/error/ready states after the route split.
- Run:

```bash
pnpm --filter @aoagents/ao-web test
pnpm --filter @aoagents/ao-web typecheck
```

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Over-refactoring large components | Change only files needed for each phase. Keep phases independently shippable. |
| Breaking terminal behavior | Do not change terminal protocol while changing session updates. Keep mux terminal APIs stable. |
| Stale client state after reconnect | Force one REST refresh after reconnect. |
| Divergent server/client session shapes | Keep serialization centralized in `serialize.ts`. |
| Hard-to-test live behavior | Test reducer logic separately from WebSocket provider behavior. |

## Definition of done

- Dashboard still renders from SSR data without requiring WebSocket connection.
- Live session patches update the UI without full-list rerenders on no-op data.
- Session detail follows the same SSR + live update pattern as the dashboard.
- Terminal attach/input/resize still works through mux.
- Web tests and typecheck pass.
