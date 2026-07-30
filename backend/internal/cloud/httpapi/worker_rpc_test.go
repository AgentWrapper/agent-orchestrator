package httpapi

import (
	"strings"
	"testing"
)

func TestRewritePreviewBodyKeepsAssetsInsideCapabilityRoute(t *testing.T) {
	prefix := "/api/cloud/v1/preview/token"
	html := []byte(`<link href="/style.css"><script type="module" src="/src/main.js"></script>`)
	rewritten := string(rewritePreviewBody(html, "text/html", prefix, 3000))
	for _, expected := range []string{
		`href="` + prefix + `/style.css"`,
		`src="` + prefix + `/src/main.js"`,
	} {
		if !strings.Contains(rewritten, expected) {
			t.Fatalf("rewritten HTML %q does not contain %q", rewritten, expected)
		}
	}

	javascript := []byte(`import value from "/node_modules/value.js"; import("/lazy.js")`)
	rewritten = string(rewritePreviewBody(javascript, "application/javascript", prefix, 3000))
	for _, expected := range []string{
		`from "` + prefix + `/node_modules/value.js"`,
		`import("` + prefix + `/lazy.js")`,
	} {
		if !strings.Contains(rewritten, expected) {
			t.Fatalf("rewritten JavaScript %q does not contain %q", rewritten, expected)
		}
	}
}
