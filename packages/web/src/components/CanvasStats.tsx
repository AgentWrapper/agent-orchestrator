"use client";

import type { CanvasArtifact } from "@aoagents/ao-core";

type Props = { canvas: Extract<CanvasArtifact, { type: "stats" }> };

const toneClass: Record<NonNullable<Extract<CanvasArtifact, { type: "stats" }>["payload"]["metrics"][number]["tone"]>, string> = {
  good: "text-[var(--color-status-working)]",
  warn: "text-[var(--color-status-pending)]",
  bad: "text-[var(--color-status-error)]",
  neutral: "text-[var(--color-text-primary)]",
};

export function CanvasStats({ canvas }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {canvas.payload.metrics.map((m, i) => (
        <div
          key={i}
          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] p-3"
        >
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">
            {m.label}
          </div>
          <div
            className={[
              "mt-1 text-lg font-semibold tabular-nums",
              toneClass[m.tone ?? "neutral"],
            ].join(" ")}
          >
            {typeof m.value === "number" ? m.value.toLocaleString() : m.value}
          </div>
          {m.delta && (
            <div className="mt-0.5 text-xs text-[var(--color-text-secondary)]">{m.delta}</div>
          )}
        </div>
      ))}
    </div>
  );
}
