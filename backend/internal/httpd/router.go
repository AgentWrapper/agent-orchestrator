// Package httpd builds and runs the daemon's HTTP surface: middleware, health
// probes, daemon control, REST APIs, and terminal WebSocket routing.
package httpd

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/daemonmeta"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
	"github.com/aoagents/agent-orchestrator/backend/internal/telemetrymeta"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

// ControlDeps carries the daemon-control hooks the router exposes, such as the
// callback that requests a graceful shutdown.
type ControlDeps struct {
	RequestShutdown func()
	ShutdownToken   string
}

// NewRouterWithControl builds the root router with the standard middleware
// stack, the API surface, and the daemon-control hooks wired from ControlDeps.
// Missing Managers in deps keep routes registered but return OpenAPI-backed 501
// responses.
//
// Middleware order (outermost first):
//
//	RequestID      → attach a request id for correlation
//	RealIP         → normalise client IP (loopback proxy from the dev server)
//	requestLogger  → slog-backed access log + 5xx telemetry, carries the request id
//	recoverer      → turn a handler panic into 500 instead of crashing the daemon
//	cors           → CORS allowlist for the Electron renderer / dev origins
//
// The per-request timeout is deliberately not global: it wraps only bounded
// REST routes, never long-lived terminal streams or health probes.
func NewRouterWithControl(cfg config.Config, log *slog.Logger, termMgr *terminal.Manager, deps APIDeps, control ControlDeps) chi.Router {
	log = loggerOrDefault(log)
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(requestLogger(log, deps.Telemetry))
	r.Use(recoverTelemetry(log, deps.Telemetry))
	r.Use(corsMiddleware(cfg.AllowedOrigins))

	// JSON envelopes for unmatched routes / methods — chi's defaults are
	// text/plain, which would break consumers that parse every response as
	// the locked APIError shape.
	r.NotFound(notFoundJSON)
	r.MethodNotAllowed(methodNotAllowedJSON)

	mountHealth(r)
	mountTerminalMux(r, termMgr, log)
	mountControl(r, control)
	mountTelemetry(r, deps.Telemetry)
	NewAPI(cfg, deps).Register(r)

	return r
}

// mountHealth registers the liveness and readiness probes the Electron
// supervisor polls before letting the renderer connect.
func mountHealth(r chi.Router) {
	r.Get("/healthz", handleHealthz)
	r.Get("/readyz", handleReadyz)
}

// mountControl registers the loopback daemon-control endpoints. /shutdown is a
// destructive operation, so it requires both a trusted loopback-shaped request
// and the daemon-issued token from running.json.
func mountControl(r chi.Router, deps ControlDeps) {
	if deps.RequestShutdown == nil {
		return
	}
	r.Post("/shutdown", func(w http.ResponseWriter, req *http.Request) {
		if !localControlRequest(req) || !validShutdownToken(req, deps.ShutdownToken) {
			envelope.WriteJSON(w, http.StatusForbidden, map[string]any{
				"status":  "forbidden",
				"service": daemonmeta.ServiceName,
			})
			return
		}
		envelope.WriteJSON(w, http.StatusAccepted, map[string]any{
			"status":  "shutting_down",
			"service": daemonmeta.ServiceName,
			"pid":     os.Getpid(),
		})
		deps.RequestShutdown()
	})
}

