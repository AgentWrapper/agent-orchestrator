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
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    max-width: 920px;
    margin: 0 auto;
    padding: 16px 24px;
    word-wrap: break-word;
  }
  @media (prefers-color-scheme: dark) {
    body {
      color: #e4e4e4;
      background: #1a1a1a;
    }
    a { color: #58a6ff; }
    code, pre { background: #2d2d2d; }
    pre { border-color: #404040; }
    img { opacity: 0.85; }
  }
  h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }
  h1 { font-size: 2em; border-bottom: 1px solid #e1e4e8; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e1e4e8; padding-bottom: 0.3em; }
  code { padding: 0.2em 0.4em; border-radius: 3px; font-size: 85%; }
  pre { padding: 16px; border-radius: 6px; border: 1px solid #e1e4e8; overflow-x: auto; }
  pre code { padding: 0; border-radius: 0; font-size: 100%; }
  blockquote { margin: 0; padding: 0 1em; color: #656d76; border-left: 0.25em solid #d0d7de; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: 6px 13px; text-align: left; }
  th { background: #f6f8fa; }
  @media (prefers-color-scheme: dark) {
    th { background: #2d2d2d; }
    th, td { border-color: #404040; }
    blockquote { color: #8b949e; border-left-color: #30363d; }
    h1, h2 { border-bottom-color: #30363d; }
  }
  img { max-width: 100%; }
</style>
</head>
<body>
{{BODY}}
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
