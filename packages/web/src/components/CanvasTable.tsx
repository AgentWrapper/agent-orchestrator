"use client";

import type { CanvasArtifact } from "@aoagents/ao-core";

type Props = { canvas: Extract<CanvasArtifact, { type: "table" }> };

export function CanvasTable({ canvas }: Props) {
  const { columns, rows } = canvas.payload;
  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-[var(--color-bg-surface)] text-left text-[var(--color-text-secondary)]">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={[
                  "border-b border-[var(--color-border-subtle)] px-2 py-1.5 font-medium",
                  col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left",
                ].join(" ")}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-[var(--color-border-subtle)]">
              {columns.map((col) => {
                const value = row[col.key];
                const display =
                  value === null || value === undefined
                    ? ""
                    : typeof value === "boolean"
                      ? value ? "yes" : "no"
                      : String(value);
                const isNumeric = typeof value === "number";
                return (
                  <td
                    key={col.key}
                    className={[
                      "px-2 py-1.5 text-[var(--color-text-primary)]",
                      col.align === "right" || isNumeric ? "text-right tabular-nums" : "",
                      col.align === "center" ? "text-center" : "",
                      isNumeric ? "font-mono" : "",
                    ].join(" ")}
                  >
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
