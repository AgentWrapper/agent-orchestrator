package httpd

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

// terminalMuxReadLimit caps a single inbound frame. Client→server frames are small
// (keystrokes, resize, control), so a generous 1 MiB is ample headroom while
// still bounding memory per message.
const terminalMuxReadLimit = 1 << 20

// MountTerminalMux registers the long-lived terminal-multiplexing WebSocket at /mux. It
// is intentionally outside the per-request Timeout middleware (the connection is
// long-lived). When mgr is nil the route is not mounted — the daemon simply has
// no terminal surface yet.
func MountTerminalMux(r chi.Router, mgr *terminal.Manager, log *slog.Logger) {
	if mgr == nil {
		return
	}
	r.Get("/mux", terminalMuxHandler(mgr, log))
}

// terminalMuxHandler upgrades the request to a WebSocket and hands the connection to the
// terminal manager. httpd owns only the upgrade and the transport adaptation;
// all stream logic lives in internal/terminal.
func terminalMuxHandler(mgr *terminal.Manager, log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// InsecureSkipVerify disables coder/websocket's same-origin check: the
		// daemon binds loopback only and the desktop renderer's origin differs
		// from the loopback host, mirroring the legacy Node mux server.
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			log.Warn("terminal mux: websocket upgrade failed", "err", err)
			return
		}
		c.SetReadLimit(terminalMuxReadLimit)
		mgr.Serve(r.Context(), &terminalMuxConn{c: c})
	}
}

// terminalMuxConn adapts a coder/websocket connection to terminal.wsConn. JSON framing
// uses wsjson (text messages); Ping is a control frame; Close sends a normal
// closure.
type terminalMuxConn struct{ c *websocket.Conn }

func (a *terminalMuxConn) ReadJSON(ctx context.Context, v any) error { return wsjson.Read(ctx, a.c, v) }
func (a *terminalMuxConn) WriteJSON(ctx context.Context, v any) error {
	return wsjson.Write(ctx, a.c, v)
}
func (a *terminalMuxConn) Ping(ctx context.Context) error { return a.c.Ping(ctx) }
func (a *terminalMuxConn) Close(reason string) error {
	return a.c.Close(websocket.StatusNormalClosure, reason)
}
