# Frontend State Management Plan

> Status: **proposal** | Owner: TBD | Scope: `packages/web`
> Last updated: 2026-05-17
> Cross-model validated: Claude Opus + OpenAI Codex independently converged on the core approach
> Consolidates: `session-store-proposal.md`, `state-management-improvements.md` (both superseded)

---

## Why This Document Exists

The web dashboard ships recurring UI bugs -- sidebar flicker, rename inputs that lose focus mid-typing, popovers that close unexpectedly, sluggish mobile menu, optimistic-update "flashes," race conditions on the session detail page, and unnecessary re-renders across all components when a single session changes.

These are not unrelated. They share a single root cause: **all session state lives in one flat array inside a `useReducer` hook, and every component subscribes to the whole array.**

This document is the plan to fix the root cause (normalized external store with granular selectors), harden the transport layer, and rewrite the session-detail god-component.

---

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MuxProvider (Context)                       │
│                                                                     │
│  WebSocket ──▶ sessions: SessionPatch[]  ◀── one context value     │
│                status: "connected"            bundles EVERYTHING    │
│                lastError: string | null                             │
│                subscribeTerminal(...)                               │
│                writeTerminal(...)                                   │
│                openTerminal(...)                                    │
│                closeTerminal(...)                                   │
│                resizeTerminal(...)                                  │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ any field changes = ALL consumers re-render
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│              useSessionEvents (useReducer → single State)           │
│                                                                     │
│  State = {                                                         │
│    sessions: DashboardSession[]   ◀── one big array                │
│    attentionLevels: Record<id, level>                              │
│    liveSessionsResolved: boolean                                   │
│    loadError: string | null                                        │
│  }                                                                 │
│                                                                     │
│  Actions:                                                          │
│    "snapshot" → patch 3 fields per session, rebuild attention map   │
│    "reset"    → REPLACE entire array (HTTP refresh) ← kills memo   │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ returns { sessions, attentionLevels, ... }
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    DashboardInner (one component)                    │
│                                                                     │
│  Derives EVERYTHING from the sessions array:                       │
│                                                                     │
│  projectSessions    = filter by projectId         (useMemo)        │
│  displaySessions    = filter by activeSessionId   (useMemo)        │
│  grouped            = getAttentionLevel() x N     (useMemo, O(n))  │
│  sessionsByProject  = group all by projectId      (useMemo)        │
│  projectOverviews   = counts per project          (useMemo)        │
│                                                                     │
│  ALL 5 memos invalidate when sessions array ref changes            │
└──────┬──────────────┬──────────────────┬────────────────────────────┘
       │              │                  │
       ▼              ▼                  ▼
  AttentionZone   ProjectSidebar    ProjectOverviewGrid
  (memoized)      (NOT memoized)    (re-renders always)
       │
       ▼
  SessionCard
  (memoized -- but parent still re-renders to pass new props)
