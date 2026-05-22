"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  joinBrowsePath,
  RefreshIcon,
} from "@/components/AddProjectModal.parts";
import type { UseDirectoryBrowser } from "@/hooks/useDirectoryBrowser";

interface DirectoryBrowserProps {
  browser: UseDirectoryBrowser;
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export function DirectoryBrowser({ browser }: DirectoryBrowserProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const selectedIndex = useMemo(
    () =>
      browser.directoryEntries.findIndex(
        (entry) => joinBrowsePath(browser.browsePath, entry.name) === browser.selectedBrowsePath,
      ),
    [browser.browsePath, browser.directoryEntries, browser.selectedBrowsePath],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isInsideBrowser =
        target instanceof Node &&
        (toolbarRef.current?.contains(target) || contentRef.current?.contains(target));
      if (!isInsideBrowser) return;
      if (isTextEditingTarget(event.target)) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (browser.directoryEntries.length === 0) return;
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          selectedIndex === -1
            ? offset > 0
              ? 0
              : browser.directoryEntries.length - 1
            : Math.min(Math.max(selectedIndex + offset, 0), browser.directoryEntries.length - 1);
        const nextEntry = browser.directoryEntries[nextIndex];
        if (nextEntry) browser.setSelectedBrowsePath(joinBrowsePath(browser.browsePath, nextEntry.name));
        return;
      }

      if (
        event.key === "Enter" &&
        selectedIndex >= 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        void browser.browse(browser.selectedBrowsePath);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [browser, selectedIndex]);

  return (
    <>
      <div ref={toolbarRef} className="add-project-modal__toolbar">
        <div className="add-project-modal__toolbarcluster">
          <button
            type="button"
            onClick={browser.goBack}
            disabled={!browser.canGoBack}
            className="add-project-modal__toolbtn"
            aria-label="Go back"
          >
            <ChevronLeftIcon />
          </button>
          <button
            type="button"
            onClick={browser.goForward}
            disabled={!browser.canGoForward}
            className="add-project-modal__toolbtn"
            aria-label="Go forward"
          >
            <ChevronRightIcon />
          </button>
          <button
            type="button"
            onClick={browser.goUp}
            disabled={!browser.parentPath}
            className="add-project-modal__toolbtn"
            aria-label="Go up"
          >
            <ArrowUpIcon />
          </button>
          <button type="button" onClick={browser.refresh} className="add-project-modal__toolbtn" aria-label="Refresh">
            <RefreshIcon />
          </button>
          {browser.roots.length > 0 ? (
            <select
              aria-label="Drive"
              value={browser.selectedRootPath}
              onChange={(event) => {
                const nextPath = event.target.value;
                if (nextPath) void browser.browse(nextPath, { selectedPath: nextPath });
              }}
              className="add-project-modal__drive-select"
            >
              <option value="">Drive</option>
              {browser.roots.map((root) => (
                <option key={root.path} value={root.path}>
                  {root.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <input
          aria-label="Folder path"
          value={browser.locationInput}
          onChange={(event) => browser.setLocationInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const nextPath = browser.locationInput.trim() || "~";
            void browser.browse(nextPath, { selectedPath: nextPath });
          }}
          className="add-project-modal__location"
        />
      </div>

      <div ref={contentRef} className="add-project-modal__content">
        <div className="add-project-browser">
          <div className="add-project-browser__current">
            <div className="add-project-browser__current-label">Current folder</div>
            <div className="add-project-browser__current-path">{browser.browsePath}</div>
          </div>
          {browser.error ? (
            <div className="add-project-browser__state add-project-browser__state--error">
              <p className="add-project-browser__state-title">Directory browser unavailable</p>
              <p className="add-project-browser__state-copy">{browser.error}</p>
            </div>
          ) : browser.loading ? (
            <div className="add-project-browser__state">
              <p className="add-project-browser__state-title">Loading folders</p>
              <p className="add-project-browser__state-copy">Fetching directories for this location.</p>
            </div>
          ) : browser.directoryEntries.length === 0 ? (
            <div className="add-project-browser__state">
              <p className="add-project-browser__state-title">No visible folders here</p>
              <p className="add-project-browser__state-copy">Try navigating up or picking a different location.</p>
            </div>
          ) : (
            <div className="add-project-browser__rows">
              {browser.parentPath ? (
                <button
                  type="button"
                  onClick={browser.goUp}
                  className="add-project-browser__row add-project-browser__row--parent"
                >
                  ..
                </button>
              ) : null}
              {browser.directoryEntries.map((entry) => {
                const nextPath = joinBrowsePath(browser.browsePath, entry.name);
                return (
                  <button
                    key={nextPath}
                    type="button"
                    onClick={() => browser.setSelectedBrowsePath(nextPath)}
                    onDoubleClick={() => void browser.browse(nextPath)}
                    className={`add-project-browser__row${browser.selectedBrowsePath === nextPath ? " is-selected" : ""}`}
                  >
                    {entry.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
