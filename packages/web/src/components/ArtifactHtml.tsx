"use client";

import type { Artifact } from "@aoagents/ao-core";
import { useEffect, useRef, useState, type ReactNode } from "react";

const DEFAULT_HEIGHT_PX = 240;
const MAX_HEIGHT_PX = 1600;

/**
 * Small script injected into the iframe's srcdoc. It posts the document's
 * scrollHeight up to the parent on load and on every resize observed in the
 * root element, so the iframe can size to its content without us measuring it
 * from the parent (which would require same-origin access — and we deliberately
 * deny that, see sandbox attr below).
 */
const ARTIFACT_SIZE_BRIDGE = `
<script>
(function() {
  function sendSize() {
    try {
      var h = document.documentElement.scrollHeight;
      parent.postMessage({ type: "artifact-resize", height: h }, "*");
    } catch (e) { /* parent gone */ }
  }
  window.addEventListener("load", sendSize);
  if (typeof ResizeObserver !== "undefined") {
    var ro = new ResizeObserver(sendSize);
    ro.observe(document.documentElement);
  }
})();
</script>
`;

interface ArtifactHtmlProps {
  artifact: Extract<Artifact, { type: "html" }>;
  /** When true, hide the iframe and render only the header row. */
  collapsed?: boolean;
  /** Slot for the up/down/collapse buttons (rendered by the parent rail). */
  controls?: ReactNode;
}

/**
 * Renders an HTML-type artifact card inside a sandboxed iframe.
 *
 * Security invariant: `sandbox="allow-scripts"` WITHOUT `allow-same-origin`.
 * This gives the iframe a null origin: scripts inside can run but cannot read
 * cookies, localStorage, or call same-origin APIs on the parent. Even if an
 * agent is prompt-injected and emits malicious HTML, the blast radius stays
 * inside the iframe. The test suite asserts this attribute exactly.
 */
export function ArtifactHtml({ artifact, collapsed = false, controls }: ArtifactHtmlProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT_PX);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; height?: number } | null;
      if (!data || data.type !== "artifact-resize") return;
      if (typeof data.height !== "number" || Number.isNaN(data.height)) return;
      setHeight(Math.min(Math.max(data.height, DEFAULT_HEIGHT_PX), MAX_HEIGHT_PX));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Match the AO dashboard's dark aesthetic. Browsers default iframe documents
  // to a white background regardless of `bg-transparent` on the iframe element,
  // so we explicitly:
  //   - set `color-scheme: dark` so browser-default widgets (form controls,
  //     scrollbars) use the dark variant
  //   - set transparent backgrounds on html + body so the parent's bg shows
  //     through any padding gaps
  //   - use a light foreground color (var-style hex matching globals.css's
  //     --color-text-primary) so unstyled agent text is readable
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><style>:root{color-scheme:dark}html,body{background:transparent}body{margin:0;padding:8px;font-family:ui-sans-serif,system-ui,sans-serif;color:#e3e6ed;font-size:14px;line-height:1.5}</style></head><body>${artifact.payload.html}${ARTIFACT_SIZE_BRIDGE}</body></html>`;

  const source = artifact.source ?? "agent";

  return (
    <article
      className="artifact-card flex flex-col gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3"
      data-artifact-type="html"
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
      {/*
       * Inline `style` is necessary here: the iframe height is a runtime value
       * pushed from the iframe via postMessage on every internal resize. A
       * Tailwind class can't express a per-instance pixel height; tracking it
       * via React state and applying it inline is the simplest correct option.
       * See CLAUDE.md C-02 — this is the documented exception.
       */}
      {!collapsed && (
        <iframe
          ref={iframeRef}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          title={artifact.title}
          className="artifact-html-iframe w-full rounded border-0 bg-transparent"
          style={{ height: `${height}px` }}
        />
      )}
    </article>
  );
}
