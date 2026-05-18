"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "ao-artifact-rail-width";
const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 240;
const MAX_WIDTH_FRACTION = 0.65; // max 65% of viewport

function readStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed < MIN_WIDTH) return DEFAULT_WIDTH;
    return parsed;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function writeStoredWidth(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(STORAGE_KEY, String(value));
  } catch {
    // localStorage quota, disabled, or unavailable (e.g. Node 24+ without
    // --localstorage-file in test envs) — silent.
  }
}

function clampWidth(width: number): number {
  if (typeof window === "undefined") return Math.max(MIN_WIDTH, width);
  const max = Math.floor(window.innerWidth * MAX_WIDTH_FRACTION);
  return Math.min(Math.max(MIN_WIDTH, width), Math.max(MIN_WIDTH, max));
}

/**
 * Persisted artifact rail width. Returns [width, setWidth].
 * Reads localStorage on mount; writes on every update.
 */
export function useArtifactRailWidth(): readonly [number, (w: number) => void] {
  const [width, setWidthState] = useState<number>(DEFAULT_WIDTH);

  // Read from localStorage on mount (avoids SSR mismatch).
  useEffect(() => {
    setWidthState(clampWidth(readStoredWidth()));
  }, []);

  // Clamp on viewport resize so the rail can't get stuck off-screen.
  useEffect(() => {
    function onResize() {
      setWidthState((current) => {
        const clamped = clampWidth(current);
        if (clamped !== current) {
          writeStoredWidth(clamped);
        }
        return clamped;
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setWidth = useCallback((w: number) => {
    const clamped = clampWidth(w);
    setWidthState(clamped);
    writeStoredWidth(clamped);
  }, []);

  return [width, setWidth] as const;
}

interface SplitterProps {
  /** Current rail width — splitter drags relative to this. */
  width: number;
  /** Callback when drag ends or moves. */
  onWidthChange: (newWidth: number) => void;
}

/**
 * Vertical drag handle between the terminal pane and the artifact rail.
 *
 * Drag right → rail shrinks (terminal grows).
 * Drag left  → rail grows (terminal shrinks).
 *
 * Uses pointer events for cross-input support (mouse + touch + pen).
 * Sets body cursor and disables text selection while dragging.
 */
export function ArtifactRailSplitter({ width, onWidthChange }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const startStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      startStateRef.current = { startX: e.clientX, startWidth: width };
      setDragging(true);

      const onMove = (ev: PointerEvent) => {
        const start = startStateRef.current;
        if (!start) return;
        // dragging the handle right INCREASES e.clientX → rail (on the right side)
        // should SHRINK by that delta. So next width = startWidth - (clientX - startX).
        const delta = ev.clientX - start.startX;
        onWidthChange(start.startWidth - delta);
      };

      const onUp = () => {
        setDragging(false);
        startStateRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [width, onWidthChange],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize artifact rail"
      tabIndex={0}
      className={`group relative w-1 shrink-0 cursor-col-resize bg-[var(--color-border-subtle)] transition-colors hover:bg-[var(--color-accent)] ${
        dragging ? "bg-[var(--color-accent)]" : ""
      }`}
    >
      {/* Wider invisible hit-area so the 1px visual handle is easier to grab.
          The visual handle stays 1px to feel like a clean boundary; the
          invisible padding extends the hit-area to ~8px on each side. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 -left-1 -right-1"
      />
    </div>
  );
}
