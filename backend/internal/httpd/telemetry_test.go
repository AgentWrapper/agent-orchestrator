package httpd

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
)

func TestCLIInvokedRouteEmitsTelemetry(t *testing.T) {
	sink := &captureSink{}
	r := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{Telemetry: sink}, ControlDeps{})

	postInvoked := func(command, commandPath string) {
		t.Helper()
		body := `{"command":"` + command + `","commandPath":"` + commandPath + `"}`
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal/telemetry/cli-invoked", strings.NewReader(body))
		req.Host = "127.0.0.1:3001"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202", rec.Code)
		}
	}

	postInvoked("status", "ao status")
	if len(sink.events) != 2 {
		t.Fatalf("events = %d, want 2", len(sink.events))
	}
	if sink.events[0].Name != "ao.cli.invoked" {
		t.Fatalf("event name = %q, want ao.cli.invoked", sink.events[0].Name)
	}
	if got := sink.events[0].Payload["command_path"]; got != "ao status" {
		t.Fatalf("command_path = %#v, want ao status", got)
	}
	if sink.events[1].Name != "ao.app.active" {
		t.Fatalf("second event name = %q, want ao.app.active", sink.events[1].Name)
	}
	if got := sink.events[1].Payload["channel"]; got != "cli" {
		t.Fatalf("channel = %#v, want cli", got)
	}

	// Repeat invocations of the same command the same day are polling noise:
	// both the per-command invocation event and the daily activity heartbeat
	// stay silent.
	postInvoked("status", "ao status")
	if len(sink.events) != 2 {
		t.Fatalf("events after repeat invocation = %d, want 2", len(sink.events))
	}

	// A different command the same day still reports its first invocation, but
	// no additional heartbeat.
	postInvoked("ls", "ao session ls")
	if len(sink.events) != 3 {
		t.Fatalf("events after new command = %d, want 3", len(sink.events))
	}
	if sink.events[2].Name != "ao.cli.invoked" {
		t.Fatalf("third event name = %q, want ao.cli.invoked", sink.events[2].Name)
	}
	if got := sink.events[2].Payload["command_path"]; got != "ao session ls" {
		t.Fatalf("command_path = %#v, want ao session ls", got)
	}
}

func TestCLIInvokedRouteRequiresLoopback(t *testing.T) {
	sink := &captureSink{}
	r := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{Telemetry: sink}, ControlDeps{})

	req := httptest.NewRequest(http.MethodPost, "http://evil.example/internal/telemetry/cli-invoked", strings.NewReader(`{"command":"status","commandPath":"ao status"}`))
	req.Host = "evil.example"
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if len(sink.events) != 0 {
		t.Fatalf("events = %d, want 0", len(sink.events))
	}
}

func TestCLIUsageErrorRouteEmitsTelemetry(t *testing.T) {
	sink := &captureSink{}
	r := chi.NewRouter()
	mountTelemetry(r, sink)

	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal/telemetry/cli-usage-error", strings.NewReader(`{"command":"status","commandPath":"ao status","error":"too many args"}`))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if len(sink.events) != 1 || sink.events[0].Name != "ao.cli.usage_errors" {
		t.Fatalf("events = %#v, want one ao.cli.usage_errors event", sink.events)
	}
	payload := sink.events[0].Payload
	if got := payload["component"]; got != "cli" {
		t.Fatalf("payload.component = %#v, want cli", got)
	}
	if got := payload["operation"]; got != "command_parse" {
		t.Fatalf("payload.operation = %#v, want command_parse", got)
	}
	if got := payload["command_path"]; got != "ao status" {
		t.Fatalf("payload.command_path = %#v, want ao status", got)
	}
	if got := payload["error_kind"]; got != "usage" {
		t.Fatalf("payload.error_kind = %#v, want usage", got)
	}
	if got := payload["fingerprint"]; got == "" {
		t.Fatalf("payload.fingerprint = %#v, want non-empty", got)
	}
	if _, ok := payload["error"]; ok {
		t.Fatalf("payload leaked raw error text: %#v", payload)
	}
}

func TestRecoverTelemetryEmitsPanicEvent(t *testing.T) {
	sink := &captureSink{}
	r := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{Telemetry: sink}, ControlDeps{})
	r.Get("/panic", func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})

	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/panic", nil)
	req.Host = "127.0.0.1:3001"
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var panicPayload, fiveXXPayload map[string]any
	for _, ev := range sink.events {
		switch ev.Name {
		case "ao.daemon.panic":
			panicPayload = ev.Payload
		case "ao.http.5xx":
			fiveXXPayload = ev.Payload
		}
	}
	if panicPayload == nil {
		t.Fatalf("events = %#v, want ao.daemon.panic", sink.events)
	}
	if fiveXXPayload == nil {
		t.Fatalf("events = %#v, want ao.http.5xx after recovery", sink.events)
	}
	if got := panicPayload["component"]; got != "httpd" {
		t.Fatalf("panic payload.component = %#v, want httpd", got)
	}
	if got := panicPayload["operation"]; got != "http_request_panic" {
		t.Fatalf("panic payload.operation = %#v, want http_request_panic", got)
	}
	if got := panicPayload["path"]; got != "/panic" {
		t.Fatalf("panic payload.path = %#v, want /panic", got)
	}
	if got := panicPayload["panic_kind"]; got != "string" {
		t.Fatalf("panic payload.panic_kind = %#v, want string", got)
	}
	if got := panicPayload["fingerprint"]; got == "" {
		t.Fatalf("panic payload.fingerprint = %#v, want non-empty", got)
	}
	if got := panicPayload["stack_fingerprint"]; got == "" {
		t.Fatalf("panic payload.stack_fingerprint = %#v, want non-empty", got)
	}
	if got := fiveXXPayload["path"]; got != "/panic" {
		t.Fatalf("5xx payload.path = %#v, want /panic", got)
	}
	if got := fiveXXPayload["status_family"]; got != "5xx" {
		t.Fatalf("5xx payload.status_family = %#v, want 5xx", got)
	}
}
