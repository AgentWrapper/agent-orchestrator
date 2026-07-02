# Web Dashboard Deep Analysis

Comprehensive analysis of `packages/web/src/` — bugs, stale state issues, missing error boundaries, performance problems, SSE/WebSocket handling issues, caching bugs, and UX gaps. All findings include `file:line` references and severity ratings.

---

## Critical Bugs

### C-01: SSE snapshot ignores server-computed attention levels on refresh
**File:** `hooks/useSessionEvents.ts:195-202`
**Severity:** HIGH

When a full refresh fetches `/api/sessions`, the client re-computes `sseAttentionLevels` using `getAttentionLevel(s, attentionZones)`. This overwrites the server-computed attention levels from the SSE stream. If the `/api/sessions` response returns slightly stale data (sessions have transitioned between the SSE snapshot and the REST fetch), the attention levels will flip-flop between the SSE-computed and REST-computed values, causing cards to jump between kanban columns.

The issue is compounded by the `initialAttentionLevels` being computed in a `useMemo` that depends on `initialSessions` — on re-renders caused by parent state changes, these can re-compute against stale `initialSessions`.

### C-02: Module-level mutable cache in session detail page
**File:** `app/sessions/[id]/page.tsx:63-67`
**Severity:** HIGH

```typescript
let cachedProjects: ProjectInfo[] | null = null;
let cachedSidebarSessions: DashboardSession[] | null = null;
```

These are **module-level variables** shared across all instances of `SessionPage`. In a client-side SPA navigation (Next.js App Router soft navigation), these persist across different session detail pages. If user navigates from `/sessions/abc` to `/sessions/xyz`, the `cachedSidebarSessions` from session `abc` briefly renders as sidebar data for session `xyz` before the new fetch completes.

Additionally, `warnedMuxPatchValues` (line 67) is a module-level `Set` that never gets cleared, causing a slow memory leak over extended usage.

### C-03: `useSSESessionActivity` opens duplicate SSE connections
**File:** `hooks/useSSESessionActivity.ts:22-54` + `hooks/useSessionEvents.ts:273-376`
**Severity:** MEDIUM

The session detail page (`app/sessions/[id]/page.tsx:240`) calls `useSSESessionActivity(id)` which opens its own dedicated SSE connection to `/api/events`. Meanwhile, the dashboard (if rendered in a sidebar or background) may also have an open SSE connection. Each SSE connection triggers a 5-second polling loop on the server that calls `sessionManager.list()` — two connections means double the polling load, and they're not synchronized.

Worse, the `useSSESessionActivity` hook creates a **new EventSource on every `sessionId` change** (line 51 dep array), meaning rapid session switching opens and closes SSE connections rapidly.

### C-04: Session detail page polls three endpoints every 5 seconds
**File:** `app/sessions/[id]/page.tsx:433-440`
**Severity:** MEDIUM

```typescript
const interval = setInterval(() => {
  fetchSession();
  fetchProjectSessions();
  fetchSidebarSessions();
}, 5000);
```

This fires three parallel HTTP requests every 5 seconds, each triggering full service initialization + session listing + enrichment. Combined with the SSE connection also polling every 5s on the server side, a single session detail page generates approximately **8 HTTP requests every 5 seconds** (3 client polls + 1 SSE connection polling server-side). The mux WebSocket also sends session snapshots that trigger additional `fetchSidebarSessions()` calls (line 400). No deduplication or backpressure mechanism exists.

### C-05: `enrichSessionPR` mutates input in place
**File:** `lib/serialize.ts:272-427`
**Severity:** MEDIUM

`enrichSessionPR()` directly mutates the `DashboardSession` object passed to it (e.g., `dashboard.pr.state = cached.state` at line 285). Combined with `refreshDashboardSessionDerivedFields` (line 156-159) which also mutates `session.attentionLevel` in place, this means the `sessions` array in React state is being mutated without creating new object references. This can cause React to miss re-renders since object identity hasn't changed (shallow comparison in memo components won't detect the change).

