import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  useArtifactCollapsed,
  useArtifactOrder,
  useArtifactRailCollapsed,
  applyArtifactOrder,
} from "../useArtifactUiState";

const COLLAPSED_KEY = "ao-artifact-collapsed";
const RAIL_COLLAPSED_KEY = "ao-artifact-rail-collapsed";
const ORDER_KEY = (sessionId: string) => `ao-artifact-order:${sessionId}`;

// Node 24+ gates the built-in localStorage behind --localstorage-file, so
// `window.localStorage` can be undefined in the test env. Install a tiny
// in-memory shim so the hook tests can exercise persistence behaviour.
beforeAll(() => {
  if (typeof window.localStorage === "undefined") {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
          return store.size;
        },
      },
    });
  }
});

describe("useArtifactCollapsed", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults to not collapsed", () => {
    const { result } = renderHook(() => useArtifactCollapsed("art-1"));
    expect(result.current.collapsed).toBe(false);
  });

  it("toggle flips state and persists to localStorage", () => {
    const { result } = renderHook(() => useArtifactCollapsed("art-1"));
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY)!)).toEqual({
      "art-1": true,
    });

    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    // un-collapsing should REMOVE the key entirely so the map doesn't accumulate stale falses
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY)!)).toEqual({});
  });

  it("reads existing collapsed state from localStorage on mount", () => {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ "art-1": true, "art-2": true }));
    const { result } = renderHook(() => useArtifactCollapsed("art-1"));
    // Initial render is `false` (no localStorage on the server-render pass); the useEffect
    // runs after mount and updates the state. Trigger a re-render to observe the post-effect value.
    expect(result.current.collapsed).toBe(true);
  });

  it("returns independent state per artifactId", () => {
    const { result: r1 } = renderHook(() => useArtifactCollapsed("art-1"));
    const { result: r2 } = renderHook(() => useArtifactCollapsed("art-2"));
    act(() => r1.current.toggle());
    expect(r1.current.collapsed).toBe(true);
    expect(r2.current.collapsed).toBe(false);
  });

  it("toggling one artifact preserves other artifacts' collapsed state", () => {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ "art-2": true }));
    const { result } = renderHook(() => useArtifactCollapsed("art-1"));
    act(() => result.current.toggle());
    const map = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY)!);
    expect(map["art-1"]).toBe(true);
    expect(map["art-2"]).toBe(true);
  });
});

describe("useArtifactRailCollapsed", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults to not collapsed", () => {
    const { result } = renderHook(() => useArtifactRailCollapsed());
    expect(result.current.collapsed).toBe(false);
  });

  it("setCollapsed persists to localStorage", () => {
    const { result } = renderHook(() => useArtifactRailCollapsed());
    act(() => result.current.setCollapsed(true));
    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe("true");

    act(() => result.current.setCollapsed(false));
    expect(result.current.collapsed).toBe(false);
    expect(window.localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe("false");
  });

  it("reads existing collapsed state from localStorage on mount", () => {
    window.localStorage.setItem(RAIL_COLLAPSED_KEY, "true");
    const { result } = renderHook(() => useArtifactRailCollapsed());
    expect(result.current.collapsed).toBe(true);
  });
});

describe("useArtifactOrder", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults to empty order", () => {
    const { result } = renderHook(() => useArtifactOrder("sess-1"));
    expect(result.current.order).toEqual([]);
  });

  it("moveUp moves an item one position toward the start, persists to localStorage", () => {
    const { result } = renderHook(() => useArtifactOrder("sess-1"));
    act(() => result.current.moveUp("b", ["a", "b", "c"]));
    expect(result.current.order).toEqual(["b", "a", "c"]);
    expect(JSON.parse(window.localStorage.getItem(ORDER_KEY("sess-1"))!)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("moveDown moves an item one position toward the end", () => {
    const { result } = renderHook(() => useArtifactOrder("sess-1"));
    act(() => result.current.moveDown("a", ["a", "b", "c"]));
    expect(result.current.order).toEqual(["b", "a", "c"]);
  });

  it("moveUp at index 0 is a no-op", () => {
    const { result } = renderHook(() => useArtifactOrder("sess-1"));
    act(() => result.current.moveUp("a", ["a", "b", "c"]));
    expect(result.current.order).toEqual([]);
    expect(window.localStorage.getItem(ORDER_KEY("sess-1"))).toBeNull();
  });

  it("moveDown at last index is a no-op", () => {
    const { result } = renderHook(() => useArtifactOrder("sess-1"));
    act(() => result.current.moveDown("c", ["a", "b", "c"]));
    expect(result.current.order).toEqual([]);
    expect(window.localStorage.getItem(ORDER_KEY("sess-1"))).toBeNull();
  });

  it("ignores moves for items not in the current list", () => {
    const { result } = renderHook(() => useArtifactOrder("sess-1"));
    act(() => result.current.moveUp("ghost", ["a", "b", "c"]));
    expect(result.current.order).toEqual([]);
  });

  it("returns independent order per sessionId", () => {
    const { result: r1 } = renderHook(() => useArtifactOrder("sess-1"));
    const { result: r2 } = renderHook(() => useArtifactOrder("sess-2"));
    act(() => r1.current.moveUp("b", ["a", "b"]));
    expect(r1.current.order).toEqual(["b", "a"]);
    expect(r2.current.order).toEqual([]);
  });

  it("reads existing order from localStorage on mount", () => {
    window.localStorage.setItem(ORDER_KEY("sess-1"), JSON.stringify(["b", "a"]));
    const { result } = renderHook(() => useArtifactOrder("sess-1"));
    expect(result.current.order).toEqual(["b", "a"]);
  });
});

describe("applyArtifactOrder", () => {
  type Item = { id: string };
  const items = (ids: string[]): Item[] => ids.map((id) => ({ id }));

  it("returns items unchanged when explicit order is empty", () => {
    const list = items(["a", "b", "c"]);
    expect(applyArtifactOrder(list, [])).toBe(list);
  });

  it("returns empty when items is empty", () => {
    expect(applyArtifactOrder([], ["a", "b"])).toEqual([]);
  });

  it("places explicitly-ordered ids first, in the order specified", () => {
    const result = applyArtifactOrder(items(["a", "b", "c", "d"]), ["c", "a"]);
    expect(result.map((i) => i.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("preserves the input order for items not in the explicit list", () => {
    const result = applyArtifactOrder(items(["a", "b", "c", "d"]), ["c"]);
    expect(result.map((i) => i.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("drops stale ids in the explicit order that don't exist in items", () => {
    const result = applyArtifactOrder(items(["a", "b"]), ["ghost", "a", "ghost2"]);
    expect(result.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("deduplicates: an id appearing twice in the order is included only once", () => {
    const result = applyArtifactOrder(items(["a", "b", "c"]), ["a", "a", "b"]);
    expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
