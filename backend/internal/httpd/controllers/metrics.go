package controllers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/metrics"
)

// MetricsProvider is the controller-facing read surface for the resource
// metrics observer. It is a pure in-memory read of the observer's retained
// snapshots, so it neither blocks nor samples on the request path.
type MetricsProvider interface {
	// Snapshots returns the retained history (oldest-first) plus the latest
	// snapshot under one lock, so the response cannot mix a history and a newer
	// latest observed across two separate reads.
	Snapshots() (history []metrics.Snapshot, latest metrics.Snapshot, hasLatest bool)
}

// MetricsController owns the /metrics route.
type MetricsController struct {
	Provider MetricsProvider
}

// MetricsResponse is the wire shape for GET /api/v1/metrics: the latest
// snapshot plus a short history (oldest-first). Latest is nil-omitted until the
// observer has produced its first snapshot.
type MetricsResponse struct {
	// Latest is the most recent snapshot, or absent before the first tick.
	Latest *metrics.Snapshot `json:"latest,omitempty"`
	// History is the retained recent snapshots, oldest-first.
	History []metrics.Snapshot `json:"history"`
}

// Register mounts the metrics route on the supplied router.
func (c *MetricsController) Register(r chi.Router) {
	r.Get("/metrics", c.get)
}

func (c *MetricsController) get(w http.ResponseWriter, r *http.Request) {
	if c.Provider == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/metrics")
		return
	}
	history, latest, ok := c.Provider.Snapshots()
	resp := MetricsResponse{History: history}
	if ok {
		resp.Latest = &latest
	}
	if resp.History == nil {
		resp.History = []metrics.Snapshot{}
	}
	envelope.WriteJSON(w, http.StatusOK, resp)
}
