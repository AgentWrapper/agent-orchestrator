package httpd

import (
	"net/http"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// writeJSON serialises v as JSON with the given status. It is the single JSON
// writer for the skeleton; the typed error envelope (open item Q1.3) will build
// on this in a later phase.
func writeJSON(w http.ResponseWriter, status int, v any) {
	envelope.WriteJSON(w, status, v)
}
