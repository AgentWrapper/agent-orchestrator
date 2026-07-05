/**
 * Markdown rendering pipeline.
 *
 * Converts raw markdown source into a safely-sanitised HTML page
 * wrapped in a strict CSP template ready to serve via the
 * `app://md-preview/` custom protocol.
 *
 * Uses `marked` for parsing and `DOMPurify` running on a window
 * created by `linkedom` (a lightweight DOM implementation) for HTML
 * sanitisation.  The output contains zero JavaScript and carries a
 * `script-src 'none'` policy so that even a sanitisation bypass
 * cannot execute code in the preview view.
 */

import { marked } from "marked";
import createDOMPurify from "dompurify";
import { parseHTML } from "linkedom";

// ---------------------------------------------------------------------------
// One-off DOMPurify instance backed by a linkedom window.
// ---------------------------------------------------------------------------
const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
const purify = createDOMPurify(window);

// ---------------------------------------------------------------------------
// CSP / HTML template for every markdown preview page.
// ---------------------------------------------------------------------------

const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: file: http: https:",
  "font-src 'self' data:",
  "script-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{{CSP}}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }

  /* --- CSS-only theme toggle (no JS, respects script-src 'none') --- */
  .theme-toggle {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .theme-toggle-label {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    background: rgba(128, 128, 128, 0.1);
    backdrop-filter: blur(6px);
    transition: background 0.2s, transform 0.2s;
    user-select: none;
  }
  .theme-toggle-label:hover {
    background: rgba(128, 128, 128, 0.25);
    transform: scale(1.1);
  }
  .theme-toggle-label::after { content: "\\263E"; }  /* ☾ dark symbol shown in light mode = click to go dark */
  #theme-toggle:checked + .theme-toggle-label::after { content: "\\2600"; }  /* ☀ light symbol shown in dark mode = click to go light */

  /* --- Theme background on <body> (fixes white border from .content's max-width) --- */
  body:has(#theme-toggle:not(:checked)) { background: #ffffff; }
  body:has(#theme-toggle:checked) { background: #1a1a1a; }
  body { transition: background 0.25s; }

  /* --- Light theme (checked = false) --- */
  #theme-toggle:not(:checked) ~ .content {
    color: #1a1a1a;
  }
  #theme-toggle:not(:checked) ~ .content a { color: #0969da; }
  #theme-toggle:not(:checked) ~ .content code,
  #theme-toggle:not(:checked) ~ .content pre { background: #f6f8fa; }
  #theme-toggle:not(:checked) ~ .content pre { border-color: #e1e4e8; }
  #theme-toggle:not(:checked) ~ .content blockquote {
    color: #656d76;
    border-left-color: #d0d7de;
  }
  #theme-toggle:not(:checked) ~ .content th,
  #theme-toggle:not(:checked) ~ .content td { border-color: #d0d7de; }
  #theme-toggle:not(:checked) ~ .content th { background: #f6f8fa; }
  #theme-toggle:not(:checked) ~ .content h1,
  #theme-toggle:not(:checked) ~ .content h2 { border-bottom-color: #e1e4e8; }

  /* --- Dark theme (checked = true) --- */
  #theme-toggle:checked ~ .content {
    color: #e4e4e4;
  }
  #theme-toggle:checked ~ .content a { color: #58a6ff; }
  #theme-toggle:checked ~ .content code,
  #theme-toggle:checked ~ .content pre { background: #2d2d2d; }
  #theme-toggle:checked ~ .content pre { border-color: #404040; }
  #theme-toggle:checked ~ .content img { opacity: 0.85; }
  #theme-toggle:checked ~ .content blockquote {
    color: #8b949e;
    border-left-color: #30363d;
  }
  #theme-toggle:checked ~ .content th,
  #theme-toggle:checked ~ .content td { border-color: #404040; }
  #theme-toggle:checked ~ .content th { background: #2d2d2d; }
  #theme-toggle:checked ~ .content h1,
  #theme-toggle:checked ~ .content h2 { border-bottom-color: #30363d; }

  /* --- Shared content layout --- */
  .content {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      Helvetica, Arial, sans-serif;
    line-height: 1.6;
    max-width: 920px;
    margin: 0 auto;
    padding: 16px 24px;
    word-wrap: break-word;
    min-height: 100vh;
    transition: color 0.25s;
  }
  .content h1, .content h2, .content h3, .content h4, .content h5, .content h6 {
    margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25;
  }
  .content h1 { font-size: 2em; border-bottom: 1px solid; padding-bottom: 0.3em; }
  .content h2 { font-size: 1.5em; border-bottom: 1px solid; padding-bottom: 0.3em; }
  .content code { padding: 0.2em 0.4em; border-radius: 3px; font-size: 85%; }
  .content pre { padding: 16px; border-radius: 6px; border: 1px solid; overflow-x: auto; }
  .content pre code { padding: 0; border-radius: 0; font-size: 100%; background: transparent; }
  .content blockquote { margin: 0; padding: 0 1em; border-left: 0.25em solid; }
  .content table { border-collapse: collapse; width: 100%; }
  .content th, .content td { border: 1px solid; padding: 6px 13px; text-align: left; }
  .content img { max-width: 100%; transition: opacity 0.25s; }
