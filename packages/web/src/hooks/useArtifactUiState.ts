"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Per-artifact UI state hooks: collapsed (per-artifact-id) and order
 * (per-session). Both persist to localStorage so the user's choices
 * survive reloads.
 */

const COLLAPSED_KEY = "ao-artifact-collapsed"; // global map: { [artifactId]: true }
const ORDER_KEY_PREFIX = "ao-artifact-order:"; // per-session: string[] of artifact ids
const RAIL_COLLAPSED_KEY = "ao-artifact-rail-collapsed"; // boolean

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage quota or disabled — silent
  }
}

/* ------------------------------------------------------------------------- */
/* Collapsed state — global map keyed by artifact id                          */
/* ------------------------------------------------------------------------- */

type CollapsedMap = Record<string, boolean>;

export function useArtifactCollapsed(artifactId: string): {
  collapsed: boolean;
  toggle: () => void;
} {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const map = readJson<CollapsedMap>(COLLAPSED_KEY, {});
    setCollapsed(Boolean(map[artifactId]));
  }, [artifactId]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      const map = readJson<CollapsedMap>(COLLAPSED_KEY, {});
      // Rebuild the map without the artifactId key when un-collapsing,
      // so localStorage doesn't accumulate stale `false`-valued entries.
      // ESLint forbids dynamic-key delete; rebuilding via destructure is the
      // idiomatic alternative.
      const updated: CollapsedMap = next
        ? { ...map, [artifactId]: true }
        : Object.fromEntries(Object.entries(map).filter(([k]) => k !== artifactId));
      writeJson(COLLAPSED_KEY, updated);
      return next;
    });
  }, [artifactId]);

  return { collapsed, toggle };
}

/* ------------------------------------------------------------------------- */
/* Whole-rail collapse — global, persists across sessions                     */
/* ------------------------------------------------------------------------- */

export function useArtifactRailCollapsed(): {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
} {
  const [collapsed, setCollapsedState] = useState(false);

  useEffect(() => {
    setCollapsedState(readJson<boolean>(RAIL_COLLAPSED_KEY, false));
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    writeJson(RAIL_COLLAPSED_KEY, next);
  }, []);

  return { collapsed, setCollapsed };
}

/* ------------------------------------------------------------------------- */
/* Order state — per-session array of artifact ids                            */
/* ------------------------------------------------------------------------- */

export function useArtifactOrder(sessionId: string): {
  /** Current explicit order. Items not in this list fall back to default sort. */
  order: string[];
  /** Move `artifactId` up one position (toward the top of the rail). */
  moveUp: (artifactId: string, currentList: string[]) => void;
  /** Move `artifactId` down one position. */
  moveDown: (artifactId: string, currentList: string[]) => void;
} {
  const storageKey = `${ORDER_KEY_PREFIX}${sessionId}`;
  const [order, setOrder] = useState<string[]>([]);

  useEffect(() => {
    setOrder(readJson<string[]>(storageKey, []));
  }, [storageKey]);

  const persist = useCallback(
    (next: string[]) => {
      setOrder(next);
      writeJson(storageKey, next);
    },
    [storageKey],
  );

  /**
   * Move helper. `currentList` is the FULLY-RESOLVED render order — i.e. the
   * artifact ids in the order they are currently shown in the rail, computed
   * from order + updatedAt-desc fallback. We use it to know where each id
   * lives right now so the move is intuitive ("up" really moves up by 1 in
   * the visible list).
   */
  const moveBy = useCallback(
    (artifactId: string, currentList: string[], delta: -1 | 1) => {
      const idx = currentList.indexOf(artifactId);
      if (idx === -1) return;
      const targetIdx = idx + delta;
      if (targetIdx < 0 || targetIdx >= currentList.length) return;

      const next = currentList.slice();
      next.splice(idx, 1);
      next.splice(targetIdx, 0, artifactId);
      persist(next);
    },
    [persist],
  );

  const moveUp = useCallback(
    (artifactId: string, currentList: string[]) => moveBy(artifactId, currentList, -1),
    [moveBy],
  );

  const moveDown = useCallback(
    (artifactId: string, currentList: string[]) => moveBy(artifactId, currentList, 1),
    [moveBy],
  );

  return { order, moveUp, moveDown };
}

/**
 * Merge an explicit user-chosen order with a default-sorted list. The user's
 * ordered ids come first (in their chosen order); any artifacts not in the
 * explicit order are appended in their default sort (typically updatedAt desc).
 *
 * Stale ids in the explicit order (artifacts that no longer exist) are dropped.
 */
export function applyArtifactOrder<T extends { id: string }>(
  items: T[],
  explicitOrder: string[],
): T[] {
  if (items.length === 0) return items;
  if (explicitOrder.length === 0) return items;

  const byId = new Map(items.map((item) => [item.id, item] as const));
  const result: T[] = [];
  const seen = new Set<string>();

  for (const id of explicitOrder) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      result.push(item);
      seen.add(id);
    }
  }

  for (const item of items) {
    if (!seen.has(item.id)) {
      result.push(item);
      seen.add(item.id);
    }
  }

  return result;
}
