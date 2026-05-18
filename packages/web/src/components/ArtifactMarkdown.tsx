"use client";

import type { Artifact } from "@aoagents/ao-core";
import { Marked } from "marked";
import { useMemo, type ReactNode } from "react";

/**
 * Escape raw HTML so it renders as visible text rather than being injected
 * into the DOM. Used by the custom marked renderer below so that agent-emitted
 * markdown can never inject `<script>` / `<iframe>` / event handlers.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A per-module marked instance configured to disallow raw HTML pass-through.
 *
 * marked v11 has no built-in `sanitize` option. The renderer's `html` method is
 * called for every raw HTML block/span that the parser encounters in markdown
 * source. By overriding `html` to escape its input, every `<script>`, `<img>`,
 * `<iframe>`, etc. that an agent embeds in a markdown payload is rendered as
 * literal text. Combined with `dangerouslySetInnerHTML` below, this keeps the
 * markdown card safe by construction.
 */
const markdownParser = new Marked({
  async: false,
  gfm: true,
  breaks: false,
  renderer: {
    html(html: string): string {
      return escapeHtml(html);
    },
  },
});

interface ArtifactMarkdownProps {
  artifact: Extract<Artifact, { type: "markdown" }>;
  /** When true, hide the body and render only the header row. */
  collapsed?: boolean;
  /** Slot for the up/down/collapse buttons (rendered by the parent rail). */
  controls?: ReactNode;
}

/**
 * Renders a markdown-type artifact card.
 *
 * Safety: raw HTML in the markdown source is escaped (see `markdownParser`).
 * The test suite verifies that `<script>alert(1)</script>` in input is rendered
 * as text rather than executed.
 */
export function ArtifactMarkdown({ artifact, collapsed = false, controls }: ArtifactMarkdownProps) {
  const html = useMemo(() => {
    const parsed = markdownParser.parse(artifact.payload.markdown);
    return typeof parsed === "string" ? parsed : "";
  }, [artifact.payload.markdown]);

  const source = artifact.source ?? "agent";

  return (
    <article
      className="artifact-card flex flex-col gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3"
      data-artifact-type="markdown"
    >
      <header className="artifact-card-header flex items-center justify-between gap-2">
        <span className="artifact-card-title text-sm font-medium text-[var(--color-text-primary)]">
          {artifact.title}
        </span>
        <div className="flex items-center gap-2">
          <span className="artifact-card-source text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            {source}
          </span>
          {controls}
        </div>
      </header>
      {!collapsed && (
        <div
          className="artifact-card-body markdown-body text-sm text-[var(--color-text-secondary)] [&_code]:rounded [&_code]:bg-[var(--color-bg-subtle)] [&_code]:px-1 [&_code]:py-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--color-bg-inset)] [&_pre]:p-2"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </article>
  );
}
