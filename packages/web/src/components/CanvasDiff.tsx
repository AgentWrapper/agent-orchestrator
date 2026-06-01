"use client";

import { useState } from "react";
import type { CanvasArtifact, CanvasDiffFile } from "@aoagents/ao-core";

type Props = { canvas: Extract<CanvasArtifact, { type: "diff" }> };

export function CanvasDiff({ canvas }: Props) {
  return (
    <div className="flex flex-col gap-3">
      {canvas.payload.files.map((file) => (
        <DiffFileBlock key={`${file.oldPath ?? ""}::${file.path}`} file={file} />
      ))}
    </div>
  );
}

function DiffFileBlock({ file }: { file: CanvasDiffFile }) {
  const [open, setOpen] = useState(true);
  const statusBadge = statusLabel(file.status);
  return (
    <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-mono text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
      >
        <span className="truncate">
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">
          {statusBadge}
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--color-border-subtle)] font-mono text-xs">
          {file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="bg-[var(--color-bg-surface)] px-3 py-1 text-[var(--color-text-secondary)]">
                {hunk.header}
              </div>
              {hunk.lines.map((line, li) => (
                <div
                  key={li}
                  className={[
                    "px-3 py-[1px] whitespace-pre",
                    line.kind === "add"
                      ? "bg-[color-mix(in_srgb,var(--color-status-working)_18%,transparent)]"
                      : line.kind === "del"
                        ? "bg-[color-mix(in_srgb,var(--color-status-error)_18%,transparent)]"
                        : "",
                  ].join(" ")}
                >
                  <span className="select-none pr-2 text-[var(--color-text-secondary)]">
                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                  </span>
                  {line.text}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusLabel(s: CanvasDiffFile["status"]): string {
  return s === "added" ? "added" : s === "deleted" ? "deleted" : s === "renamed" ? "renamed" : "modified";
}
