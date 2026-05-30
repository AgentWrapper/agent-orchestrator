"use client";

import { useCallback, useEffect, useRef } from "react";

interface UseResizableOptions {
  /** CSS custom property to drive (set on :root), e.g. "--ao-sidebar-w". */
  cssVar: string;
  /** localStorage key to persist the width. */
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /**
   * Which edge the drag handle sits on relative to the panel it resizes.
   * "right" (sidebar handle) grows with rightward drag; "left" (inspector
   * handle) grows with leftward drag.
   */
  edge: "left" | "right";
}

/**
 * Pointer-driven panel resize. Persists the width to localStorage and applies
 * it via a CSS custom property on :root (so the consuming layout reads it with
 * `width: var(--cssVar, default)`), avoiding any inline `style=` (C-02).
 */
export function useResizable({
  cssVar,
  storageKey,
  defaultWidth,
  min,
  max,
  edge,
}: UseResizableOptions) {
  const widthRef = useRef(defaultWidth);

  const apply = useCallback(
    (next: number) => {
      const clamped = Math.min(max, Math.max(min, next));
      widthRef.current = clamped;
      document.documentElement.style.setProperty(cssVar, `${clamped}px`);
    },
    [cssVar, max, min],
  );

  // Restore persisted width on mount.
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(storageKey));
    apply(Number.isFinite(saved) && saved > 0 ? saved : defaultWidth);
    return () => {
      document.documentElement.style.removeProperty(cssVar);
    };
  }, [apply, cssVar, defaultWidth, storageKey]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      const sign = edge === "right" ? 1 : -1;
      document.body.classList.add("is-resizing-x");

      const onMove = (e: PointerEvent) => {
        apply(startWidth + sign * (e.clientX - startX));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.classList.remove("is-resizing-x");
        window.localStorage.setItem(storageKey, String(widthRef.current));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [apply, edge, storageKey],
  );

  /** Double-click the handle to reset to the default width. */
  const onDoubleClick = useCallback(() => {
    apply(defaultWidth);
    window.localStorage.setItem(storageKey, String(defaultWidth));
  }, [apply, defaultWidth, storageKey]);

  return { onPointerDown, onDoubleClick };
}
