package controlplane

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// ── Phase B · Turn 2: SSE(push) + POST(pull) transport ───────────────────────
//
// The daemon channel is Server-Sent Events (control plane → daemon: commands and
// events pushed down a held-open GET) plus POST (daemon → control plane:
// register / route / event). Together that's a bidirectional channel over plain
// HTTP — no WebSocket dependency, and it rides the same SSE path the app already
// uses for the terminal stream. The Hub is transport-agnostic; this is the wiring.

const busSendBuffer = 64

// sseConn is a daemonConn backed by a held-open SSE response: send() enqueues a
// frame that the stream handler drains to the wire.
type sseConn struct {
	ch   chan Frame
	done chan struct{}
}

func newSSEConn() *sseConn {
	return &sseConn{ch: make(chan Frame, busSendBuffer), done: make(chan struct{})}
}

func (c *sseConn) send(f Frame) error {
	select {
	case c.ch <- f:
		return nil
	case <-c.done:
		return errors.New("bus: daemon channel closed")
	default:
		return errors.New("bus: daemon channel backpressured")
	}
}

// busStream: the daemon holds this GET open; the hub pushes frames down it.
func (s *Server) busStream(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	daemonID := r.URL.Query().Get("daemonId")
	if daemonID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "daemonId required"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "streaming unsupported"})
		return
	}

	conn := newSSEConn()
	s.hub.Connect(tenant, daemonID, conn)
	defer func() {
		close(conn.done)
		s.hub.Disconnect(tenant, daemonID)
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	// Heartbeat so intermediaries don't idle-close the stream.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case f := <-conn.ch:
			buf, err := json.Marshal(f)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", buf)
			flusher.Flush()
		}
	}
}

// busRegister: a daemon announces the sessions it owns (populates the registry).
func (s *Server) busRegister(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	var in struct {
		DaemonID string       `json:"daemonId"`
		Sessions []SessionRef `json:"sessions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.DaemonID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "daemonId + sessions required"})
		return
	}
	s.hub.Register(tenant, in.DaemonID, in.Sessions)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": len(in.Sessions)})
}

// busRoute: a daemon forwards a command that targets a session it doesn't own;
// the hub routes it to whichever host does.
func (s *Server) busRoute(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	var cmd Command
	if err := json.NewDecoder(r.Body).Decode(&cmd); err != nil || cmd.SessionID == "" || cmd.Op == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "op + sessionId required"})
		return
	}
	if err := s.hub.RouteCommand(r.Context(), tenant, cmd); err != nil {
		s.busErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// busEvent: a daemon delivers an event a session emitted (e.g. worker→orchestrator).
func (s *Server) busEvent(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	var ev Event
	if err := json.NewDecoder(r.Body).Decode(&ev); err != nil || ev.ToSessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "toSessionId required"})
		return
	}
	if err := s.hub.DeliverEvent(r.Context(), tenant, ev); err != nil {
		s.busErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) busErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrSessionNotFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
	case errors.Is(err, ErrDaemonOffline):
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
	}
}