```

Transport-wise this is a good design -- push-primary with HTTP fallback. The problems are all downstream of the transport.

---

## Root-Cause Analysis

### Core Data Layer

| # | Problem | File / line | Impact |
|---|---------|-------------|--------|
| 1 | MuxProvider bundles session data + terminal functions in one context | `MuxProvider.tsx:6-20` | Consumers needing only `subscribeTerminal()` re-render on session changes |
| 2 | `"reset"` action replaces entire `sessions` array reference even when content is identical | `useSessionEvents.ts:64-72` | Every 15s HTTP fallback invalidates every downstream `useMemo` and every memoized child |
| 3 | `attentionLevels` object replaced with fresh `Object.fromEntries(...)` every refresh | `useSessionEvents.ts:100-107` | Same cascade on a parallel path |
| 4 | No granular subscription -- components get the whole array or nothing | `useSessionEvents.ts:148` | Single session update re-renders the entire dashboard |
| 5 | No backpressure on WS messages | MuxProvider WS handler | 50 simultaneous transitions = 50 dispatches = 50 renders |

### Sidebar (`ProjectSidebar.tsx`)

| # | Problem | File / line | Bug it causes |
|---|---------|-------------|---------------|
| 6 | Not wrapped in `React.memo` | `ProjectSidebar.tsx` export | Re-renders on every Dashboard state change (toast, banner, mobile menu, spawn click) |
| 7 | Per-row JSX inline, no `<SidebarSessionRow>` subcomponent | `ProjectSidebar.tsx ~L780-910` | Entire list reconciles when one session ticks; rename input remounts and loses focus |
| 8 | Inline `onClick` / `onChange` handlers | throughout | New closures every render defeat any future child memoization |
| 9 | `sessionsByProject` Map rebuilds on every parent render | `ProjectSidebar.tsx L277` | Wasted work per render per project |
| 10 | `usePopoverClamp` recomputes whenever the parent re-renders | `ProjectSidebar.tsx L189-190` | Popover flicker, occasional unexpected close |

### Session-Detail Route (`app/sessions/[id]/page.tsx`)

This file is 935 lines, marked `"use client"`, and contains:

- 18 `useState` calls
- 11 `useRef` (many shadowing state -- a known anti-pattern)
- 14 `useEffect` with overlapping deps
- 3 parallel fetch lifecycles (`fetchSession`, `fetchProjectSessions`, `fetchSidebarSessions`), each with its own `AbortController`, in-flight ref, failure counter, and retry timer
- `SessionDetail` rendered in 5 separate branches, each duplicating the prop list

It does **not** use `useSessionEvents` -- it reimplements the same logic with different dedupe and abort semantics.

### Connection Health

Four overlapping "is live data healthy" signals (`liveSessionsResolved`, `loadError`, `muxLastError`, `mux.status`). Consumers branch on different ones, drift over time.

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    MuxProvider (SLIMMED DOWN)                        │
│                                                                     │
│  Context only holds:                                               │
│    status: "connected" | "reconnecting" | "disconnected"           │
│    subscribeTerminal(...)                                          │
│    writeTerminal(...)                                              │
│    open/close/resizeTerminal(...)                                  │
│                                                                     │
│  WebSocket data goes DIRECTLY to SessionStore (not React state)    │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ only re-renders when status changes
                      │
    WebSocket pushes  │       rAF batching coalesces bursts
          ┃           │
          ▼           │
┌─────────────────────────────────────────────────────────────────────┐
│               SessionStore (plain class, outside React)             │
│                                                                     │
│  private sessions = new Map<string, DashboardSession>()            │
│  private idsByProject = new Map<string, Set<string>>()             │
│  private idsByZone = new Map<AttentionLevel, Set<string>>()        │
│  private version = 0                                               │
│  private listeners = new Set<Listener>()                           │
│                                                                     │
│  patch(snapshots)     ← WS push, only replaces changed objects     │
│  reconcile(full)      ← HTTP refresh, structural merge             │
│  subscribe/getSnapshot ← useSyncExternalStore contract             │
│                                                                     │
│  connectionHealth: ConnectionHealth  ← unified health signal       │
└─────────────────────────────────────────────────────────────────────┘
                      │
        Granular selector hooks (useSyncExternalStore)
                      │
     ┌──────────┬─────┴─────────┬──────────────┐
     │          │               │              │
useSession  useZoneIds   useProjectIds    useCounts
   (id)      (zone)      (projectId)       ()
     │          │               │              │
     ▼          ▼               ▼              ▼
SessionCard  AttentionZone  ProjectSidebar  FaviconBadge
(own data)   (zone id list) (project ids)   (counts only)
```

---

## Store Implementation

### SessionStore Class

