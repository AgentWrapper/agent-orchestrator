"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  getBreadcrumbs,
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
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function isFolderRowTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.classList.contains("add-project-browser__row");
}

// A button/link handles Enter natively (breadcrumbs, toolbar buttons). Enter-to-descend
// must skip those so it does not double-fire alongside the element's own activation.
function isActivatableElement(target: EventTarget | null): boolean {
  return target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement;
}

export function DirectoryBrowser({ browser }: DirectoryBrowserProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const typeaheadBufferRef = useRef("");
  const typeaheadLastTsRef = useRef(0);
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
      if (!(target instanceof Node)) return;
      if (isTextEditingTarget(target)) return;
      // In scope when the event comes from inside the browser panes OR from an
      // ancestor that contains them (the modal dialog focused on open, document.body).
      // The plain ancestor `.contains` checks fail for that case because the dialog
      // is an ancestor of the panes, not a descendant.
      const content = contentRef.current;
      const inScope =
        (content?.contains(target) ?? false) ||
        (toolbarRef.current?.contains(target) ?? false) ||
        (content !== null && target.contains(content));
      if (!inScope) return;

      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now();
        if (now - typeaheadLastTsRef.current > 600) typeaheadBufferRef.current = "";
        typeaheadLastTsRef.current = now;
        typeaheadBufferRef.current += event.key.toLowerCase();

        const matchedEntry = browser.directoryEntries.find((entry) =>
          entry.name.toLowerCase().startsWith(typeaheadBufferRef.current),
        );
        if (matchedEntry) {
          event.preventDefault();
          browser.setSelectedBrowsePath(joinBrowsePath(browser.browsePath, matchedEntry.name));
        }
        return;
      }

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
        if (nextEntry)
          browser.setSelectedBrowsePath(joinBrowsePath(browser.browsePath, nextEntry.name));
        return;
      }

      if (
        event.key === "Enter" &&
        selectedIndex >= 0 &&
        (isFolderRowTarget(target) || !isActivatableElement(target)) &&
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

  const breadcrumbs = getBreadcrumbs(browser.browsePath);
  const currentName = breadcrumbs[breadcrumbs.length - 1]?.label ?? browser.browsePath;
  const showCurrentFolder = browser.browsePath !== "~" && browser.currentDirectory !== null;
  const currentSelected = browser.selectedBrowsePath === browser.browsePath;

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
          <button
            type="button"
            onClick={browser.refresh}
            className="add-project-modal__toolbtn"
            aria-label="Refresh"
          >
            <RefreshIcon />
          </button>
          {browser.roots.length > 0 ? (
            <select
              aria-label="Location"
              // When on home, no drive root matches → the bare select shows "Home" as the
              // current value. On a drive, selectedRootPath is the drive; picking "Home"
              // (value="~") routes back to ~.
              value={browser.browsePath === "~" ? "~" : browser.selectedRootPath}
              onChange={(event) => {
                const nextPath = event.target.value;
                if (!nextPath) return;
                if (nextPath === "~") void browser.browse("~");
                else void browser.browse(nextPath);
              }}
              className="add-project-modal__drive-select"
            >
              <option value="~">Home</option>
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

      <div className="add-project-modal__content">
        <div ref={contentRef} className="add-project-browser">
          <div className="add-project-browser__current">
            <div className="add-project-browser__current-label">Current folder</div>
            <div className="add-project-browser__breadcrumb">
              {breadcrumbs.map((crumb) => (
                <button
                  key={crumb.path}
                  type="button"
                  className="add-project-browser__crumb"
                  onClick={() => void browser.browse(crumb.path)}
                >
                  {crumb.label}
                </button>
              ))}
            </div>
          </div>
          {browser.error ? (
            <div className="add-project-browser__state add-project-browser__state--error">
              <p className="add-project-browser__state-title">Directory browser unavailable</p>
              <p className="add-project-browser__state-copy">{browser.error}</p>
            </div>
          ) : browser.loading ? (
            <div className="add-project-browser__state">
              <p className="add-project-browser__state-title">Loading folders</p>
              <p className="add-project-browser__state-copy">
                Fetching directories for this location.
              </p>
            </div>
          ) : (
            <div className="add-project-browser__rows">
              {showCurrentFolder ? (
                <button
                  type="button"
                  aria-label={
                    browser.currentDirectory?.isGitRepo
                      ? `${currentName}, current folder, Git repository`
                      : `${currentName}, current folder`
                  }
                  onClick={() => browser.setSelectedBrowsePath(browser.browsePath)}
                  className={`add-project-browser__row add-project-browser__row--current${currentSelected ? " is-selected" : ""}`}
                >
                  <FolderIcon className="add-project-browser__row-icon" />
                  <span className="add-project-browser__row-name">{currentName}</span>
                  <span className="add-project-browser__row-tag">this folder</span>
                  {browser.currentDirectory?.isGitRepo ? (
                    <span className="add-project-browser__badge" aria-hidden="true">
                      git
                    </span>
                  ) : null}
                </button>
              ) : null}
              {browser.parentPath ? (
                <button
                  type="button"
                  onClick={browser.goUp}
                  className="add-project-browser__row add-project-browser__row--parent"
                >
                  ..
                </button>
              ) : null}
              {browser.directoryEntries.length === 0 ? (
                <p className="add-project-browser__empty-row">No subfolders in this location.</p>
              ) : (
                browser.directoryEntries.map((entry) => {
                  const nextPath = joinBrowsePath(browser.browsePath, entry.name);
                  return (
                    <button
                      key={nextPath}
                      type="button"
                      aria-label={entry.isGitRepo ? `${entry.name}, Git repository` : entry.name}
                      onClick={() => browser.setSelectedBrowsePath(nextPath)}
                      onDoubleClick={() => void browser.browse(nextPath)}
                      className={`add-project-browser__row${browser.selectedBrowsePath === nextPath ? " is-selected" : ""}`}
                    >
                      <FolderIcon className="add-project-browser__row-icon" />
                      <span className="add-project-browser__row-name">{entry.name}</span>
                      {entry.isGitRepo ? (
                        <span className="add-project-browser__badge" aria-hidden="true">
                          git
                        </span>
                      ) : null}
                      <span className="add-project-browser__row-chevron" aria-hidden="true">
                        <ChevronRightIcon />
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
