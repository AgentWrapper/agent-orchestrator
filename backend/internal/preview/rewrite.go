package preview

import (
	"bytes"
	"regexp"
	"strings"
)

var (
	htmlURLAttrRE         = regexp.MustCompile(`(?i)(\b(?:href|src|poster|action)\s*=\s*)(["'])([^"']*)(["'])`)
	htmlSrcsetAttrRE      = regexp.MustCompile(`(?i)(\bsrcset\s*=\s*)(["'])([^"']*)(["'])`)
	htmlStyleDoubleAttrRE = regexp.MustCompile(`(?i)(\bstyle\s*=\s*)"([^"]*)"`)
	htmlStyleSingleAttrRE = regexp.MustCompile(`(?i)(\bstyle\s*=\s*)'([^']*)'`)
	htmlStyleBlockRE      = regexp.MustCompile(`(?is)(<style\b[^>]*>)(.*?)(</style>)`)
	cssURLRE              = regexp.MustCompile(`(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)`)
	cssImportRE           = regexp.MustCompile(`(?i)(@import\s+)(["'])([^"']*)(["'])`)
)

// RewriteHTMLPreviewURLs rewrites root-absolute asset URLs in workspace HTML
// so pages served below /preview/files/ still resolve "/" against the preview
// root. Ordinary relative and fully-qualified URLs are left for the browser to
// resolve normally.
func RewriteHTMLPreviewURLs(source []byte, previewRoot string) []byte {
	root := normalizePreviewRoot(previewRoot)
	if root == "" {
		return source
	}
	out := replaceHTMLAttr(source, htmlStyleBlockRE, func(parts [][]byte) []byte {
		var buf bytes.Buffer
		buf.Write(parts[1])
		buf.Write(RewriteCSSPreviewURLs(parts[2], root))
		buf.Write(parts[3])
		return buf.Bytes()
	})
	out = replaceHTMLAttr(out, htmlStyleDoubleAttrRE, func(parts [][]byte) []byte {
		return joinQuotedAttr(parts[1], []byte(`"`), RewriteCSSPreviewURLs(parts[2], root), []byte(`"`))
	})
	out = replaceHTMLAttr(out, htmlStyleSingleAttrRE, func(parts [][]byte) []byte {
		return joinQuotedAttr(parts[1], []byte(`'`), RewriteCSSPreviewURLs(parts[2], root), []byte(`'`))
	})
	out = replaceHTMLAttr(out, htmlSrcsetAttrRE, func(parts [][]byte) []byte {
		return joinQuotedAttr(parts[1], parts[2], []byte(rewriteSrcset(string(parts[3]), root)), parts[4])
	})
	out = replaceHTMLAttr(out, htmlURLAttrRE, func(parts [][]byte) []byte {
		value := string(parts[3])
		if rewritten, ok := rewriteRootAbsolute(value, root); ok {
			value = rewritten
		}
		return joinQuotedAttr(parts[1], parts[2], []byte(value), parts[4])
	})
	return out
}

// RewriteCSSPreviewURLs rewrites root-absolute url(...) and @import targets for
// CSS served below /preview/files/. Relative URLs remain relative to the CSS
// file, matching normal browser behavior.
func RewriteCSSPreviewURLs(source []byte, previewRoot string) []byte {
	root := normalizePreviewRoot(previewRoot)
	if root == "" {
		return source
	}
	out := replaceHTMLAttr(source, cssURLRE, func(parts [][]byte) []byte {
		value, quote := cssURLValue(parts)
		if rewritten, ok := rewriteRootAbsolute(value, root); ok {
			value = rewritten
		}
		return []byte("url(" + quote + value + quote + ")")
	})
	out = replaceHTMLAttr(out, cssImportRE, func(parts [][]byte) []byte {
		value := string(parts[3])
		if rewritten, ok := rewriteRootAbsolute(value, root); ok {
			value = rewritten
		}
		return joinQuotedAttr(parts[1], parts[2], []byte(value), parts[4])
	})
	return out
}

func replaceHTMLAttr(source []byte, re *regexp.Regexp, replace func(parts [][]byte) []byte) []byte {
	return re.ReplaceAllFunc(source, func(match []byte) []byte {
		parts := re.FindSubmatch(match)
		if len(parts) == 0 {
			return match
		}
		return replace(parts)
	})
}

func joinQuotedAttr(prefix, openQuote, value, closeQuote []byte) []byte {
	var buf bytes.Buffer
	buf.Grow(len(prefix) + len(openQuote) + len(value) + len(closeQuote))
	buf.Write(prefix)
	buf.Write(openQuote)
	buf.Write(value)
	buf.Write(closeQuote)
	return buf.Bytes()
}

func cssURLValue(parts [][]byte) (value, quote string) {
	switch {
	case len(parts) > 1 && parts[1] != nil:
		return string(parts[1]), `"`
	case len(parts) > 2 && parts[2] != nil:
		return string(parts[2]), `'`
	case len(parts) > 3 && parts[3] != nil:
		return strings.TrimSpace(string(parts[3])), ""
	default:
		return "", ""
	}
}

func rewriteSrcset(raw, previewRoot string) string {
	candidates := strings.Split(raw, ",")
	for i, candidate := range candidates {
		leading := candidate[:len(candidate)-len(strings.TrimLeft(candidate, " \t\r\n"))]
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) == 0 {
			continue
		}
		if rewritten, ok := rewriteRootAbsolute(fields[0], previewRoot); ok {
			fields[0] = rewritten
			candidates[i] = leading + strings.Join(fields, " ")
		}
	}
	return strings.Join(candidates, ",")
}

func rewriteRootAbsolute(raw, previewRoot string) (string, bool) {
	if !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.HasPrefix(raw, previewRoot) {
		return raw, false
	}
	return previewRoot + strings.TrimPrefix(raw, "/"), true
}

func normalizePreviewRoot(raw string) string {
	root := strings.TrimSpace(raw)
	if root == "" {
		return ""
	}
	if !strings.HasPrefix(root, "/") {
		root = "/" + root
	}
	if !strings.HasSuffix(root, "/") {
		root += "/"
	}
	return root
}