```typescript
// packages/web/src/lib/session-store.ts

type Listener = () => void;

class SessionStore {
  private sessions = new Map<string, DashboardSession>();
  private idsByProject = new Map<string, Set<string>>();
  private idsByZone = new Map<AttentionLevel, Set<string>>();
  private version = 0;
  private listeners = new Set<Listener>();

  /** WebSocket snapshot path -- only updates changed fields */
  patch(patches: SessionPatch[]): void {
    let changed = false;
    for (const p of patches) {
      const existing = this.sessions.get(p.id);
      if (existing && !hasChanged(existing, p)) continue;
      this.sessions.set(p.id, merge(existing, p));
      this.updateIndexes(p.id);
      changed = true;
    }
    if (changed) this.notify();
  }

  /** HTTP refresh -- structural merge, preserves unchanged refs */
  reconcile(full: DashboardSession[]): void {
    const incomingIds = new Set<string>();
    let changed = false;

    for (const session of full) {
      incomingIds.add(session.id);
      const existing = this.sessions.get(session.id);
      if (existing && isDeepEqual(existing, session)) continue;
      this.sessions.set(session.id, session);
      this.updateIndexes(session.id);
      changed = true;
    }

    // Remove sessions no longer present server-side
    for (const id of this.sessions.keys()) {
      if (!incomingIds.has(id)) {
        this.sessions.delete(id);
        this.removeFromIndexes(id);
        changed = true;
      }
    }

    if (changed) this.notify();
  }

  // --- Selectors ---

  getSession(id: string): DashboardSession | undefined {
    return this.sessions.get(id);
  }

  getZoneIds(zone: AttentionLevel): readonly string[] {
    return [...(this.idsByZone.get(zone) ?? [])];
  }

  getProjectIds(projectId: string): readonly string[] {
    return [...(this.idsByProject.get(projectId) ?? [])];
  }

  getAttentionCounts(): Record<AttentionLevel, number> {
    const counts = {} as Record<AttentionLevel, number>;
    for (const [zone, ids] of this.idsByZone) {
      counts[zone] = ids.size;
    }
    return counts;
  }

  getAllSessions(): DashboardSession[] {
    return [...this.sessions.values()];
  }

  // --- Subscription (useSyncExternalStore contract) ---

  getSnapshot = (): number => this.version;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // --- Internal ---

  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private updateIndexes(id: string): void { /* ... */ }
  private removeFromIndexes(id: string): void { /* ... */ }
}

export const sessionStore = new SessionStore();
```

### Selector Hooks

```typescript
// packages/web/src/hooks/useSessionStore.ts

import { useSyncExternalStore, useRef } from "react";
import { sessionStore } from "@/lib/session-store";

/** Subscribe to a single session by ID */
export function useSession(id: string): DashboardSession | undefined {
  const prev = useRef<DashboardSession | undefined>(undefined);
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => {
      const next = sessionStore.getSession(id);
      if (prev.current && next && !hasChanged(prev.current, next)) {
        return prev.current;
      }
      prev.current = next;
      return next;
    },
  );
}

/** Subscribe to session IDs in an attention zone */
export function useZoneSessionIds(zone: AttentionLevel): readonly string[] {
  const prev = useRef<readonly string[]>([]);
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => {
      const next = sessionStore.getZoneIds(zone);
      if (arraysEqual(prev.current, next)) return prev.current;
      prev.current = next;
      return next;
    },
  );
}

/** Subscribe to session IDs for a project */
export function useProjectSessionIds(projectId: string): readonly string[] {
  const prev = useRef<readonly string[]>([]);
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => {
      const next = sessionStore.getProjectIds(projectId);
      if (arraysEqual(prev.current, next)) return prev.current;
      prev.current = next;
      return next;
    },
  );
}

/** Subscribe to zone counts only (for badges, favicon, document title) */
export function useAttentionCounts(): Record<AttentionLevel, number> {
  const prev = useRef<Record<AttentionLevel, number> | null>(null);
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => {
      const next = sessionStore.getAttentionCounts();
      if (prev.current && countsEqual(prev.current, next)) return prev.current;
      prev.current = next;
      return next;
    },
  );
}

/** Subscribe to connection health only */
export function useConnectionHealth(): ConnectionHealth {
  const prev = useRef<ConnectionHealth | null>(null);
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => {
      const next = sessionStore.getConnectionHealth();
      if (prev.current && prev.current.state === next.state) return prev.current;
      prev.current = next;
      return next;
    },
  );
}
```

