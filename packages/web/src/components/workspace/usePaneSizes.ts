"use client";

import { useState, useCallback, useEffect } from "react";

const STORAGE_KEY_PREFIX = "ao:workspace:panes:";

interface PaneSizesState {
  sizes: number[];
  collapsed: boolean[];
  verticalLayout?: boolean;
  verticalSplit?: [number, number];
  previewFontSize?: number;
}

export type PaneControls = ReturnType<typeof usePaneSizes>;

export function usePaneSizes(sessionId: string, defaultSizes: number[]) {
  // First visit: only terminal is visible. Files + Preview start collapsed so
  // the session feels uncluttered; user opens them via the topbar buttons or
  // a file-opening shortcut (⌘P). State is persisted per-session in
  // localStorage, so the choice sticks across reloads.
  const [state, setState] = useState<PaneSizesState>({
    sizes: defaultSizes,
    collapsed: defaultSizes.map((_, i) => i < 2),
  });
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const storageKey = STORAGE_KEY_PREFIX + sessionId;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as PaneSizesState;
        setState(parsed);
      }
    } catch (e) {
      console.error("Failed to load pane sizes:", e);
    }
    setIsHydrated(true);
  }, [sessionId]);

  const setSizes = useCallback(
    (newSizes: number[]) => {
      setState((prev) => {
        const updated = { ...prev, sizes: newSizes };
        try {
          localStorage.setItem(STORAGE_KEY_PREFIX + sessionId, JSON.stringify(updated));
        } catch {
          // ignore
        }
        return updated;
      });
    },
    [sessionId]
  );

  const toggleCollapsed = useCallback(
    (index: number) => {
      setState((prev) => {
        const updated = {
          ...prev,
          collapsed: prev.collapsed.map((c, i) => (i === index ? !c : c)),
        };
        try {
          localStorage.setItem(STORAGE_KEY_PREFIX + sessionId, JSON.stringify(updated));
        } catch {
          // ignore
        }
        return updated;
      });
    },
    [sessionId]
  );

  const setVerticalLayout = useCallback(
    (vertical: boolean) => {
      setState((prev) => {
        const updated = { ...prev, verticalLayout: vertical };
        try {
          localStorage.setItem(STORAGE_KEY_PREFIX + sessionId, JSON.stringify(updated));
        } catch {
          // ignore
        }
        return updated;
      });
    },
    [sessionId]
  );

  const setVerticalSplit = useCallback(
    (split: [number, number]) => {
      setState((prev) => {
        const updated = { ...prev, verticalSplit: split };
        try {
          localStorage.setItem(STORAGE_KEY_PREFIX + sessionId, JSON.stringify(updated));
        } catch {
          // ignore
        }
        return updated;
      });
    },
    [sessionId]
  );

  const setPreviewFontSize = useCallback(
    (fontSize: number) => {
      setState((prev) => {
        const updated = { ...prev, previewFontSize: fontSize };
        try {
          localStorage.setItem(STORAGE_KEY_PREFIX + sessionId, JSON.stringify(updated));
        } catch {
          // ignore
        }
        return updated;
      });
    },
    [sessionId]
  );

  return {
    sizes: state.sizes,
    collapsed: state.collapsed,
    verticalLayout: state.verticalLayout ?? false,
    verticalSplit: state.verticalSplit ?? ([60, 40] as [number, number]),
    previewFontSize: state.previewFontSize ?? 13,
    setSizes,
    toggleCollapsed,
    setVerticalLayout,
    setVerticalSplit,
    setPreviewFontSize,
    isHydrated,
  };
}
