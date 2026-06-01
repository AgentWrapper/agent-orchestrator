# State Management Improvements

## Current Architecture

| Concern | Mechanism | Location |
|---|---|---|
| Real-time sessions | MuxProvider (SSE/WebSocket) | `providers/MuxProvider.tsx` |
| REST data (projects, PRs, settings) | Hand-rolled `fetchJsonWithTimeout` + `useState` per page | Scattered across pages |
| UI state (sidebar, modals, filters) | `useState` per component | Every page component |

No external state library (no Redux, Zustand, TanStack Query, etc.).

---

## Bottlenecks & Issues

### 1. Session Detail Page — State Explosion

**File:** `app/sessions/[id]/page.tsx`

**Problem:** A single component holds 16 `useState` calls and 14 `useRef` calls (lines 400-439). This mixes three concerns: data fetching orchestration, loading/error state management, and UI layout. The component is ~950 lines.

```
useState:  session, zoneCounts, projectOrchestratorId, projects, projectsLoading,
           sidebarSessions, sidebarOrchestrators, loading, routeError, sessionMissing,
           sidebarError, prefixByProject, sidebarCollapsed, mobileSidebarOpen

useRef:    sessionProjectIdRef, sessionIsOrchestratorRef, resolvedProjectSessionsKeyRef,
           prefixByProjectRef, hasLoadedSessionRef, pendingMuxSessionsRef,
           fetchingSessionRef, fetchingProjectSessionsRef, fetchingSidebarRef,
           sessionFetchControllerRef, projectSessionsFetchControllerRef,
           sidebarFetchControllerRef, pageUnloadingRef,
           sessionLoadFailureCountRef, sessionLoadFirstFailureAtRef, sessionLoadRetryTimerRef
```

**Impact:** Hard to reason about, hard to test, any fetch change touches a large file with unrelated UI code.

### 2. Duplicated Fetch Logic — No Shared Cache

**Files:** `app/sessions/[id]/page.tsx`, Dashboard layout, sidebar components

**Problem:** Projects (`/api/projects`) are fetched independently in multiple places. Every page navigation re-fetches from scratch with identical loading/error handling boilerplate. There is no shared in-memory cache, so navigating dashboard → session detail → back causes two full project fetch cycles.

**Impact:** Unnecessary network requests, loading flash on every navigation, ~40 lines of repeated loading/error state per page.

### 3. Duplicated Sidebar State — 4x Copy-Paste

**Files:**
- `components/Dashboard.tsx` (lines 199-200)
- `components/SessionDetail.tsx` (line 66)
- `app/sessions/[id]/page.tsx` (line 201)
- `components/PullRequestsPage.tsx` (lines 74-75)

**Problem:** `sidebarCollapsed` and `mobileMenuOpen` state + toggle handlers are duplicated identically across 4 page components (19 occurrences total). Each file has its own `useState`, its own toggle callback, its own CSS class logic.

**Impact:** Any sidebar behavior change requires editing 4+ files identically. Bug-prone, easy to drift.

### 4. Loading/Error State Boilerplate

**Problem:** Every data-fetching component repeats the same pattern:
```tsx
const [loading, setLoading] = useState(true);
const [error, setError] = useState<Error | null>(null);
const [data, setData] = useState<T | null>(null);

useEffect(() => {
  (async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await fetch(...);
      setData(result);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  })();
}, []);
```

This appears for projects, sessions, PRs, sidebar sessions, project settings — each with its own timeout, abort controller, and error handling.

**Impact:** ~60% of the state declarations in page components are fetch orchestration boilerplate, not actual UI state.

### 5. No In-flight Deduplication Across Pages

**Problem:** `fetchingSessionRef`, `fetchingProjectSessionsRef`, `fetchingSidebarRef` (page.tsx:430-432) guard against concurrent fetches **within a single component instance**. But navigating between pages can trigger the same API call simultaneously from the old and new page.

**Impact:** Race conditions on fast navigation, wasted requests.

---

## Decision: No New Libraries

**Why not TanStack Query:** The hot path is WebSocket push via MuxProvider, not HTTP fetch. TanStack Query's core value (HTTP cache + refetch + stale management) would be underutilized. For the session data specifically, you'd end up manually pushing SSE updates into `queryClient.setQueryData()` — which is just a worse event bus. Revisit only if the app grows significant HTTP-fetched pages (audit logs, history, config management).

**Why not Zustand:** No shared client state problem exists yet. The duplicated sidebar state is a hook extraction, not a store problem. Zustand becomes useful if/when cross-component client state grows (command palette, multi-step wizards, global drag-and-drop).

---

## Plan

### Change 1: Extract `useSidebar()` Hook

**Scope:** Shared UI state hook, no new dependency.

**Create:** `hooks/useSidebar.ts`

Consolidate `sidebarCollapsed`, `mobileMenuOpen`, toggle handlers, backdrop click, and responsive breakpoint logic. Optionally persist `sidebarCollapsed` to `localStorage`.

**Replaces:** 4 duplicated state blocks in Dashboard, SessionDetail, SessionPage, PullRequestsPage.

**Savings:** ~80 lines of duplicated state + handler code, single source of truth for sidebar behavior.

### Change 2: Extract `useProjects()` Hook

**Scope:** Shared fetch hook with in-memory cache, no new dependency.

**Create:** `hooks/useProjects.ts`

- Fetches `/api/projects` once, caches in module-level variable
- Returns `{ projects, loading, error, refetch }`
- Subsequent calls return cached data immediately
- Optional stale timeout to refetch in background

**Replaces:** Duplicated project fetch logic in `page.tsx:460-484` and elsewhere.

**Savings:** ~40 lines of fetch + loading/error boilerplate per consumer, shared cache eliminates re-fetch on navigation.

### Change 3: Extract `useSession()` and `useSidebarSessions()` Hooks

**Scope:** Shared fetch hooks for session detail data.

**Create:**
- `hooks/useSession.ts` — fetches single session by ID, handles loading/error/missing states
- `hooks/useSidebarSessions.ts` — fetches sidebar session list for the sidebar component

Each hook encapsulates its own fetch, abort controller, loading state, error state, and retry logic. MuxProvider SSE updates can be merged in via a callback/option.

**Replaces:** ~200 lines of fetch orchestration in `page.tsx` (lines 460-620).

**Savings:** Session detail page drops from ~950 lines to ~600 lines. Fetch logic is testable in isolation.

### Change 4: Simplify Session Detail Page

**Scope:** Refactor `app/sessions/[id]/page.tsx` to use the new hooks.

After changes 1-3, the component should only contain:
- Route param extraction
- MuxProvider SSE integration (existing)
- UI layout (JSX)

Target: remove 14 `useRef` calls (in-flight guards move into hooks), remove 8+ `useState` calls (loading/error/data move into hooks).

---

## What Stays the Same

- **MuxProvider** — no changes. Already correct for real-time SSE/WebSocket data.
- **No new dependencies** — all improvements are plain React hooks.
- **Existing component APIs** — components receive the same props, behavior is identical.