### MuxProvider Changes

```typescript
// MuxProvider context ONLY holds terminal functions + status
interface MuxContextValue {
  subscribeTerminal: (id: string, cb: (data: string) => void) => () => void;
  writeTerminal: (id: string, data: string) => void;
  openTerminal: (id: string) => void;
  closeTerminal: (id: string) => void;
  resizeTerminal: (id: string, cols: number, rows: number) => void;
  status: "connecting" | "connected" | "reconnecting" | "disconnected";
}

// WebSocket message handler writes directly to store:
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "sessions") {
    sessionStore.patch(msg.patches);  // bypasses React state entirely
  }
  // terminal data still dispatched to callbacks
};
```

### Connection Health Type

Replaces 4 overlapping booleans with a single discriminated union:

```typescript
type ConnectionHealth =
  | { state: "connecting" }
  | { state: "live" }
  | { state: "stale"; reason: string; since: number }
  | { state: "offline"; reason: string };
```

All UI components consume this single value. No more branching on inconsistent signals.

---

## Current vs Target Comparison

| Concern | Current | Target |
|---------|---------|--------|
| Data structure | `DashboardSession[]` (flat array) | `Map<string, DashboardSession>` (normalized) |
| Subscription granularity | Whole array or nothing | Per-session, per-zone, per-project, aggregates |
| HTTP refresh | Replaces all refs (memo collapse) | Structural merge, preserves unchanged refs |
| MuxProvider responsibility | Session data + terminal funcs | Terminal funcs + status only |
| Where state lives | React state (useReducer) | External store (plain class) |
| React integration | Context + prop drilling | `useSyncExternalStore` with selectors |
| SessionCard re-renders | When any session changes | Only when ITS session changes |
| ProjectSidebar re-renders | Every update (not memoized) | Only when project membership/counts change |
| Dashboard memo chain | 5 useMemos, all invalidate together | Replaced by targeted selector hooks |
| Health signals | 4 overlapping booleans | 1 discriminated union |
| Session-detail page | 935-line client god-component | SSR server page + ~150-line client wrapper |
| Dependencies added | -- | None (React 19 built-in) |

---

## Execution Plan

Each phase ships independently, is reversible per commit, and includes regression tests.

### Phase 1 -- SessionStore foundation (3 days)

**Goal:** build the normalized store and selector hooks. Additive only -- no existing code changes.

**Changes:**

1. **Create `SessionStore` class** -- `packages/web/src/lib/session-store.ts`
   - Normalized `Map<string, DashboardSession>` storage
   - `patch()` for WebSocket snapshots (only replaces changed objects)
   - `reconcile()` for HTTP refresh (structural merge, preserves unchanged refs, removes departed sessions)
   - Derived indexes: `idsByProject`, `idsByZone` (maintained eagerly on mutation)
   - `ConnectionHealth` discriminated union tracking
   - `subscribe` / `getSnapshot` contract for `useSyncExternalStore`

2. **Create selector hooks** -- `packages/web/src/hooks/useSessionStore.ts`
   - `useSession(id)` -- single session, stable ref if unchanged
   - `useZoneSessionIds(zone)` -- ID list for a zone, stable ref if membership unchanged
   - `useProjectSessionIds(projectId)` -- ID list for a project
   - `useAttentionCounts()` -- aggregate counts per zone
   - `useConnectionHealth()` -- unified health signal

3. **Unit tests** for `SessionStore` class (pure class, no React test harness needed):
   - `patch()` only replaces changed session objects
   - `reconcile()` preserves refs for unchanged sessions, removes departed
   - Index maintenance (project, zone) stays consistent after mutations
   - `version` only increments on actual changes
   - Notification fires exactly once per `patch()`/`reconcile()` batch