</style>
</head>
<body>
<input type="checkbox" id="theme-toggle" class="theme-toggle">
<label for="theme-toggle" class="theme-toggle-label" title="Toggle dark/light theme"></label>
<div class="content">
{{BODY}}
</div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Allowed tags / attributes for the sanitised output.
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "pre", "code", "blockquote",
  "strong", "em", "del", "ins", "sub", "sup",
  "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "div", "span",
  "dl", "dt", "dd",
  "abbr", "address",
];

const ALLOWED_ATTR = [
  "href", "src", "alt", "title",
  "target", "rel",
  "id", "class",
  "colspan", "rowspan",
];

// ---------------------------------------------------------------------------
// Public render function
// ---------------------------------------------------------------------------

/**
 * Render raw markdown to a self-contained, sanitised HTML page.
 *
 * The output is safe to serve to any WebContentsView:
 * - All HTML tags not in the allowlist are stripped.
 * - All attributes not in the allowlist are stripped.
 * - No JavaScript is present.
 * - The page carries a strict CSP.
 * - The dark-mode styles follow the system preference automatically.
 *
 * @param source — Raw markdown text.
 * @param title  — Optional page title (falls back to "Markdown Preview").
 * @returns      A complete HTML document string.
 */
export function renderMarkdown(source: string, title?: string): string {
  // 1. Parse markdown to raw HTML.
  const rawHtml = marked.parse(source, { async: false }) as string;

  // 2. Sanitise with DOMPurify — strips everything not in the allowlist.
  const safeHtml = purify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });

  // 3. Wrap in the template.
  const pageTitle = title?.trim() || "Markdown Preview";
  return HTML_TEMPLATE
    .replace("{{CSP}}", PREVIEW_CSP)
    .replace("{{TITLE}}", escapeHtml(pageTitle))
    .replace("{{BODY}}", safeHtml);
}

// ---------------------------------------------------------------------------
// Minimal HTML-escaping for the <title> element.
// ---------------------------------------------------------------------------

const HTML_ENTITY_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ENTITY_MAP[ch] ?? ch);
}

// ---------------------------------------------------------------------------
// Extract the first H1 from raw HTML for use as a page title.
// ---------------------------------------------------------------------------

const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const TAG_RE = /<[^>]*>/g;

/**
 * Try to extract a human-readable title from rendered HTML.
 * Returns `undefined` when no H1 is present.
 */
export function extractTitle(renderedHtml: string): string | undefined {
  const m = H1_RE.exec(renderedHtml);
  if (!m) return undefined;
  return m[1].replace(TAG_RE, "").trim();
}