The `SessionCard` memo comparison (`areSessionCardPropsEqual` at `SessionCard.tsx:834-842`) uses `prev.session === next.session` — if the session object is mutated in place, the memo will return `true` and skip re-rendering, showing stale data.

### C-06: Race condition in mux reconnect + terminal re-open
**File:** `providers/MuxProvider.tsx:107-115`
**Severity:** MEDIUM

On reconnect, the provider re-opens all terminals in `openedTerminalsRef`:
```typescript
for (const terminalId of openedTerminalsRef.current) {
  ws.send(JSON.stringify(openMsg));
}
```

If a DirectTerminal component unmounts during the reconnect window (e.g., user navigates away from session detail page), `closeTerminal` sets `openedTerminalsRef.current.delete(id)` but the reconnect loop may have already started iterating. The `close` message races with the `open` message on the new WebSocket, potentially leaving a zombie terminal on the server.

---

## Stale State Issues

### S-01: `rateLimitDismissed` never resets
**File:** `components/Dashboard.tsx:152`
**Severity:** LOW

```typescript
const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
```

Once the user dismisses the rate limit banner, it stays dismissed for the entire session. If the rate limit resolves and then recurs later, the user won't see the warning again. Should reset when `anyRateLimited` transitions from `false` to `true`.

### S-02: Session activity state can disagree with lifecycle state
**File:** `lib/types.ts:475-518` (getDetailedAttentionLevel)
**Severity:** MEDIUM

The attention level computation checks both `session.lifecycle` (server-computed) and `session.status`/`session.activity` (which may come from SSE snapshots with only partial data). When an SSE snapshot patches `status` and `activity` but doesn't update `lifecycle`, the function can return conflicting attention levels. For example, if lifecycle says `prReason === "ci_failing"` but the SSE snapshot hasn't updated the lifecycle facet, the card may not appear in the "review" zone.

### S-03: `doneExpanded` state not reset on session changes
**File:** `components/Dashboard.tsx:162`
**Severity:** LOW

The done-bar expanded/collapsed state persists across all session updates. If the user expands the done section and new sessions complete, the expanded state remains but the content has changed — the user may not notice new items appeared.

### S-04: `useSessionEvents` SSE snapshot patches don't update PR data
**File:** `hooks/useSessionEvents.ts:49-64`
**Severity:** MEDIUM

The SSE snapshot only patches `status`, `activity`, and `lastActivityAt`. It does NOT update:
- `pr` (PR state, CI status, merge readiness)
- `lifecycle` (canonical state)
- `attentionLevel` on the session object itself (only on `sseAttentionLevels`)

This means cards in the dashboard can show correct attention zone placement (from `sseAttentionLevels`) but incorrect card content (stale PR data, stale lifecycle labels). The full refresh happens on a 15-second stale timer or membership change, creating a window where card content and zone placement disagree.

---

## Missing Error Boundaries

### E-01: No error boundary around SessionDetail
**File:** `components/SessionDetail.tsx`
**Severity:** MEDIUM

`SessionDetail` is a complex component with multiple async operations (kill, restore, send message). If any of these throw during render (not in an event handler), the error propagates up to `app/error.tsx` which shows a generic error. There's no component-level error boundary to isolate failures in the session detail view (e.g., malformed PR data causing a render crash) from the rest of the app.

### E-02: No error boundary around DirectTerminal
**File:** `components/DirectTerminal.tsx`
**Severity:** MEDIUM

The terminal component handles errors via `useState` (line 189), but if the error occurs during the `Promise.all` dynamic import chain (lines 258-263), the error is caught by the `.catch` handler and sets `error` state. However, if xterm.js itself throws during render (e.g., invalid terminal options), there's no React error boundary to catch it.

### E-03: Global error boundary has no CSS variables
**File:** `app/global-error.tsx:19`
**Severity:** LOW

The global error boundary renders `<html className="dark"><body className="bg-[var(--color-bg-base)]...">`. But since this replaces the entire document, CSS variables from `globals.css` may not be loaded, causing the error page to render with fallback colors. The error display could be unreadable if Tailwind classes fail to resolve.

---

## Performance Problems