**Files created:**
- `packages/web/src/lib/session-store.ts`
- `packages/web/src/lib/__tests__/session-store.test.ts`
- `packages/web/src/hooks/useSessionStore.ts`

**Outcome:** store and hooks exist, tested, but nothing uses them yet. Zero risk.

---

### Phase 2 -- Wire data sources + transport hardening (3 days)

**Goal:** make WebSocket and HTTP write to the store instead of React state. Add WS batching and unified health.

**Changes:**

4. **MuxProvider writes to store** -- WebSocket `onmessage` calls `sessionStore.patch()` instead of `setSessions()` React state. Remove `sessions` and `lastError` from `MuxContextValue`.

5. **WS snapshot batching** -- coalesce WebSocket messages arriving within the same animation frame into a single `patch()` call (`requestAnimationFrame` micro-batch). Prevents 50 sessions transitioning = 50 dispatches = 50 renders.

6. **HTTP reconciliation** -- Replace `dispatch({ type: "reset", sessions })` in `useSessionEvents` with `sessionStore.reconcile(sessions)`. Structural merge preserves object refs for unchanged sessions.

7. **Unified `ConnectionHealth`** -- collapse `liveSessionsResolved` + `loadError` + `muxLastError` + `mux.status` into the store's `ConnectionHealth` discriminated union. All UI components consume `useConnectionHealth()` instead of four overlapping booleans.

8. **Reconnect-with-resume** -- on WS reconnect, fire one `/api/sessions` refresh immediately and reconcile membership before resuming live pushes.

**Files touched:**
- `packages/web/src/providers/MuxProvider.tsx`
- `packages/web/src/hooks/useSessionEvents.ts`
- `packages/web/src/lib/session-store.ts` (add connection health tracking)
- Consumers that read the old four health signals (`Dashboard.tsx`, `ConnectionBar.tsx`, etc.)

**Outcome:** data flows through the store. Existing components still work (they read from `useSessionEvents` which now reads from the store). WS bursts are coalesced. Health signals are unified.

---

### Phase 3 -- Migrate consumers to selectors (3 days)

**Goal:** components subscribe to exactly what they need. Kill the render cascade.

**Changes:**

9. **SessionCard** -- uses `useSession(id)` instead of receiving session as prop. Only re-renders when ITS session changes.

10. **AttentionZone** -- uses `useZoneSessionIds(zone)` to get ID list, renders `<SessionCard id={id} />` for each. Only re-renders when zone membership changes.

11. **ProjectSidebar** -- uses `useProjectSessionIds(projectId)` + `useAttentionCounts()`. Extract subcomponents:
    - `<SidebarProjectGroup project sessionIds />` -- memoized, per-project
    - `<SidebarSessionRow id isActive />` -- memoized, per-row, uses `useSession(id)` internally
    - Stable callbacks with `useCallback` for `navigate`, `startRename`, `submitRename`, `cancelRename`, `toggleExpand`

12. **Dashboard** -- remove the 5 `useMemo` derivations (`projectSessions`, `displaySessions`, `grouped`, `sessionsByProject`, `projectOverviews`). Replaced by selector hooks in child components.

13. **FaviconBadge / document title** -- uses `useAttentionCounts()` instead of computing from full sessions array.

14. **Extract `useSidebar()` hook** -- consolidate `sidebarCollapsed`, `mobileMenuOpen`, toggle handlers, backdrop click, and responsive breakpoint logic. Currently duplicated identically across Dashboard, SessionDetail, SessionPage, PullRequestsPage (19 occurrences).

15. **Regression tests:**
    - Mount Dashboard with a frozen session list, dispatch a no-op WS snapshot, assert `ProjectSidebar` rendered exactly once and a focused rename input retains focus
    - Verify `SessionCard` does not re-render when a different session changes
    - Verify zone component re-renders only on membership change, not on field change within existing members

