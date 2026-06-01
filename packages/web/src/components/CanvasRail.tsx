"use client";

import { useEffect, useState } from "react";
import type { CanvasArtifact } from "@aoagents/ao-core";
import { useSessionCanvases } from "@/hooks/useSessionCanvases";
import { CanvasMarkdown } from "./CanvasMarkdown";
import { CanvasDiff } from "./CanvasDiff";
import { CanvasTable } from "./CanvasTable";
import { CanvasStats } from "./CanvasStats";

type Props = { sessionId: string };

export function CanvasRail({ sessionId }: Props) {
  const { canvases, loading, error } = useSessionCanvases(sessionId);
  const [open, setOpen] = useState<boolean | null>(null);

  // Auto-expand the first time a canvas appears for this session. Once the user
  // explicitly toggles, `open` is no longer null and this effect is a no-op.
  useEffect(() => {
    if (open !== null) return;
    if (canvases.length > 0) setOpen(true);
  }, [open, canvases.length]);

  // Reset on session change so a new session starts in its own auto-expand state.
  useEffect(() => {
    setOpen(null);
  }, [sessionId]);

  const isOpen = open ?? false;

  if (!isOpen) {
    return (
      <div className="flex w-6 shrink-0 flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="h-full w-6 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          aria-label="Open canvas rail"
          title={canvases.length > 0 ? `${canvases.length} canvas${canvases.length === 1 ? "" : "es"}` : "Canvases"}
        >
          <span className="block -rotate-90 whitespace-nowrap">
            Canvases{canvases.length > 0 ? ` (${canvases.length})` : ""}
          </span>
        </button>
      </div>
    );
  }

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Canvases
        </h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          aria-label="Close canvas rail"
        >
          ✕
        </button>
      </header>
      <div className="flex flex-1 flex-col gap-3 overflow-auto p-3">
        {error && (
          <div className="text-xs text-[var(--color-status-error)]">Failed to load canvases: {error}</div>
        )}
        {!error && !loading && canvases.length === 0 && (
          <div className="text-xs text-[var(--color-text-secondary)]">
            No canvases yet. Agents can write artifacts to{" "}
            <code className="font-mono">.ao/canvases/&lt;id&gt;.json</code>.
          </div>
        )}
        {canvases.map((canvas) => (
          <CanvasPanel key={canvas.id} canvas={canvas} />
        ))}
      </div>
    </aside>
  );
}

function CanvasPanel({ canvas }: { canvas: CanvasArtifact }) {
  return (
    <section className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-3">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{canvas.title}</h3>
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">
          {canvas.source ?? canvas.type}
        </span>
      </header>
      <CanvasBody canvas={canvas} />
    </section>
  );
}

function CanvasBody({ canvas }: { canvas: CanvasArtifact }) {
  switch (canvas.type) {
    case "markdown":
      return <CanvasMarkdown canvas={canvas} />;
    case "diff":
      return <CanvasDiff canvas={canvas} />;
    case "table":
      return <CanvasTable canvas={canvas} />;
    case "stats":
      return <CanvasStats canvas={canvas} />;
  }
}
