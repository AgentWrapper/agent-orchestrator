import { marked } from "marked";
import { parseHTML } from "linkedom";

const { document: linkedDocument } = parseHTML("<!DOCTYPE html><html><head></head><body></body></html>");

import DOMPurify from "dompurify";
// DOMPurify's default export is a callable factory function at runtime.
// Calling it with a window-like object scopes sanitization to that window.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const purify = (DOMPurify as any)(linkedDocument.defaultView);

export interface RenderResult {
	html: string;
	title: string;
}

const HTML_TEMPLATE = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    background: #fff;
    padding: 2rem 1rem;
  }
  .container { max-width: 42rem; margin: 0 auto; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; line-height: 1.3; }
  h1 { font-size: 1.8rem; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.3em; }
  h2 { font-size: 1.4rem; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
  h3 { font-size: 1.15rem; }
  p, ul, ol, blockquote, pre { margin-bottom: 1em; }
  ul, ol { padding-left: 2em; }
  code { font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace; font-size: 0.9em; }
  p > code, li > code { background: #f4f4f4; padding: 0.15em 0.3em; border-radius: 3px; }
  pre { background: #f6f8fa; border-radius: 6px; padding: 1em; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #ddd; padding-left: 1em; color: #555; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1em; }
  th, td { border: 1px solid #ddd; padding: 0.5em; text-align: left; }
  th { background: #f6f8fa; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
</style>
</head>
<body>
<div class="container">${body}</div>
</body>
</html>`;

export async function renderMarkdown(content: string, filename: string): Promise<RenderResult> {
	const rawHtml = await marked.parse(content);
	const sanitized = purify.sanitize(rawHtml);
	const title = extractTitle(sanitized) || basename(filename);
	const html = HTML_TEMPLATE(title, sanitized);
	return { html, title };
}

export function renderMarkdownSync(content: string, filename: string): RenderResult {
	const rawHtml = marked.parse(content, { async: false }) as string;
	const sanitized = purify.sanitize(rawHtml);
	const title = extractTitle(sanitized) || basename(filename);
	const html = HTML_TEMPLATE(title, sanitized);
	return { html, title };
}

function extractTitle(html: string): string | null {
	const match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
	return match ? match[1].trim() : null;
}

function basename(filepath: string): string {
	const parts = filepath.replace(/\\/g, "/").split("/");
	return parts[parts.length - 1] || "untitled";
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