**Files touched:**
- `packages/web/src/components/SessionCard.tsx`
- `packages/web/src/components/AttentionZone.tsx`
- `packages/web/src/components/ProjectSidebar.tsx`
- `packages/web/src/components/Dashboard.tsx`
- new: `packages/web/src/components/sidebar/SidebarProjectGroup.tsx`
- new: `packages/web/src/components/sidebar/SidebarSessionRow.tsx`
- new: `packages/web/src/hooks/useSidebar.ts`
- new tests in `packages/web/src/components/__tests__/`

**Outcome:** render cascade eliminated. Sidebar flicker, focus loss, popover flicker, mobile menu lag, and optimistic-rename flash all fixed.

---

### Phase 4 -- Session-detail page rewrite (3-4 days)

**Goal:** turn the 935-line client god-component into an SSR-first page + thin client wrapper.

**Target shape:**

```
╭─ app/sessions/[id]/page.tsx (server) ────────────────╮
│  fetch session + projects on the server (SSR)        │
│  pass to <SessionPageClient initialData={...} />     │
╰────────────────────────────────────┬─────────────────╯
                                     ▼
╭─ SessionPageClient (~150 lines) ─────────────────────╮
│  const session = useSession(id)                      │
│  const health = useConnectionHealth()                │
│                                                      │
│  switch (state.kind) {                               │
│    case "loading":  return <Loading/>                 │
│    case "missing":  return <NotFound/>                │
│    case "error":    return <Error/>                   │
│    case "ready":    return <SessionDetail ... />      │
│  }                                                   │
╰──────────────────────────────────────────────────────╯
```

**Changes:**

16. **Move SSR initial-data fetch** to a server component in `page.tsx`.

17. **Create `SessionPageClient.tsx`** with `"use client"`. This is the only client file for the route.

18. **Replace the three parallel fetchers** with store selectors (`useSession(id)`, `useProjectSessionIds()`, `useConnectionHealth()`).

19. **Collapse 18 `useState`s** into one `useReducer` with a discriminated-union state. Impossible states become unrepresentable.

20. **Drop the 5 duplicate `<SessionDetail />` render branches** -- pick props once at the top, render once at the bottom.

21. **`React.memo`** on `SessionDetailHeader` and `SessionDetailPRCard`.

22. **`SessionDetailPRCard`:** replace the 4 `Set<string>` states with one `useReducer` keyed by `commentId`:

    ```ts
    type CommentState = "idle" | "sending" | "sent" | "error";
    type CommentMap = Record<string, CommentState>;
    ```

**Files touched:**
- `packages/web/src/app/sessions/[id]/page.tsx` (becomes server component)
- new: `packages/web/src/app/sessions/[id]/SessionPageClient.tsx`
- `packages/web/src/components/SessionDetail.tsx`
- `packages/web/src/components/SessionDetailHeader.tsx`
- `packages/web/src/components/SessionDetailPRCard.tsx`

**Outcome:** 935 lines to ~150. Race conditions structurally impossible. One store, one source of truth, no ref-shadowed state.

---

### Phase 5 -- Cleanup + guardrails (ongoing)

**Goal:** delete dead code, prevent regression.

**Changes:**

23. **Delete `useSessionEvents` hook** -- fully replaced by store selectors.

24. **Remove session data from MuxProvider context** -- only terminal functions remain.

25. **Remove unused props** -- `sessions` prop no longer passed down the tree.

26. **`PullRequestsPage`** -- migrate to store selectors (same pattern as Dashboard).

27. **Lint rule** to forbid passing fresh array/object literals as props to memoized components (catches regressions at PR time).

28. **Type a `LiveData<T>` discriminated union** at the hook boundary so every consumer must handle all health states explicitly.

---

## How This Fixes Bugs