### P-01: SSE route calls `sessionToDashboard` every 5 seconds per connection
**File:** `app/api/events/route.ts:130-194`
**Severity:** HIGH

Each connected SSE client triggers a server-side `setInterval` that:
1. Calls `sessionManager.list()` (reads from disk)
2. Calls `filterWorkerSessions()` (CPU)
3. Calls `workerSessions.map(sessionToDashboard)` (CPU + object allocation)
4. Calls `getAttentionLevel()` for each session (CPU)

With N SSE clients, this runs N times every 5 seconds. For 10 connected dashboard tabs, that's 10 full serialization cycles every 5 seconds. The sessions aren't cached between invocations — each poll starts fresh.

### P-02: `/api/sessions` enrichment waterfall
**File:** `app/api/sessions/route.ts:137-164`
**Severity:** MEDIUM

The sessions endpoint has a two-phase enrichment:
1. Metadata enrichment (3s timeout) — issue labels + agent summaries
2. PR enrichment (4s total, 1.5s per PR) — SCM API calls for each PR

Phase 2 only starts after phase 1 settles. With 10 sessions each having PRs, this creates 10 sequential API calls to GitHub with a 1.5s timeout each, bounded by a 4s total timeout. In the worst case, only the first 2-3 PRs get enriched before the timeout.

The `settlesWithin` wrapper means all settled results are used — partial data is acceptable — but the waterfall adds latency to every response.

### P-03: `Dashboard.tsx` computes attention levels twice per session
**File:** `components/Dashboard.tsx:199-213` + `hooks/useSessionEvents.ts:67-69`
**Severity:** LOW

The dashboard computes `getAttentionLevel(session, attentionZones)` in the `grouped` useMemo (line 212), but `sseAttentionLevels` already has server-computed values. The client-side computation is redundant for sessions that haven't changed since the last SSE snapshot. This is a minor CPU waste.

### P-04: Session detail page uses `JSON.stringify` for deep equality
**File:** `app/sessions/[id]/page.tsx:84-86,96-100`
**Severity:** LOW

`areProjectsEqual` and `areSidebarSessionsEqual` use `JSON.stringify` for deep comparison. This is O(n) in string size and allocates temporary strings on every comparison. For large session arrays with rich PR data, this can cause noticeable GC pressure during polling.

### P-05: `DynamicFavicon` re-creates canvas SVG on every attention level change
**File:** `components/DynamicFavicon.tsx`
**Severity:** LOW

Every time `sseAttentionLevels` changes (every 5s from SSE), `countNeedingAttention` re-runs and potentially sets a new favicon. The favicon generation creates a new canvas element each time. While lightweight, this is unnecessary work when the count hasn't changed.

### P-06: `DirectTerminal` effect deps include unstable function references
**File:** `components/DirectTerminal.tsx:566-577`
**Severity:** MEDIUM

The main terminal initialization `useEffect` depends on `subscribeTerminal`, `writeTerminal`, `resizeTerminalMux`, `openTerminal`, `closeTerminal` — all from `MuxProvider`. While these are wrapped in `useCallback` with `[]` deps, the `contextValue` useMemo in MuxProvider (line 309-320) recreates when `status` or `sessions` changes. However, since the individual callbacks are memoized with `useCallback(fn, [])`, they're stable. This is correct but fragile — if any callback dep changes, the terminal reinitializes (destroying scrollback and WebSocket connection).

---

## SSE/WebSocket Handling Issues

### W-01: SSE connection has no maximum retry limit
**File:** `hooks/useSessionEvents.ts:273-376`
**Severity:** MEDIUM

The native `EventSource` API handles reconnection automatically, but there's no limit on retry attempts. If the server is permanently down, the browser will retry indefinitely. The `disconnectedTimerRef` sets status to "disconnected" after 4 seconds, but the EventSource continues retrying silently in the background.

### W-02: Mux WebSocket exponential backoff caps at 30s, never gives up
**File:** `providers/MuxProvider.tsx:175`
**Severity:** LOW

```typescript
const delayMs = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 30_000);
```

Reconnect attempts grow exponentially up to 30 seconds and then retry forever at that interval. No maximum retry count or circuit breaker exists. In a mobile context, this could drain battery on a permanently unavailable server.

