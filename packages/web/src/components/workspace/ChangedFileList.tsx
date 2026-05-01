"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFileTree } from "./useFileTree";
import { getFileIcon } from "./fileIcons";

type GitStatus = "M" | "A" | "D" | "?" | "R";
type DiffScope = "local" | "branch";

interface ChangedFileListProps {
  sessionId: string;
  selectedFile: string | null;
  onFileSelected: (path: string) => void;
  scope?: DiffScope;
  onBaseRefChange?: (ref: string | null) => void;
}

interface FlatFile {
  path: string;
  name: string;
  dir: string;
  status: GitStatus;
}

interface Group {
  dir: string;
  files: FlatFile[];
}

function getStatusLabel(status: GitStatus): string {
  switch (status) {
    case "A": return "A";
    case "?": return "A";
    case "M": return "M";
    case "D": return "D";
    case "R": return "R";
    default: return "?";
  }
}

function flattenChanged(gitStatus: Record<string, GitStatus>): FlatFile[] {
  const files: FlatFile[] = [];
  for (const [path, status] of Object.entries(gitStatus)) {
    const lastSlash = path.lastIndexOf("/");
    const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
    files.push({ path, name, dir, status });
  }
  // Sort by dir then name
  files.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir.localeCompare(b.dir);
    return a.name.localeCompare(b.name);
  });
  return files;
}

function groupFiles(files: FlatFile[]): Group[] {
  const groupMap = new Map<string, FlatFile[]>();
  for (const file of files) {
    const existing = groupMap.get(file.dir);
    if (existing) {
      existing.push(file);
    } else {
      groupMap.set(file.dir, [file]);
    }
  }
  const groups: Group[] = [];
  for (const [dir, groupFiles] of groupMap) {
    groups.push({ dir, files: groupFiles });
  }
  return groups;
}

export function ChangedFileList({
  sessionId,
  selectedFile,
  onFileSelected,
  scope = "local",
  onBaseRefChange,
}: ChangedFileListProps) {
  const { gitStatus, baseRef, loading, error } = useFileTree(sessionId, scope);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const prevBaseRefRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (onBaseRefChange && baseRef !== prevBaseRefRef.current) {
      prevBaseRefRef.current = baseRef;
      onBaseRefChange(baseRef);
    }
  }, [baseRef, onBaseRefChange]);

  const flatFiles = flattenChanged(gitStatus);
  const groups = groupFiles(flatFiles);

  // All visible (non-collapsed) files in order for keyboard nav
  const visibleFiles = groups.flatMap((g) =>
    collapsedDirs.has(g.dir) ? [] : g.files
  );

  const toggleDir = useCallback((dir: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, path: string) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onFileSelected(path);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = visibleFiles.findIndex((f) => f.path === path);
        if (idx < 0) return;
        const next =
          e.key === "ArrowDown"
            ? visibleFiles[idx + 1]
            : visibleFiles[idx - 1];
        if (next) onFileSelected(next.path);
      }
    },
    [visibleFiles, onFileSelected]
  );

  if (error) {
    return (
      <div className="changed-file-list-empty">Error: {error}</div>
    );
  }

  if (loading && flatFiles.length === 0) {
    return (
      <div className="changed-file-list-empty">Loading changes...</div>
    );
  }

  if (flatFiles.length === 0) {
    return (
      <div className="changed-file-list-empty">No changed files</div>
    );
  }

  return (
    <div className="changed-file-list" role="tree">
      {groups.map((group) => {
        const isCollapsed = collapsedDirs.has(group.dir);
        const dirLabel = group.dir || "(root)";
        return (
          <div key={group.dir} role="group">
            <button
              type="button"
              className="changed-file-list-dir-header"
              onClick={() => toggleDir(group.dir)}
              aria-expanded={!isCollapsed}
              title={dirLabel}
            >
              <span className="changed-file-list-dir-chevron" aria-hidden>
                {isCollapsed ? "▶" : "▼"}
              </span>
              <span className="changed-file-list-dir-name">{dirLabel}</span>
              <span className="changed-file-list-dir-count">{group.files.length}</span>
            </button>
            {!isCollapsed && (
              <div>
                {group.files.map((file) => {
                  const isSelected = file.path === selectedFile;
                  return (
                    <div
                      key={file.path}
                      role="treeitem"
                      tabIndex={0}
                      aria-selected={isSelected}
                      aria-label={file.path}
                      className={`changed-file-list-file${isSelected ? " changed-file-list-file--selected" : ""}`}
                      onClick={() => onFileSelected(file.path)}
                      onKeyDown={(e) => handleKeyDown(e, file.path)}
                    >
                      <span className="changed-file-list-file-icon" aria-hidden>
                        {getFileIcon(file.name)}
                      </span>
                      <span className="changed-file-list-file-name">{file.name}</span>
                      <span
                        className={`changed-file-list-file-status changed-file-list-file-status--${file.status === "?" ? "A" : file.status}`}
                        aria-label={`status: ${file.status}`}
                      >
                        {getStatusLabel(file.status)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
