package controllers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentstream"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// AgentStream is the per-session sequenced stream fan-out used by SSE clients.
// Implemented by agentstream.Hub.
type AgentStream interface {
	Subscribe(sessionID string, after int64) (replay []agentstream.Event, live <-chan agentstream.Event, unsubscribe func())
}

// AgentStreamController serves GET /sessions/{sessionId}/agent-stream.
//
// Clients reduce provider-neutral AgentStreamEvent values. They never speak
// ACP. Sequence is monotonic per session; reconnect with ?after=<last seq>
// (or Last-Event-ID) to skip already-applied events.
type AgentStreamController struct {
	Stream AgentStream
}

// RegisterStreams mounts the long-lived agent stream SSE route outside the
// REST request timeout group.
func (c *AgentStreamController) RegisterStreams(r chi.Router) {
	r.Get("/sessions/{sessionId}/agent-stream", c.stream)
}

func (c *AgentStreamController) stream(w http.ResponseWriter, r *http.Request) {
	if c.Stream == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}/agent-stream")
		return
	}

	after, err := parseAgentStreamAfter(r)
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_AFTER",
			"after must be an integer (use -1 to replay from the start)", nil)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "SSE_UNSUPPORTED",
			"Streaming is not supported by this server", nil)
		return
	}

	id := sessionID(r)
	replay, live, unsub := c.Stream.Subscribe(string(id), after)
	defer unsub()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	for _, ev := range replay {
		if err := writeAgentStreamSSE(w, flusher, ev); err != nil {
			return
		}
	}

	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-live:
			if !ok {
				return
			}
			if err := writeAgentStreamSSE(w, flusher, ev); err != nil {
				return
			}
		case <-keepAlive.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func parseAgentStreamAfter(r *http.Request) (int64, error) {
	raw := r.URL.Query().Get("after")
	if raw == "" {
		raw = r.Header.Get("Last-Event-ID")
	}
	if raw == "" {
		// Default: replay the whole in-memory buffer, then live events.
		// Reconnect clients should pass after=<last applied sequence> (or
		// Last-Event-ID) so already-reduced events are not re-applied.
		return -1, nil
	}
	seq, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, err
	}
	return seq, nil
}

func writeAgentStreamSSE(w http.ResponseWriter, flusher http.Flusher, ev agentstream.Event) error {
	// Wire as AgentStreamEventResponse so OpenAPI/TS types stay aligned.
	payload := AgentStreamEventFromDomain(ev)
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "id: %d\nevent: agent_stream\ndata: %s\n\n", ev.Sequence, data); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}