### W-03: No ping/pong heartbeat on mux WebSocket
**File:** `providers/MuxProvider.tsx`
**Severity:** LOW

The mux protocol defines `{ ch: "system", type: "ping" }` and `{ ch: "system", type: "pong" }` (mux-protocol.ts:10-11) but neither the client nor server sends pings. If the connection goes stale (e.g., server process killed without FIN), the client won't detect it until the next send attempt fails.

### W-04: SSE snapshot race with full refresh
**File:** `hooks/useSessionEvents.ts:160-234`
**Severity:** MEDIUM

When an SSE snapshot triggers `scheduleRefresh()`, the refresh fetches `/api/sessions` which returns fully enriched data (with PR enrichment). Between the SSE snapshot (minimal data) and the refresh response (full data), the sessions in state have mixed fidelity — some fields from SSE, others from the previous full fetch. If the refresh is slow (hitting GitHub API rate limits), this mixed state can persist for seconds.

The `activeRefreshControllerRef` (line 139) prevents concurrent refreshes, but it also means a rapid succession of SSE snapshots that all trigger membership changes will result in only one refresh — the rest are lost.

### W-05: Mux `sessions` state update on every snapshot
**File:** `providers/MuxProvider.tsx:155-157`
**Severity:** LOW

```typescript
} else if (msg.ch === "sessions" && msg.type === "snapshot") {
  setSessions(msg.sessions);
}
```

This sets state on every incoming session snapshot, even if nothing changed. Since `sessions` is in the `contextValue` useMemo deps (line 319), it causes a re-render of every consumer on every mux message. The `useSessionEvents` hook then processes these sessions and may trigger additional state updates.

---

## Caching Bugs

### K-01: `processedIssues` in services.ts is never cleared
**File:** `lib/services.ts:124`
**Severity:** MEDIUM

```typescript
const processedIssues = new Set<string>();
```

This module-level set tracks issues that have been processed by `labelIssuesForVerification`. It grows unboundedly and never gets cleared. If an issue is closed and reopened (e.g., revert + relabel), the `processedIssues` set prevents it from being labeled again within the same server process lifetime.

### K-02: TTLCache `size()` includes stale entries
**File:** `lib/cache.ts:75-77`
**Severity:** LOW

```typescript
size(): number {
  return this.cache.size;
}
```

The `size()` method returns the Map size including expired entries that haven't been evicted yet. If used for monitoring or debugging, it overreports cache population. Stale entries are only evicted on `get()` or the periodic cleanup interval.

### K-03: PR cache hit doesn't revalidate `enriched` flag
**File:** `lib/serialize.ts:283-297`
**Severity:** LOW

When a cached PR enrichment is found, the code sets `dashboard.pr.enriched = true` (line 296). But the cached data may include the rate-limit blocker flag from a previous failed enrichment. If the rate limit has since resolved, the cache will continue serving rate-limited data until the TTL expires (up to 60 minutes for rate-limited entries, line 407).

### K-04: `issueTitleCache` has no eviction trigger
**File:** `lib/serialize.ts:31`
**Severity:** LOW

```typescript
const issueTitleCache = new TTLCache<string>(300_000);
```

The issue title cache has a 5-minute TTL but entries are only evicted on `get()` or the periodic cleanup. If many unique issues are viewed, old entries accumulate until the cleanup interval fires.

---

## UX Gaps

### U-01: No loading skeleton for session detail page content
**File:** `app/sessions/[id]/page.tsx:443-448`
**Severity:** LOW

The loading state shows a plain text "Loading session..." with no visual structure matching the final layout. This causes a jarring layout shift when the session data loads.

### U-02: No feedback when kill/restore fails silently
**File:** `components/SessionDetail.tsx:405-423`
**Severity:** MEDIUM

`handleKill` and `handleRestore` in `SessionDetail` call `window.location.reload()` on success but only `console.error` on failure. There's no toast or visual feedback for the user when these operations fail.

### U-03: No confirmation for PR merge from session card
**File:** `components/SessionCard.tsx:776-798`
**Severity:** MEDIUM

