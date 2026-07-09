package preview

import (
	"bytes"
	"html"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	ghtml "github.com/yuin/goldmark/renderer/html"
)

// markdownRenderer converts workspace Markdown to HTML for the browser panel.
// GitHub-flavored extensions (tables, strikethrough, task lists, autolinks) are
// enabled, and raw HTML is passed through: preview content is workspace-local
// and agent-trusted, matching the preview target's existing trust model.
var markdownRenderer = goldmark.New(
	goldmark.WithExtensions(extension.GFM),
	goldmark.WithRendererOptions(ghtml.WithUnsafe()),
)

// RenderMarkdown converts Markdown source into a self-contained HTML document
// styled for the browser panel. title labels the document (typically the file
// name).
func RenderMarkdown(source []byte, title string) ([]byte, error) {
	var body bytes.Buffer
	if err := markdownRenderer.Convert(source, &body); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.WriteString("<!doctype html>\n<html lang=\"en\">\n<head>\n")
	out.WriteString("<meta charset=\"utf-8\">\n")
	out.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	out.WriteString("<title>")
	out.WriteString(html.EscapeString(title))
	out.WriteString("</title>\n<style>")
	out.WriteString(markdownStyles)
	out.WriteString("</style>\n</head>\n<body>\n<main class=\"markdown-body\">\n")
	out.Write(body.Bytes())
	out.WriteString("\n</main>\n</body>\n</html>\n")
	return out.Bytes(), nil
}

// markdownStyles is a compact GitHub-like stylesheet that honors the OS color
// scheme so the rendered Markdown fits the desktop browser panel in both light
// and dark modes.
const markdownStyles = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #ffffff;
  color: #1f2328;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.6;
}
.markdown-body {
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  margin: 1.5em 0 0.6em;
  font-weight: 600;
  line-height: 1.25;
}
.markdown-body h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid rgba(128,128,128,0.25); }
.markdown-body h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid rgba(128,128,128,0.25); }
.markdown-body h3 { font-size: 1.25em; }
.markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote, .markdown-body table {
  margin: 0 0 1em;
}
.markdown-body a { color: #3b82f6; text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: rgba(128,128,128,0.15);
  padding: 0.2em 0.4em;
  border-radius: 6px;
}
.markdown-body pre {
  background: rgba(128,128,128,0.12);
  padding: 16px;
  border-radius: 8px;
  overflow: auto;
}
.markdown-body pre code { background: none; padding: 0; }
.markdown-body blockquote {
  padding: 0 1em;
  border-left: 4px solid rgba(128,128,128,0.35);
  color: rgba(120,120,120,1);
}
.markdown-body table { border-collapse: collapse; width: auto; }
.markdown-body th, .markdown-body td { border: 1px solid rgba(128,128,128,0.3); padding: 6px 13px; }
.markdown-body img { max-width: 100%; }
.markdown-body hr { border: none; border-top: 1px solid rgba(128,128,128,0.25); margin: 2em 0; }
.markdown-body input[type="checkbox"] { margin-right: 0.5em; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
}
`
