package httpd

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/project"
)

// APIDeps bundles every Manager the API layer's controllers depend on. There
// is exactly one Manager per resource, defined in that resource's own package
// (project.Manager, later session.Manager, ...), and the controllers see ONLY
// that interface — they don't reach past it to the LCM, adapters, or stores.
// Whether a Manager impl talks to the registry, the LCM, or an outbound port
// is its own concern.
//
// The route-shell PR (#20) leaves every field nil — handlers answer via
// apispec.NotImplemented and don't dereference them yet. The handler-impl PR
// wires real Managers and flips stubs to real logic one route at a time.
type APIDeps struct {
	Projects project.Manager
}

// API owns one controller per resource and is the single Register call the
// router invokes to mount the /api/v1 surface. Splitting per-resource means
// later PRs can land a controller's real handlers without touching the
// surrounding wiring.
type API struct {
	cfg      config.Config
	projects *controllers.ProjectsController
}

// NewAPI constructs the API surface from its dependencies. cfg carries the
// per-request timeout so the REST group can apply it without re-reading the
// environment.
func NewAPI(cfg config.Config, deps APIDeps) *API {
	return &API{
		cfg: cfg,
		projects: &controllers.ProjectsController{
			Mgr: deps.Projects,
		},
	}
}

// Register mounts the API surface on root. /api/v1 hosts the REST group with
// the per-request Timeout that the skeleton router (router.go) deliberately
// kept off the global stack — REST routes are bounded, but long-lived surfaces
// (/events SSE, /mux WS) live outside this group when they land.
//
// /mux is mounted outside /api/v1 for parity with the legacy TS surface; it is
// a phase-4 placeholder and stays unregistered here until that lane starts.
func (a *API) Register(root chi.Router) {
	timeout := a.cfg.RequestTimeout
	if timeout <= 0 {
		timeout = config.DefaultRequestTimeout
	}

	root.Route("/api/v1", func(r chi.Router) {
		// The OpenAPI document is the source of truth for every contract on
		// this surface; serve it so tooling (SDK generators, the OpenAPI
		// validator in #19, the dashboard's developer tools) can fetch the
		// whole spec from the same origin as the routes it describes.
		apispec.RegisterServe(r, "/openapi.yaml")

		r.Group(func(r chi.Router) {
			r.Use(middleware.Timeout(timeout))
			a.projects.Register(r)
			// Sibling controllers (sessions, issues, prs, ...) plug in here in
			// follow-up PRs #21 / #22 without touching the timeout group.
		})
		// Surfaces that intentionally bypass the REST timeout (SSE, future WS)
		// register at this level — none exist in the route-shell PR.
	})
}

// notFoundJSON returns the locked envelope for unmatched routes. Chi's default
// 404 is a text/plain body; the API surface must answer JSON so consumers can
// parse it uniformly.
func notFoundJSON(w http.ResponseWriter, r *http.Request) {
	writeAPIError(w, r, http.StatusNotFound, "not_found", "ROUTE_NOT_FOUND",
		r.Method+" "+r.URL.Path+" has no handler", nil)
}

// methodNotAllowedJSON returns the locked envelope when a method probes a
// known path without a matching verb (e.g. PUT /projects/{id} after we drop
// the legacy PUT alias).
func methodNotAllowedJSON(w http.ResponseWriter, r *http.Request) {
	writeAPIError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "METHOD_NOT_ALLOWED",
		r.Method+" not allowed on "+r.URL.Path, nil)
}
