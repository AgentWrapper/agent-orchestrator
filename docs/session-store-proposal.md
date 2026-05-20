# Session Store Proposal: useSyncExternalStore

> Status: **proposal** | Scope: `packages/web` | Dependencies: none (React 19 built-in)
> Cross-model validated: Claude Opus + OpenAI Codex independently converged on this approach

---

## Problem Statement

The dashboard receives real-time session data via WebSocket push (MuxProvider) and periodic HTTP refresh. All session state lives in a single `DashboardSession[]` array inside a `useReducer` hook. This causes:

1. **MuxProvider bundles unrelated concerns** -- session data, terminal functions, and connection status in one context. Consumers needing only `subscribeTerminal()` re-render when session data changes.
2. **HTTP refresh collapses memoization** -- the `"reset"` action replaces the entire array with new object references, invalidating all downstream `useMemo` and `React.memo` boundaries.
3. **Dashboard recomputes everything** -- 5 `useMemo` derivations (projectSessions, displaySessions, grouped, sessionsByProject, projectOverviews) all invalidate on any single session change.
4. **ProjectSidebar is not memoized** -- receives the full `sessions` array as a prop, re-renders on every parent update.
5. **No granular subscription** -- components cannot subscribe to a single session or a subset without receiving the entire array.

---

## Proposed Architecture

### SessionStore (plain class, outside React)

A normalized store that lives outside React's render cycle. WebSocket and HTTP both write into it. React components subscribe to granular slices via `useSyncExternalStore`.

```
WebSocket pushes ──▶ SessionStore.patch()
HTTP refresh    ──▶ SessionStore.reconcile()
                         │
                         ▼
              ┌─────────────────────┐
              │     SessionStore     │
              │                     │
              │  Map<id, Session>   │  ◀── normalized by ID
              │  Map<project, ids>  │  ◀── derived index
              │  Map<zone, ids>     │  ◀── derived index
              │  version: number    │  ◀── change counter
              │  listeners: Set     │  ◀── subscribers
              └─────────┬───────────┘
                        │
          useSyncExternalStore selectors
                        │
     ┌──────────┬───────┴───────┬──────────────┐
     │          │               │              │
useSession  useZoneIds   useProjectIds    useCounts
   (id)      (zone)      (projectId)       ()
     │          │               │              │
     ▼          ▼               ▼              ▼
SessionCard  AttentionZone  ProjectSidebar  FaviconBadge
```

### Store Implementation

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

    // Remove sessions no longer present
    for (const id of this.sessions.keys()) {
      if (!incomingIds.has(id)) {
        this.sessions.delete(id);
        this.removeFromIndexes(id);
        changed = true;
      }
    }

    if (changed) this.notify();
  }

  // --- Selectors (stable refs when data unchanged) ---

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

  // --- Subscription ---

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

import { useSyncExternalStore, useRef, useCallback } from "react";
import { sessionStore } from "@/lib/session-store";

/** Subscribe to a single session by ID */
export function useSession(id: string): DashboardSession | undefined {
  const prev = useRef<DashboardSession | undefined>(undefined);

  return useSyncExternalStore(
    sessionStore.subscribe,
    () => {
      const next = sessionStore.getSession(id);
      // Stable ref: return previous if unchanged
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

/** Subscribe to zone counts only (for badges, favicon) */
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
    sessionStore.patch(msg.patches);  // <-- bypasses React state entirely
  }
  // terminal data still dispatched to callbacks
};
```

---

## Current vs Proposed Comparison

| Concern | Current | Proposed |
|---------|---------|----------|
| Data structure | `DashboardSession[]` (flat array) | `Map<string, DashboardSession>` (normalized) |
| Subscription granularity | Whole array or nothing | Per-session, per-zone, per-project, aggregates |
| HTTP refresh | Replaces all refs (memo collapse) | Structural merge, preserves unchanged refs |
| MuxProvider responsibility | Session data + terminal funcs | Terminal funcs + status only |
| Where state lives | React state (useReducer) | External store (plain class) |
| React integration | Context + prop drilling | `useSyncExternalStore` with selectors |
| SessionCard re-renders | When any session changes | Only when ITS session changes |
| ProjectSidebar re-renders | Every update (not memoized) | Only when project membership/counts change |
| Dashboard memo chain | 5 useMemos, all invalidate together | Replaced by targeted selector hooks |
| Dependencies added | -- | None (React 19 built-in) |

---

## Migration Path

### Phase 1: Foundation (additive, no breaking changes)

1. **Create `SessionStore` class** -- `packages/web/src/lib/session-store.ts`
   - Normalized Map storage
   - `patch()` and `reconcile()` methods
   - Derived indexes (by project, by zone)
   - Full unit test suite (pure class, no React needed)

2. **Create selector hooks** -- `packages/web/src/hooks/useSessionStore.ts`
   - `useSession(id)`
   - `useZoneSessionIds(zone)`
   - `useProjectSessionIds(projectId)`
   - `useAttentionCounts()`
   - `useConnectionStatus()`

### Phase 2: Wire data sources

3. **MuxProvider writes to store** -- WebSocket `onmessage` calls `sessionStore.patch()` instead of `setSessions()`
4. **HTTP reconciliation** -- Replace `dispatch({ type: "reset" })` with `sessionStore.reconcile(sessions)` (structural merge preserving refs)

### Phase 3: Migrate consumers (incremental, per-component)

5. **SessionCard** -- uses `useSession(id)` instead of receiving session as prop
6. **AttentionZone** -- uses `useZoneSessionIds(zone)` to get ID list, renders `<SessionCard id={id} />` for each
7. **ProjectSidebar** -- uses `useProjectSessionIds(projectId)` + `useAttentionCounts()`
8. **Dashboard** -- remove the 5 `useMemo` derivations, replaced by selector hooks
9. **FaviconBadge / document title** -- uses `useAttentionCounts()`

### Phase 4: Cleanup

10. **Delete `useSessionEvents` hook** -- no longer needed
11. **Remove session data from MuxProvider context** -- only terminal functions remain
12. **Remove unused props** -- `sessions` prop no longer passed down the tree

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

---

## Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Re-renders per WS push (50 sessions, 1 changed) | ~15 components | ~3 components |
| Re-renders per HTTP refresh (50 sessions) | ~50+ components (all memo broken) | Only components whose data actually changed |
| ProjectSidebar renders per second | 1 per WS push (~0.2/s) | Only on membership changes |
| SessionCard renders for unrelated updates | Yes (parent re-renders) | No (subscribes to own ID) |
| Bundle size added | -- | ~0 (React built-in) |
| External dependencies | -- | None |

---

## Open Questions

1. **Server-side rendering hydration** -- The store is a singleton. On SSR, initial session data comes from server props. How do we hydrate the store on first client render without a flash? Likely: initialize store from `initialSessions` prop in a layout-level effect, gate selectors with a `hydrated` flag.

2. **Concurrent mode safety** -- `useSyncExternalStore` is concurrent-mode safe by design (it's why it exists). But verify that `getSnapshot` stability guarantees hold when the store mutates between React's render and commit phases.

3. **DevTools** -- Without Redux DevTools or React Query DevTools, debugging store state requires a custom solution. Consider exposing `sessionStore` on `window` in dev mode, or building a simple `<StoreInspector />` component.

4. **Store reset on navigation** -- When navigating between projects in the dashboard, should the store clear and re-initialize? Or keep all sessions and let selectors filter? Current behavior keeps all sessions (sidebar shows all projects) -- preserve this.