The "Merge PR" button on the session card fires immediately with no confirmation dialog. While the PR merge endpoint validates merge readiness, there's no user-facing "Are you sure?" step. Accidental clicks on mobile (where buttons are smaller) could trigger unintended merges.

### U-04: `rateLimitDismissed` persists across project switches
**File:** `components/Dashboard.tsx:152`
**Severity:** LOW

If the user dismisses the rate limit banner on one project, then switches to another project that also has rate-limited data, the banner stays dismissed because the state is per-component-mount, not per-project.

### U-05: No offline/empty state for terminal when mux is disconnected
**File:** `components/DirectTerminal.tsx`
**Severity:** LOW

When the mux WebSocket is disconnected, the terminal shows a status indicator but the terminal area itself is empty/blank. There's no helpful message like "Reconnecting to terminal..." or a retry button in the terminal area.

### U-06: No keyboard shortcut for common actions
**Severity:** LOW

No keyboard shortcuts exist for common actions like:
- Switching between sessions
- Toggling terminal fullscreen
- Collapsing/expanding sidebar

This is a power-user gap for a developer-oriented dashboard.

### U-07: Session detail page title emoji from SSE can flash
**File:** `app/sessions/[id]/page.tsx:243-249`
**Severity:** LOW

The document title updates on every SSE activity change, causing the browser tab title to flash between different emoji states as the agent works. This can be visually distracting when monitoring multiple tabs.

---

## Additional Findings

### A-01: `getServices()` can throw on missing config, handled inconsistently
**File:** `lib/services.ts:58-71`
**Severity:** MEDIUM

`getServices()` returns a `Promise<Services>` and can reject if `loadConfig()` fails. Different callers handle this differently:
- SSE route (`app/api/events/route.ts:73`) wraps in try/catch and sends empty snapshot
- Sessions route (`app/api/sessions/route.ts:187-206`) wraps in outer try/catch
- Backlog route (`app/api/backlog.ts:12`) starts poller as side effect of GET

The rejected promise is cached with a retry-on-next-call pattern (line 63-67), but during the retry window, concurrent callers all get the same rejected promise.

### A-02: `startBacklogPoller()` called as side effect of GET request
**File:** `app/api/backlog.ts:12` + `lib/services.ts:114-121`
**Severity:** LOW

The backlog poller is started as a side effect of serving GET `/api/backlog`. This means:
1. The first GET request has side effects (non-idempotent)
2. The poller starts before the caller gets a response
3. There's no admin endpoint to stop the poller

### A-03: `Terminal.tsx` uses iframe for ttyd (legacy, unused?)
**File:** `components/Terminal.tsx`
**Severity:** LOW

There's a legacy `Terminal` component that uses ttyd via iframe, alongside the current `DirectTerminal` that uses xterm.js + WebSocket. If both are importable, there may be confusion about which to use. The legacy component should be removed or clearly marked deprecated.

### A-04: `handleSpawnOrchestrator` is not wrapped in `useCallback`
**File:** `components/Dashboard.tsx:363-399`
**Severity:** LOW

`handleSpawnOrchestrator` is defined as a regular `async` function inside the component, not wrapped in `useCallback`. It closes over `spawningProjectIds` and `spawnErrors` state, which means it gets a new reference on every render. If passed to `ProjectOverviewGrid` (which isn't memoized), it triggers re-renders.

### A-05: No Content-Security-Policy headers on SSE or API responses
**File:** All API routes
**Severity:** LOW

API responses don't include `Content-Security-Policy`, `X-Frame-Options`, or other security headers. While the Next.js framework adds some defaults, explicit headers on sensitive endpoints (webhooks, terminal) would be prudent.

### A-06: `useSearchParams()` in Dashboard may cause Suspense boundary issues
**File:** `components/Dashboard.tsx:150`
**Severity:** LOW

`useSearchParams()` in a client component without a Suspense boundary can cause a runtime error in production Next.js builds. The Dashboard component doesn't have a parent Suspense boundary in `app/page.tsx`, which means the entire page could crash if search params are accessed during SSR.