func validShutdownToken(req *http.Request, want string) bool {
	got := req.Header.Get(runfile.ShutdownTokenHeader)
	if got == "" || want == "" || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

type cliInvokedRequest struct {
	Command     string `json:"command"`
	CommandPath string `json:"commandPath"`
}

type cliUsageErrorRequest struct {
	Command     string `json:"command"`
	CommandPath string `json:"commandPath"`
	Error       string `json:"error"`
}

func mountTelemetry(r chi.Router, sink ports.EventSink) {
	if sink == nil {
		return
	}
	r.Post("/internal/telemetry/cli-invoked", func(w http.ResponseWriter, req *http.Request) {
		if !localControlRequest(req) {
			envelope.WriteJSON(w, http.StatusForbidden, map[string]any{
				"status":  "forbidden",
				"service": daemonmeta.ServiceName,
			})
			return
		}

		var body cliInvokedRequest
		dec := json.NewDecoder(req.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			envelope.WriteAPIError(w, req, http.StatusBadRequest, "bad_request", "INVALID_JSON", "request body must be valid JSON", nil)
			return
		}
		if body.CommandPath == "" {
			envelope.WriteAPIError(w, req, http.StatusBadRequest, "bad_request", "COMMAND_PATH_REQUIRED", "commandPath is required", nil)
			return
		}

		sink.Emit(req.Context(), ports.TelemetryEvent{
			Name:       "ao.cli.invoked",
			Source:     "cli",
			OccurredAt: time.Now().UTC(),
			Level:      ports.TelemetryLevelInfo,
			RequestID:  middleware.GetReqID(req.Context()),
			Payload: map[string]any{
				"command":      body.Command,
				"command_path": body.CommandPath,
			},
		})
		sink.Emit(req.Context(), ports.TelemetryEvent{
			Name:       "ao.app.active",
			Source:     "cli",
			OccurredAt: time.Now().UTC(),
			Level:      ports.TelemetryLevelInfo,
			RequestID:  middleware.GetReqID(req.Context()),
			Payload: map[string]any{
				"channel":      "cli",
				"command":      body.Command,
				"command_path": body.CommandPath,
			},
		})
		w.WriteHeader(http.StatusAccepted)
	})
	r.Post("/internal/telemetry/cli-usage-error", func(w http.ResponseWriter, req *http.Request) {
		if !localControlRequest(req) {
			envelope.WriteJSON(w, http.StatusForbidden, map[string]any{
				"status":  "forbidden",
				"service": daemonmeta.ServiceName,
			})
			return
		}

		var body cliUsageErrorRequest
		dec := json.NewDecoder(req.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			envelope.WriteAPIError(w, req, http.StatusBadRequest, "bad_request", "INVALID_JSON", "request body must be valid JSON", nil)
			return
		}
		if body.CommandPath == "" {
			envelope.WriteAPIError(w, req, http.StatusBadRequest, "bad_request", "COMMAND_PATH_REQUIRED", "commandPath is required", nil)
			return
		}

		sink.Emit(req.Context(), ports.TelemetryEvent{
			Name:       "ao.cli.usage_errors",
			Source:     "cli",
			OccurredAt: time.Now().UTC(),
			Level:      ports.TelemetryLevelWarn,
			RequestID:  middleware.GetReqID(req.Context()),
			Payload: map[string]any{
				"component":    "cli",
				"operation":    "command_parse",
				"command":      body.Command,
				"command_path": body.CommandPath,
				"error_kind":   "usage",
				"fingerprint":  telemetrymeta.Fingerprint("cli", "command_parse", body.CommandPath, "usage"),
			},
		})
		w.WriteHeader(http.StatusAccepted)
	})
}

// localControlRequest reports whether a control request is a trusted local
// caller. The Go CLI client addresses the daemon by its loopback host and
// never sets an Origin header; a cross-site browser fetch always carries an
// Origin, and a DNS-rebinding attempt resolves a non-loopback Host. Rejecting
// either closes the CSRF/rebinding vector while leaving the CLI unaffected.
func localControlRequest(r *http.Request) bool {
	if r.Header.Get("Origin") != "" {
		return false
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	switch host {
	case "127.0.0.1", "::1", "localhost":
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// handleHealthz is the liveness probe: it answers 200 as long as the process is
// up and serving. It does no dependency checks by design.
func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	envelope.WriteJSON(w, http.StatusOK, daemonProbePayload("ok"))
}

// handleReadyz is the readiness probe. Dependency initialization happens before
// the server is constructed, so a listening daemon is ready to answer requests.
func handleReadyz(w http.ResponseWriter, _ *http.Request) {
	envelope.WriteJSON(w, http.StatusOK, daemonProbePayload("ready"))
}

func daemonProbePayload(status string) map[string]any {
	payload := map[string]any{
		"status":  status,
		"service": daemonmeta.ServiceName,
		"pid":     os.Getpid(),
	}
	if exe, err := os.Executable(); err == nil && exe != "" {
		payload["executablePath"] = exe
	}
	if cwd, err := os.Getwd(); err == nil && cwd != "" {
		payload["workingDirectory"] = cwd
	}
	return payload
}
