package controlplane

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud"
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
	// A scoped bus token may only hold open ITS OWN daemon channel. (Audit #4.)
	if scope, scoped := BusScopeFromContext(r.Context()); scoped && scope != daemonID {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "bus token not scoped to this daemon"})
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
		s.hub.Disconnect(tenant, daemonID, conn) // compare-and-delete: only if still ours
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	// Heartbeat so intermediaries don't idle-close the stream.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case f := <-conn.ch:
			buf, err := json.Marshal(f)
			if err != nil {
				continue
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", buf)
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
	// A scoped bus token may only register under its OWN sandbox/daemon id — it
	// can't impersonate another daemon. (Audit #4; full user tokens are unscoped.)
	if scope, scoped := BusScopeFromContext(r.Context()); scoped && scope != in.DaemonID {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "bus token not scoped to this daemon"})
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
	if scope, scoped := BusScopeFromContext(r.Context()); scoped && !s.hub.AuthorizeBusTarget(tenant, scope, cmd.SessionID) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "bus token not authorized for this target"})
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
	if scope, scoped := BusScopeFromContext(r.Context()); scoped && !s.hub.AuthorizeBusTarget(tenant, scope, ev.ToSessionID) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "bus token not authorized for this target"})
		return
	}
	if err := s.hub.DeliverEvent(r.Context(), tenant, ev); err != nil {
		s.busErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// busToken mints a tenant-scoped bus token for a laptop daemon. The caller is
// already authenticated with a real user JWT (user-auth group), so this just
// exchanges it for a longer-lived token the daemon presents on the bus.
func (s *Server) busToken(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	if s.busSigner == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "bus token signing not configured"})
		return
	}
	var in struct {
		DaemonID string `json:"daemonId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in) // body optional
	tok, err := s.busSigner.MintForSandbox(tenant, in.DaemonID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": tok, "expiresInSeconds": int(12 * time.Hour / time.Second)})
}

// busLocations returns every session the tenant owns across locations — the
// cross-location fleet view an orchestrator uses to discover and address workers
// that live in other sandboxes/daemons.
func (s *Server) busLocations(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	locs := s.locations.ListForTenant(tenant)
	// Join the supervisor's CloudSession registry (by sandboxId) so the fleet view
	// carries each cloud session's status/displayName/harness — "what it's doing",
	// not just that it exists.
	statusBySandbox := map[string]cloud.CloudSession{}
	if s.sup != nil {
		for _, cs := range s.sup.ListSessionsForTenant(tenant) {
			statusBySandbox[cs.SandboxID] = cs
		}
	}
	out := make([]map[string]any, 0, len(locs))
	for _, l := range locs {
		entry := map[string]any{
			"sessionId":          l.SessionID, // routing key (sandboxId for sandbox sessions)
			"kind":               l.Kind,
			"projectId":          l.ProjectID,
			"type":               string(l.Type),
			"sandboxId":          l.SandboxID,
			"inSandboxSessionId": l.InSandboxSessionID,
		}
		if cs, ok := statusBySandbox[l.SandboxID]; ok {
			entry["status"] = cs.Status
			entry["displayName"] = cs.DisplayName
			entry["harness"] = cs.Harness
		}
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
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
