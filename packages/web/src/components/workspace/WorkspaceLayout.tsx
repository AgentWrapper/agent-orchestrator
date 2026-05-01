"use client";

import type { DashboardSession } from "@/lib/types";
import type { PaneControls } from "./usePaneSizes";
import { QuickOpen } from "./QuickOpen";
import "./workspace.css";
import { loadSessionFileState, loadFileScrollTop, saveSessionFileState } from "./sessionFileState";
import { type ReactNode, useRef, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";

type DiffScope = "local" | "branch";

interface WorkspaceLayoutProps {
  session: DashboardSession;
  paneControls: PaneControls;
  className?: string;
  children: {
    fileTree: (
      selectedFile: string | null,
      opts: { showChangedOnly: boolean; scope: DiffScope; onFileSelected: (path: string) => void; onBaseRefChange: (ref: string | null) => void },
    ) => ReactNode;
    preview: (selectedFile: string | null, opts: { diffMode: boolean; scope: DiffScope; baseRef: string | null }) => ReactNode;
    terminal: ReactNode;
  };
}

type FileSelectSource = "tree" | "quickopen" | "diff";

interface FileTreeSettings {
  autoCloseOnTreeSelect: boolean;
  autoCloseOnQuickOpen: boolean;
  autoCloseOnDiffSelect: boolean;
}

const FILE_TREE_SETTINGS_KEY = "workspace:file-tree-settings";
const DEFAULT_SETTINGS: FileTreeSettings = {
  autoCloseOnTreeSelect: false,
  autoCloseOnQuickOpen: false,
  autoCloseOnDiffSelect: false,
};

function loadFileTreeSettings(): FileTreeSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(FILE_TREE_SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveFileTreeSettings(settings: FileTreeSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FILE_TREE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

export function WorkspaceLayout({ session, paneControls, className, children }: WorkspaceLayoutProps) {
  const {
    sizes, collapsed, setSizes, toggleCollapsed, isHydrated,
    verticalLayout, setVerticalLayout: _setVerticalLayout,
    verticalSplit, setVerticalSplit,
    previewFontSize, setPreviewFontSize,
  } = paneControls;

  const containerRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const saveScrollTimeoutRef = useRef<number | null>(null);
  const restoredScrollForFileRef = useRef<string | null>(null);
  const searchParams = useSearchParams();
  // Local state, not useSearchParams: updating via router.push triggers an
  // RSC round-trip that delays the new file's fetch by seconds. We mirror
  // into the URL via history.pushState so refresh/share still work.
  const [selectedFile, setSelectedFile] = useState<string | null>(
    () => searchParams.get("file"),
  );
  const prevFileRef = useRef<string | null>(null);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [scope, setScope] = useState<DiffScope>("local");
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [fileTreeSettings, setFileTreeSettings] = useState<FileTreeSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const settingsPopoverRef = useRef<HTMLDivElement>(null);
  const fileSelectSourceRef = useRef<FileSelectSource | null>(null);
  const [fontSizePopoverOpen, setFontSizePopoverOpen] = useState(false);
  const fontSizeBtnRef = useRef<HTMLButtonElement>(null);
  const fontSizePopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFileTreeSettings(loadFileTreeSettings());
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        settingsPopoverRef.current && !settingsPopoverRef.current.contains(target) &&
        settingsBtnRef.current && !settingsBtnRef.current.contains(target)
      ) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen]);

  useEffect(() => {
    if (!fontSizePopoverOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        fontSizePopoverRef.current && !fontSizePopoverRef.current.contains(target) &&
        fontSizeBtnRef.current && !fontSizeBtnRef.current.contains(target)
      ) {
        setFontSizePopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [fontSizePopoverOpen]);

  const updateSetting = useCallback((key: keyof FileTreeSettings, value: boolean) => {
    setFileTreeSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveFileTreeSettings(next);
      return next;
    });
  }, []);

  const lastSessionRef = useRef<string | null>(null);

  // replace vs push: hydration uses replace so session-switch doesn't pile up
  // a redundant history entry on top of the sidebar's own navigation.
  const syncUrl = useCallback((path: string | null, mode: "push" | "replace") => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (path === url.searchParams.get("file")) return;
    if (path) {
      url.searchParams.set("file", path);
    } else {
      url.searchParams.delete("file");
    }
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url.toString());
  }, []);

  useEffect(() => {
    if (lastSessionRef.current === session.id) return;
    lastSessionRef.current = session.id;
    const url = new URL(window.location.href);
    const urlFile = url.searchParams.get("file");
    let next: string | null = null;
    if (urlFile) {
      next = urlFile;
    } else {
      const stored = loadSessionFileState(session.id);
      if (stored?.filePath) {
        next = stored.filePath;
      } else {
        const hint = session.metadata["pendingPreviewFile"];
        if (typeof hint === "string" && hint.length > 0) next = hint;
      }
    }
    setSelectedFile(next);
    syncUrl(next, "replace");
  }, [session.id, session.metadata, syncUrl]);

  useEffect(() => {
    const onPopState = () => {
      const url = new URL(window.location.href);
      setSelectedFile(url.searchParams.get("file"));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const diffMode = showChangedOnly && !!selectedFile;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        setQuickOpenVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const prev = prevFileRef.current;
    if (selectedFile && selectedFile !== prev && !collapsed[0]) {
      const source = fileSelectSourceRef.current;
      fileSelectSourceRef.current = null;
      const shouldClose =
        (source === "tree" && fileTreeSettings.autoCloseOnTreeSelect) ||
        (source === "quickopen" && fileTreeSettings.autoCloseOnQuickOpen) ||
        (source === "diff" && fileTreeSettings.autoCloseOnDiffSelect);
      if (shouldClose) toggleCollapsed(0);
    }
    prevFileRef.current = selectedFile;
  }, [selectedFile, fileTreeSettings, collapsed, toggleCollapsed]);

  useEffect(() => {
    if (!selectedFile) return;
    const targetScroll = loadFileScrollTop(session.id, selectedFile);
    if (restoredScrollForFileRef.current === `${session.id}:${selectedFile}`) return;
    restoredScrollForFileRef.current = `${session.id}:${selectedFile}`;
    if (targetScroll === 0) return;

    let attempts = 0;
    const maxAttempts = 50;
    const intervalId = window.setInterval(() => {
      attempts++;
      const el = previewScrollRef.current;
      if (!el) return;
      if (el.scrollHeight > el.clientHeight) {
        el.scrollTop = targetScroll;
        window.clearInterval(intervalId);
      } else if (attempts >= maxAttempts) {
        window.clearInterval(intervalId);
      }
    }, 100);
    return () => window.clearInterval(intervalId);
  }, [session.id, selectedFile]);

  useEffect(() => {
    return () => {
      if (saveScrollTimeoutRef.current !== null) {
        window.clearTimeout(saveScrollTimeoutRef.current);
      }
    };
  }, []);

  const handlePreviewScroll = useCallback(() => {
    if (!selectedFile || !previewScrollRef.current) return;
    if (saveScrollTimeoutRef.current !== null) {
      window.clearTimeout(saveScrollTimeoutRef.current);
    }
    saveScrollTimeoutRef.current = window.setTimeout(() => {
      if (!previewScrollRef.current || !selectedFile) return;
      saveSessionFileState(session.id, {
        filePath: selectedFile,
        scrollTop: previewScrollRef.current.scrollTop,
        updatedAt: Date.now(),
      });
    }, 200);
  }, [session.id, selectedFile]);

  const handleDragStart = useCallback((leftIdx: number, rightIdx: number, direction: "horizontal" | "vertical", startX: number, startY: number) => {
    const isHorizontal = direction === "horizontal";
    const startPos = isHorizontal ? startX : startY;
    const containerSize = isHorizontal
      ? (containerRef.current?.clientWidth || 1)
      : (containerRef.current?.clientHeight || 1);

    // Vertical layout has two separators: a column split between files/preview in the top row
    // (direction=horizontal, uses verticalSplit-relative normalization) and a row split
    // between top row and terminal (direction=vertical, uses verticalSplit array).
    const isVerticalRowSplit = verticalLayout && direction === "vertical";
    const isVerticalColSplit = verticalLayout && direction === "horizontal";
    const startSizes = isVerticalRowSplit ? [...verticalSplit] : [...sizes];
    const minsArr = isVerticalRowSplit ? [15, 15] : [8, 15, 15];
    const idx0 = leftIdx;
    const idx1 = rightIdx;
    const normFactor = isVerticalColSplit ? (startSizes[0] + startSizes[1]) : 100;

    function applyDelta(currentPos: number) {
      const deltaPct = ((currentPos - startPos) / containerSize) * normFactor;
      const newSizes = [...startSizes];
      newSizes[idx0] = Math.max(minsArr[idx0], startSizes[idx0] + deltaPct);
      newSizes[idx1] = Math.max(minsArr[idx1], startSizes[idx1] - deltaPct);
      if (isVerticalRowSplit) {
        setVerticalSplit(newSizes as [number, number]);
      } else {
        setSizes(newSizes);
      }
    }

    function onMouseMove(e: MouseEvent) { applyDelta(isHorizontal ? e.clientX : e.clientY); }
    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      applyDelta(isHorizontal ? e.touches[0].clientX : e.touches[0].clientY);
    }
    function cleanup() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", cleanup);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", cleanup);
      document.removeEventListener("touchcancel", cleanup);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", cleanup);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", cleanup);
    document.addEventListener("touchcancel", cleanup);
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, [sizes, setSizes, verticalLayout, verticalSplit, setVerticalSplit]);

  const onSeparatorMouse = useCallback((leftIdx: number, rightIdx: number, dir: "horizontal" | "vertical", e: React.MouseEvent) => {
    e.preventDefault();
    handleDragStart(leftIdx, rightIdx, dir, e.clientX, e.clientY);
  }, [handleDragStart]);

  const onSeparatorTouch = useCallback((leftIdx: number, rightIdx: number, dir: "horizontal" | "vertical", e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    handleDragStart(leftIdx, rightIdx, dir, e.touches[0].clientX, e.touches[0].clientY);
  }, [handleDragStart]);

  const filesVisible = !collapsed[0];
  const previewVisible = !collapsed[1];
  const terminalVisible = !collapsed[2];

  function buildTemplate(panes: { visible: boolean; size: number }[]): string {
    const parts: string[] = [];
    const expandedTotal = panes.reduce((sum, p) => sum + (p.visible ? p.size : 0), 0) || 1;
    let first = true;
    for (const pane of panes) {
      if (!pane.visible) continue;
      if (!first) parts.push("4px");
      const normalized = (pane.size / expandedTotal) * 100;
      // minmax(0, Nfr) allows grid tracks to shrink below their content min-width,
      // preventing panes (esp. the terminal with intrinsic xterm width) from
      // overflowing when the user resizes or opens the sidebar.
      parts.push(`minmax(0, ${normalized}fr)`);
      first = false;
    }
    return parts.join(" ") || "1fr";
  }

  function getGridTemplate(): string {
    // Horizontal render order: terminal, preview, files.
    return buildTemplate([
      { visible: terminalVisible, size: sizes[2] },
      { visible: previewVisible, size: sizes[1] },
      { visible: filesVisible, size: sizes[0] },
    ]);
  }

  function getVerticalRowTemplate(): string {
    const topVisible = filesVisible || previewVisible;
    return buildTemplate([
      { visible: topVisible, size: verticalSplit[0] },
      { visible: terminalVisible, size: verticalSplit[1] },
    ]);
  }

  function getVerticalColumnTemplate(): string {
    // Vertical top row order: preview, files.
    return buildTemplate([
      { visible: previewVisible, size: sizes[1] },
      { visible: filesVisible, size: sizes[0] },
    ]);
  }

  // Read collapsed[] via a ref so ensurePreviewVisible keeps a stable identity.
  // If we put `collapsed` in useCallback deps, toggling the preview pane off
  // would re-create ensurePreviewVisible, which would re-fire the auto-open
  // effect below and immediately reopen the pane (flicker). With a ref, the
  // callback is stable and the effect only runs on real input changes.
  const collapsedRef = useRef(collapsed);
  useEffect(() => { collapsedRef.current = collapsed; }, [collapsed]);

  const ensurePreviewVisible = useCallback(() => {
    if (collapsedRef.current[1]) toggleCollapsed(1);
  }, [toggleCollapsed]);

  const onBaseRefChange = useCallback((ref: string | null) => {
    setBaseRef(ref);
  }, []);

  const onTreeFileSelected = useCallback((path: string) => {
    fileSelectSourceRef.current = showChangedOnly ? "diff" : "tree";
    setSelectedFile(path);
    syncUrl(path, "push");
    ensurePreviewVisible();
  }, [showChangedOnly, ensurePreviewVisible, syncUrl]);

  const onQuickOpenFileSelected = useCallback((path: string) => {
    fileSelectSourceRef.current = "quickopen";
    setSelectedFile(path);
    syncUrl(path, "push");
    ensurePreviewVisible();
  }, [ensurePreviewVisible, syncUrl]);

  // Auto-open preview on the rising edge of diffMode. Gating on the rising
  // edge (not every render) prevents reopening the pane the user just closed
  // while Δ is still on.
  const prevDiffModeRef = useRef(diffMode);
  useEffect(() => {
    const wasDiffMode = prevDiffModeRef.current;
    prevDiffModeRef.current = diffMode;
    if (!wasDiffMode && diffMode && selectedFile) ensurePreviewVisible();
  }, [diffMode, selectedFile, ensurePreviewVisible]);

  const rootClass = `flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--color-bg-base)]${className ? ` ${className}` : ""}`;

  if (!isHydrated) {
    return (
      <div className={rootClass}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "var(--color-text-secondary)", fontSize: "14px" }}>Loading...</div>
        </div>
      </div>
    );
  }

  const fileTreePane = filesVisible && (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, minWidth: 0 }}>
      <div className="workspace-pane-header">
        <span>FILES</span>
        <div style={{ display: "flex", alignItems: "center", gap: "2px", marginLeft: "auto", position: "relative" }}>
          <button
            type="button"
            ref={settingsBtnRef}
            onClick={() => setSettingsOpen((v) => !v)}
            title="File tree settings"
            className={`workspace-pane-header-btn ${settingsOpen ? "workspace-pane-header-btn--active" : ""}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </button>
          {settingsOpen && (
            <div ref={settingsPopoverRef} className="workspace-file-tree-settings-popover">
              <div className="workspace-file-tree-settings-title">Auto-close file tree</div>
              {([
                { key: "autoCloseOnTreeSelect" as const, label: "On file tree select" },
                { key: "autoCloseOnQuickOpen" as const, label: "On quick open select" },
                { key: "autoCloseOnDiffSelect" as const, label: "On git diff select" },
              ]).map(({ key, label }) => (
                <label key={key} className="workspace-file-tree-settings-row">
                  <input type="checkbox" checked={fileTreeSettings[key]} onChange={(e) => updateSetting(key, e.target.checked)} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          )}
          {showChangedOnly && (
            <div className="workspace-scope-pill">
              <button
                type="button"
                onClick={() => setScope("local")}
                className={`workspace-scope-pill-btn${scope === "local" ? " workspace-scope-pill-btn--active" : ""}`}
                title="Show local uncommitted changes only"
              >
                Local
              </button>
              <button
                type="button"
                onClick={() => setScope("branch")}
                className={`workspace-scope-pill-btn${scope === "branch" ? " workspace-scope-pill-btn--active" : ""}`}
                title="Show all changes this branch introduces"
              >
                Branch
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowChangedOnly((v) => !v)}
            title={showChangedOnly ? "Show all files" : "Show changed files only"}
            className={`workspace-pane-header-btn ${showChangedOnly ? "workspace-pane-header-btn--active" : ""}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
              <text x="12" y="17" textAnchor="middle" fontSize="15" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif">Δ</text>
            </svg>
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {children.fileTree(selectedFile, { showChangedOnly, scope, onFileSelected: onTreeFileSelected, onBaseRefChange })}
      </div>
    </div>
  );

  const previewFileName = selectedFile ? selectedFile.split("/").pop() : null;

  const previewPane = previewVisible && (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, minWidth: 0 }}>
      <div className="workspace-pane-header">
        <span>PREVIEW</span>
        {previewFileName && (
          <span style={{ marginLeft: "8px", fontWeight: 400, fontSize: "11px", color: "var(--color-text-secondary)", letterSpacing: "normal", textTransform: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {previewFileName}
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "2px", marginLeft: "auto", position: "relative" }}>
          <button
            type="button"
            ref={fontSizeBtnRef}
            onClick={() => setFontSizePopoverOpen((v) => !v)}
            title="Preview text size"
            className={`workspace-pane-header-btn ${fontSizePopoverOpen ? "workspace-pane-header-btn--active" : ""}`}
          >
            <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em" }}>Aa</span>
          </button>
          {fontSizePopoverOpen && (
            <div ref={fontSizePopoverRef} className="workspace-file-tree-settings-popover">
              <div className="workspace-file-tree-settings-title">Preview text size</div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 0" }}>
                <input
                  type="range"
                  min="10"
                  max="18"
                  step="1"
                  value={previewFontSize}
                  onChange={(e) => setPreviewFontSize(parseInt(e.target.value, 10))}
                  className="h-1 w-32 cursor-pointer accent-[var(--color-accent)]"
                />
                <span style={{ minWidth: "2ch", textAlign: "center", fontFamily: "ui-monospace", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)" }}>
                  {previewFontSize}px
                </span>
              </div>
            </div>
          )}
          <button
            onClick={() => setQuickOpenVisible(true)}
            title="Search files (Ctrl+P)"
            className="workspace-pane-header-btn"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>
      </div>
      <div
        ref={previewScrollRef}
        onScroll={handlePreviewScroll}
        className="workspace-preview-scroll"
        style={{ flex: 1, overflow: "auto", minHeight: 0, "--preview-font-size": `${previewFontSize}px` } as React.CSSProperties}
      >
        {children.preview(selectedFile, { diffMode, scope, baseRef })}
      </div>
    </div>
  );

  const terminalPane = terminalVisible && (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, minWidth: 0 }}>
      <div className="workspace-terminal-content">{children.terminal}</div>
    </div>
  );

  // Only mount QuickOpen while visible — keeps its useFileTree poll from
  // running (and double-polling alongside FileTree) for the entire session.
  const quickOpen = quickOpenVisible ? (
    <QuickOpen
      sessionId={session.id}
      open={quickOpenVisible}
      onClose={() => setQuickOpenVisible(false)}
      onFileSelected={onQuickOpenFileSelected}
    />
  ) : null;

  if (verticalLayout) {
    const topVisible = filesVisible || previewVisible;
    return (
      <div className={rootClass}>
        <div
          ref={containerRef}
          style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr", gridTemplateRows: getVerticalRowTemplate(), overflow: "hidden", minHeight: 0 }}
        >
          {topVisible && (
            <div style={{ display: "grid", gridTemplateColumns: getVerticalColumnTemplate(), overflow: "hidden", minHeight: 0 }}>
              {previewPane}
              {filesVisible && previewVisible && (
                <div className="workspace-separator" onMouseDown={(e) => onSeparatorMouse(1, 0, "horizontal", e)} onTouchStart={(e) => onSeparatorTouch(1, 0, "horizontal", e)} />
              )}
              {fileTreePane}
            </div>
          )}
          {topVisible && terminalVisible && (
            <div className="workspace-separator workspace-separator--horizontal" onMouseDown={(e) => onSeparatorMouse(0, 1, "vertical", e)} onTouchStart={(e) => onSeparatorTouch(0, 1, "vertical", e)} />
          )}
          {terminalPane}
        </div>
        {quickOpen}
      </div>
    );
  }

  // Horizontal layout: terminal | preview | files. One separator sits at each
  // boundary between two visible panes. Each separator carries the sizes[]
  // indices of its left/right pane so handleDragStart resizes the right pair.
  //
  // Crucially: each separator is rendered between its two panes, never before
  // the first visible pane. Otherwise the grid treats the separator as the
  // first pane's track and pushes the pane into the 4px gap, collapsing it.
  const terminalToNextSep: readonly [number, number] | null =
    terminalVisible && previewVisible ? [2, 1] as const
    : terminalVisible && filesVisible ? [2, 0] as const
    : null;
  const previewToFilesSep: readonly [number, number] | null =
    previewVisible && filesVisible ? [1, 0] as const
    : null;

  return (
    <div className={rootClass}>
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        <div
          ref={containerRef}
          style={{ flex: 1, display: "grid", gridTemplateColumns: getGridTemplate(), overflow: "hidden", minHeight: 0 }}
        >
          {terminalPane}
          {terminalToNextSep && (
            <div className="workspace-separator" onMouseDown={(e) => onSeparatorMouse(terminalToNextSep[0], terminalToNextSep[1], "horizontal", e)} onTouchStart={(e) => onSeparatorTouch(terminalToNextSep[0], terminalToNextSep[1], "horizontal", e)} />
          )}
          {previewPane}
          {previewToFilesSep && (
            <div className="workspace-separator" onMouseDown={(e) => onSeparatorMouse(previewToFilesSep[0], previewToFilesSep[1], "horizontal", e)} onTouchStart={(e) => onSeparatorTouch(previewToFilesSep[0], previewToFilesSep[1], "horizontal", e)} />
          )}
          {fileTreePane}
        </div>
      </div>
      {quickOpen}
    </div>
  );
}