| Bug class today | Root cause | Fixed in phase |
|---|---|---|
| All components re-render when one session changes | Single-array subscription, no granular selectors | 2-3 |
| HTTP refresh breaks all memoization | `"reset"` replaces entire array with new refs | 2 |
| Rename input loses focus mid-typing | Row remounts on refresh / parent re-render | 3 |
| Popover / menu flicker | `usePopoverClamp` reruns on every parent render | 3 |
| Expand / collapse "jumps back" | Effect fires on spurious ref change | 3 |
| Optimistic rename flashes old name | `pendingRenames` cleanup runs on every ref change | 3 |
| Mobile menu close lag | 50 rows reconcile before animation | 3 |
| Sidebar scroll jumps | DOM reconciliation on large lists every 15s | 3 |
| UI burst on startup (50 sessions transitioning) | No WS message batching | 2 |
| Stale UI window after deploy | No reconnect-with-resume | 2 |
| Different components disagree on "is live" | Four overlapping health signals | 2 |
| Session-detail race conditions | Three parallel fetchers | 4 |
| Session-detail "stale data flashes back" | Ref shadowing state | 4 |
| PR card comment-state inconsistency | Four separate `Set`s for one keyed lifecycle | 4 |

---

## Key Design Decisions

### Why a class, not a hook?

The store is a **singleton** that outlives any component mount/unmount. WebSocket reconnections, HTTP refreshes, and React concurrent mode transitions all write to the same store. A class with explicit `subscribe`/`getSnapshot` is the correct primitive for `useSyncExternalStore`.

### Why normalize by ID?

Arrays require O(n) scans to find a session. Maps give O(1) lookup. More importantly, replacing a single entry in a Map preserves all other object references -- critical for preventing downstream re-renders.

### Why derived indexes?

`idsByProject` and `idsByZone` are maintained eagerly on each `patch()`/`reconcile()`. This avoids O(n) filtering on every render. Selector hooks return stable array refs when membership hasn't changed.

### Why structural merge for HTTP refresh?

The current `"reset"` action creates new objects for every session, even if nothing changed. Structural merge compares field-by-field and only replaces the object if data actually differs. This preserves memoization across the HTTP fallback path.

### Selector equality checks

Each selector hook uses a `useRef` to cache the previous value and returns the cached ref if the new computation is shallowly equal. This prevents consumers from re-rendering when the store version bumps but their specific slice is unchanged.

---

## Pitfalls to Avoid

1. **Don't return new arrays on every call.** If `useZoneSessionIds("working")` returns `[...set]` every time the store notifies, all zone consumers still re-render. Cache the array and compare membership before returning a new ref.

2. **Membership vs field changes are different problems.** Lists subscribe to ID arrays (re-render when sessions join/leave a zone). Cards subscribe to individual session objects (re-render when their data changes). Don't conflate them.

3. **Don't move the array problem elsewhere.** A store that exposes `getAllSessions()` as the primary hook just relocates the re-render cascade. Granular selectors are the point.

4. **Test the store as a plain class.** No React test harness needed for the core logic. Test `patch()`, `reconcile()`, index maintenance, and notification behavior independently.

5. **HTTP reconciliation must not create orphan state.** When `reconcile()` receives a full session list, remove sessions from the store that are no longer present server-side.

6. **Never shadow `useState` with a `useRef`.** Fix the dep array instead. The session-detail page has 11 refs shadowing state -- this is the pattern we're eliminating.

7. **SSR hydration.** The store is a singleton. Initialize from `initialSessions` in a layout-level effect, gate selectors with a `hydrated` flag to prevent flash.

---

## Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Re-renders per WS push (50 sessions, 1 changed) | ~15 components | ~3 components |
| Re-renders per HTTP refresh (50 sessions) | ~50+ components (all memo broken) | Only components whose data actually changed |
| ProjectSidebar renders per second | 1 per WS push (~0.2/s) | Only on membership changes |
| SessionCard renders for unrelated updates | Yes (parent re-renders) | No (subscribes to own ID) |
| Session-detail page lines | 935 | ~150 |
| Health signal booleans to track | 4 | 1 discriminated union |
| Bundle size added | -- | ~0 (React built-in) |
| External dependencies | -- | None |

