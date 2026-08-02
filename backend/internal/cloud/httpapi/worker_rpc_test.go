package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
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

func TestPreviewTokenCanScopeARepositoryFile(t *testing.T) {
	store := newPreviewTokenStore()
	sessionID := clouddomain.SessionID("session-one")
	token, _ := store.issueFile(sessionID, "examples/index.html")
	value, ok := store.get(token)
	if !ok {
		t.Fatal("issued file preview token was not found")
	}
	if value.SessionID != sessionID || value.FilePath != "examples/index.html" || value.Port != 0 {
		t.Fatalf("file preview token = %#v", value)
	}
}

func TestPreviewTokenPreservesRequestedPort(t *testing.T) {
	store := newPreviewTokenStore()
	sessionID := clouddomain.SessionID("session-one")
	for _, port := range []int{5001, 5002, 65535} {
		token, _ := store.issue(sessionID, port)
		value, ok := store.get(token)
		if !ok {
			t.Fatalf("issued preview token for port %d was not found", port)
		}
		if value.Port != port {
			t.Fatalf("preview token port = %d, want %d", value.Port, port)
		}
	}
}

func TestPreviewProxyHeadersDoNotLeakCapabilityURL(t *testing.T) {
	response := httptest.NewRecorder()

	setPreviewProxyHeaders(response)

	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := response.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
}
