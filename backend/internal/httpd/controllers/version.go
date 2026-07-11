package controllers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/buildinfo"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// VersionController owns the /version route. It reports the running daemon's
// build provenance (VCS revision, commit time, dirty flag) so an operator or
// ops/deploy.sh can confirm exactly which commit the daemon was built from —
// including whether it was built from a dirty tree.
type VersionController struct{}

// Register mounts the version route on the supplied router.
func (c *VersionController) Register(r chi.Router) {
	r.Get("/version", c.get)
}

func (c *VersionController) get(w http.ResponseWriter, _ *http.Request) {
	envelope.WriteJSON(w, http.StatusOK, buildinfo.Read())
}