---

## Rollout Order and Risk

| Phase | Effort | Risk | User-visible win |
|---|---|---|---|
| 1 - Store foundation | 3 days | None (additive only) | None yet (infrastructure) |
| 2 - Wire sources + transport | 3 days | Medium (data path change) | No more WS burst renders, unified health |
| 3 - Migrate consumers | 3 days | Medium | Smoother sidebar, no focus loss, no flicker |
| 4 - Session-detail rewrite | 3-4 days | Medium-High | Faster load, no race conditions |
| 5 - Cleanup + guardrails | Ongoing | Low | Prevents regression |

**Recommendation:** Phase 1 is zero-risk infrastructure. Phase 2+3 should ship together so the store is both wired and consumed in one release. Phase 4 is independent and can follow in the next cycle.

---

## Acceptance Criteria

A phase is **done** when:

- All listed changes are merged
- The phase's regression tests exist and pass on CI
- `pnpm typecheck`, `pnpm lint`, and `pnpm --filter @aoagents/ao-web test` all pass
- A manual smoke through the dashboard + session detail confirms the bugs in the table above are gone
- No new `useRef` shadowing `useState` introduced

---

## Out of Scope

- **TanStack Query.** Not for the session data hot path. Revisit only if significant HTTP-fetched views are added.
- **Zustand / Jotai / Redux.** `useSyncExternalStore` is sufficient and adds no dependencies.
- **Virtualizing the sidebar.** With per-row memoization via store selectors, lists of <500 sessions render fine. Revisit if a user hits that.
- **Replacing the WebSocket transport.** WS-primary with HTTP fallback is the right design; it just needs the hardening in Phase 2.

---

## Open Questions

1. **SSR hydration** -- The store is a singleton. On SSR, initial session data comes from server props. How do we hydrate the store on first client render without a flash? Likely: initialize from `initialSessions` prop in a layout-level effect, gate selectors with a `hydrated` flag.

2. **DevTools** -- Without Redux/React Query DevTools, debugging store state requires a custom solution. Consider exposing `sessionStore` on `window` in dev mode.

3. **Store reset on navigation** -- When navigating between projects, should the store clear? Current behavior keeps all sessions (sidebar shows all projects) -- preserve this.

---

## Superseded Documents

This plan consolidates and supersedes:

- `docs/session-store-proposal.md` -- `useSyncExternalStore` implementation spec (merged into Phases 1-3)
- `docs/state-management-improvements.md` -- hook extraction plan (sidebar hook adopted in Phase 3; fetch hooks replaced by store selectors)

---

## References

- [`packages/web/src/providers/MuxProvider.tsx`](../packages/web/src/providers/MuxProvider.tsx)
- [`packages/web/src/hooks/useSessionEvents.ts`](../packages/web/src/hooks/useSessionEvents.ts)
- [`packages/web/src/components/Dashboard.tsx`](../packages/web/src/components/Dashboard.tsx)
- [`packages/web/src/components/ProjectSidebar.tsx`](../packages/web/src/components/ProjectSidebar.tsx)
- [`packages/web/src/components/SessionCard.tsx`](../packages/web/src/components/SessionCard.tsx)
- [`packages/web/src/components/AttentionZone.tsx`](../packages/web/src/components/AttentionZone.tsx)
- [`packages/web/src/lib/types.ts`](../packages/web/src/lib/types.ts)
- [`packages/web/src/app/sessions/[id]/page.tsx`](../packages/web/src/app/sessions/%5Bid%5D/page.tsx)
- [`packages/web/src/components/SessionDetail.tsx`](../packages/web/src/components/SessionDetail.tsx)
- [`packages/web/src/components/SessionDetailPRCard.tsx`](../packages/web/src/components/SessionDetailPRCard.tsx)
