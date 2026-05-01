"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useFileTree } from "./useFileTree";
import type { FileNode } from "@/app/api/sessions/[id]/files/route";

interface QuickOpenProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  onFileSelected: (path: string) => void;
}

function flattenFiles(nodes: FileNode[]): { name: string; path: string }[] {
  const result: { name: string; path: string }[] = [];
  function walk(node: FileNode) {
    if (node.type === "file") {
      result.push({ name: node.name, path: node.path });
    } else if (node.children) {
      for (const child of node.children) walk(child);
    }
  }
  for (const node of nodes) walk(node);
  return result;
}

export function QuickOpen({ sessionId, open, onClose, onFileSelected }: QuickOpenProps) {
  const { tree, loading, error } = useFileTree(sessionId);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allFiles = useMemo(() => flattenFiles(tree), [tree]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allFiles.slice(0, 50);
    const q = query.toLowerCase();
    const scored = allFiles
      .map((f) => {
        const nameMatch = f.name.toLowerCase().indexOf(q);
        const pathMatch = f.path.toLowerCase().indexOf(q);
        const score = nameMatch === 0 ? 3 : nameMatch > 0 ? 2 : pathMatch >= 0 ? 1 : 0;
        return { ...f, score };
      })
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.slice(0, 50);
  }, [query, allFiles]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const selectFile = useCallback(
    (path: string) => {
      onFileSelected(path);
      onClose();
    },
    [onClose, onFileSelected],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) {
            selectFile(filtered[selectedIndex].path);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, selectFile, onClose],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        justifyContent: "center",
        paddingTop: "15vh",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          zIndex: -1,
        }}
      />
      <div
        style={{
          width: "min(520px, 90vw)",
          maxHeight: "60vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border-default)",
          borderRadius: "8px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "8px 12px",
            gap: "8px",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-text-tertiary)"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files by name..."
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              color: "var(--color-text-primary)",
              fontSize: "14px",
              fontFamily: "inherit",
            }}
          />
          <kbd
            style={{
              fontSize: "10px",
              color: "var(--color-text-tertiary)",
              background: "var(--color-bg-surface)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "3px",
              padding: "1px 5px",
            }}
          >
            esc
          </kbd>
        </div>
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {filtered.length === 0 && (
            <div
              style={{
                padding: "16px",
                textAlign: "center",
                color: "var(--color-text-tertiary)",
                fontSize: "13px",
              }}
            >
              {error
                ? "Failed to load files"
                : loading && allFiles.length === 0
                  ? "Loading files…"
                  : "No files found"}
            </div>
          )}
          {filtered.map((file, i) => {
            const isSelected = i === selectedIndex;
            const dirPath = file.path.includes("/")
              ? file.path.slice(0, file.path.lastIndexOf("/"))
              : "";
            return (
              <div
                key={file.path}
                onClick={() => selectFile(file.path)}
                onMouseEnter={() => setSelectedIndex(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 12px",
                  cursor: "pointer",
                  background: isSelected ? "var(--color-hover-overlay)" : "transparent",
                  transition: "background 0.05s",
                }}
              >
                <span style={{ fontSize: "14px", flexShrink: 0 }}>📄</span>
                <span
                  style={{
                    fontSize: "13px",
                    color: "var(--color-text-primary)",
                    fontWeight: isSelected ? 500 : 400,
                    whiteSpace: "nowrap",
                  }}
                >
                  {file.name}
                </span>
                {dirPath && (
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--color-text-tertiary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0,
                    }}
                  >
                    {dirPath}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
