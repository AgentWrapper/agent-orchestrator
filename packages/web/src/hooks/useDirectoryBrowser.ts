"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { getParentBrowsePath } from "@/components/AddProjectModal.parts";

export interface BrowseEntry {
  name: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  hasLocalConfig: boolean;
  modifiedAt?: number;
}

export interface BrowseCurrentDirectory {
  isGitRepo: boolean;
  hasLocalConfig: boolean;
}

export interface BrowseRoot {
  label: string;
  path: string;
}

export interface UseDirectoryBrowser {
  browsePath: string;
  selectedBrowsePath: string;
  setSelectedBrowsePath: (path: string) => void;
  directoryEntries: BrowseEntry[];
  currentDirectory: BrowseCurrentDirectory | null;
  roots: BrowseRoot[];
  selectedRootPath: string;
  locationInput: string;
  setLocationInput: (value: string) => void;
  loading: boolean;
  error: string | null;
  parentPath: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  browse: (
    path: string,
    options?: { mode?: "push" | "replace"; selectedPath?: string; historyIndex?: number },
  ) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  refresh: () => void;
  reset: () => void;
}

interface BrowseResponseBody {
  error?: string;
  entries?: BrowseEntry[];
  current?: BrowseCurrentDirectory;
  roots?: BrowseRoot[];
}

const INITIAL_PATH = "~";

export function useDirectoryBrowser(): UseDirectoryBrowser {
  const [browsePath, setBrowsePath] = useState(INITIAL_PATH);
  const [selectedBrowsePath, setSelectedBrowsePath] = useState(INITIAL_PATH);
  const [browseHistory, setBrowseHistory] = useState<string[]>([INITIAL_PATH]);
  const [browseHistoryIndex, setBrowseHistoryIndex] = useState(0);
  const browseHistoryRef = useRef<string[]>([INITIAL_PATH]);
  const browseHistoryIndexRef = useRef(0);
  const browseRequestIdRef = useRef(0);
  const [browseEntries, setBrowseEntries] = useState<BrowseEntry[]>([]);
  const [currentDirectory, setCurrentDirectory] = useState<BrowseCurrentDirectory | null>(null);
  const [roots, setRoots] = useState<BrowseRoot[]>([]);
  const [locationInput, setLocationInput] = useState(INITIAL_PATH);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncHistory = useCallback((nextHistory: string[], nextIndex: number) => {
    browseHistoryRef.current = nextHistory;
    browseHistoryIndexRef.current = nextIndex;
    setBrowseHistory(nextHistory);
    setBrowseHistoryIndex(nextIndex);
  }, []);

  const clearBrowseResults = useCallback((path: string, selectedPath?: string) => {
    setBrowseEntries([]);
    setCurrentDirectory(null);
    setRoots([]);
    // Navigating to `path` (descend, breadcrumb, drive switch) must not auto-select it —
    // a selection should only ever come from explicit user intent. Callers that DO want
    // to seed a selection (refresh, reset, typed-path Enter) pass `selectedPath` explicitly.
    setSelectedBrowsePath(selectedPath ?? "");
  }, []);

  const browse = useCallback(
    async (
      path: string,
      options?: { mode?: "push" | "replace"; selectedPath?: string; historyIndex?: number },
    ) => {
      const requestId = browseRequestIdRef.current + 1;
      browseRequestIdRef.current = requestId;
      const targetHistoryIndex = options?.historyIndex ?? browseHistoryIndexRef.current;
      setLocationInput(path);
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/filesystem/browse?path=${encodeURIComponent(path)}`,
        ).catch(() => null);
        if (requestId !== browseRequestIdRef.current) return;
        if (!response) {
          clearBrowseResults(path, options?.selectedPath);
          setError("Failed to browse directories.");
          return;
        }

        const body = (await response.json().catch(() => null)) as BrowseResponseBody | null;
        if (requestId !== browseRequestIdRef.current) return;
        if (!response.ok) {
          clearBrowseResults(path, options?.selectedPath);
          setError(body?.error ?? "Failed to browse directories.");
          return;
        }

        const mode = options?.mode ?? "push";
        setBrowsePath(path);
        setLocationInput(path);
        setSelectedBrowsePath(options?.selectedPath ?? "");
        setBrowseEntries(body?.entries ?? []);
        setCurrentDirectory(body?.current ?? null);
        setRoots(body?.roots ?? []);

        if (mode === "push") {
          const nextHistory = browseHistoryRef.current.slice(0, targetHistoryIndex + 1);
          if (nextHistory[nextHistory.length - 1] !== path) nextHistory.push(path);
          syncHistory(nextHistory, nextHistory.length - 1);
        } else {
          const nextHistory = [...browseHistoryRef.current];
          nextHistory[targetHistoryIndex] = path;
          syncHistory(nextHistory, targetHistoryIndex);
        }
      } catch {
        if (requestId !== browseRequestIdRef.current) return;
        clearBrowseResults(path, options?.selectedPath);
        setError("Failed to browse directories.");
      } finally {
        if (requestId === browseRequestIdRef.current) setLoading(false);
      }
    },
    [clearBrowseResults, syncHistory],
  );

  const navigateHistory = useCallback(
    (nextIndex: number) => {
      const history = browseHistoryRef.current;
      if (nextIndex < 0 || nextIndex >= history.length) return;
      browseHistoryIndexRef.current = nextIndex;
      setBrowseHistoryIndex(nextIndex);
      void browse(history[nextIndex] ?? INITIAL_PATH, { mode: "replace", historyIndex: nextIndex });
    },
    [browse],
  );

  const directoryEntries = useMemo(
    () => browseEntries.filter((entry) => entry.isDirectory),
    [browseEntries],
  );
  const parentPath = getParentBrowsePath(browsePath);
  const selectedRootPath = roots.find((root) => browsePath.startsWith(root.path))?.path ?? "";
  const canGoBack = browseHistoryIndex > 0;
  const canGoForward = browseHistoryIndex < browseHistory.length - 1;

  const goBack = useCallback(() => {
    navigateHistory(browseHistoryIndexRef.current - 1);
  }, [navigateHistory]);

  const goForward = useCallback(() => {
    navigateHistory(browseHistoryIndexRef.current + 1);
  }, [navigateHistory]);

  const goUp = useCallback(() => {
    if (!parentPath) return;
    void browse(parentPath);
  }, [browse, parentPath]);

  const refresh = useCallback(() => {
    void browse(browsePath, { mode: "replace", selectedPath: selectedBrowsePath });
  }, [browse, browsePath, selectedBrowsePath]);

  const reset = useCallback(() => {
    setError(null);
    syncHistory([INITIAL_PATH], 0);
    setBrowsePath(INITIAL_PATH);
    setLocationInput(INITIAL_PATH);
    setSelectedBrowsePath(INITIAL_PATH);
    setBrowseEntries([]);
    setCurrentDirectory(null);
    setRoots([]);
    void browse(INITIAL_PATH, { mode: "replace", selectedPath: INITIAL_PATH, historyIndex: 0 });
  }, [browse, syncHistory]);

  return {
    browsePath,
    selectedBrowsePath,
    setSelectedBrowsePath,
    directoryEntries,
    currentDirectory,
    roots,
    selectedRootPath,
    locationInput,
    setLocationInput,
    loading,
    error,
    parentPath,
    canGoBack,
    canGoForward,
    browse,
    goBack,
    goForward,
    goUp,
    refresh,
    reset,
  };
}
