package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestPostHogSinkCapturesEvent(t *testing.T) {
	requests := make(chan map[string]any, 1)
	sink, err := NewPostHogSink(t.TempDir(), "phc_test", "https://us.i.posthog.com", roundTripClient(func(req *http.Request) (*http.Response, error) {
		defer req.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			return nil, err
		}
		requests <- body
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       http.NoBody,
		}, nil
	}), nil)
	if err != nil {
		t.Fatalf("NewPostHogSink: %v", err)
	}

	projectID := domain.ProjectID("proj-1")
	sessionID := domain.SessionID("sess-1")
	sink.Emit(context.Background(), ports.TelemetryEvent{
		Name:       "ao.session.spawned",
		Source:     "session_service",
		OccurredAt: time.Unix(1700000000, 0).UTC(),
		Level:      ports.TelemetryLevelInfo,
		ProjectID:  &projectID,
		SessionID:  &sessionID,
		RequestID:  "req-1",
		Payload: map[string]any{
			"kind": "worker",
		},
	})
	if err := sink.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}

	select {
	case req := <-requests:
		if got := req["event"]; got != "ao.session.spawned" {
			t.Fatalf("event = %#v, want ao.session.spawned", got)
		}
		props, ok := req["properties"].(map[string]any)
		if !ok {
			t.Fatalf("properties type = %T, want map[string]any", req["properties"])
		}
		if props["kind"] != "worker" {
			t.Fatalf("properties.kind = %#v, want worker", props["kind"])
		}
		if props["project_id_hash"] == "" || props["session_id_hash"] == "" {
			t.Fatalf("hashed ids missing from properties: %#v", props)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("PostHog sink did not send request")
	}
}

func TestPostHogSinkSanitizesPayloads(t *testing.T) {
	requests := make(chan map[string]any, 1)
	sink, err := NewPostHogSink(t.TempDir(), "phc_test", "https://us.i.posthog.com", roundTripClient(func(req *http.Request) (*http.Response, error) {
		defer req.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			return nil, err
		}
		requests <- body
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       http.NoBody,
		}, nil
	}), nil)
	if err != nil {
		t.Fatalf("NewPostHogSink: %v", err)
	}

	sink.Emit(context.Background(), ports.TelemetryEvent{
		Name:       "ao.daemon.panic",
		Source:     "http",
		OccurredAt: time.Unix(1700000000, 0).UTC(),
		Level:      ports.TelemetryLevelError,
		Payload: map[string]any{
			"component":         "httpd",
			"operation":         "http_request_panic",
			"method":            http.MethodGet,
			"path":              "/api/v1/sessions/demo",
			"panic_kind":        "error",
			"fingerprint":       "abc123",
			"stack_fingerprint": "def456",
			"panic":             "open /Users/name/private: no such file",
			"stack":             "stack trace with local path",
		},
	})
	if err := sink.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}

	select {
	case req := <-requests:
		props, ok := req["properties"].(map[string]any)
		if !ok {
			t.Fatalf("properties type = %T, want map[string]any", req["properties"])
		}
		if props["component"] != "httpd" || props["operation"] != "http_request_panic" {
			t.Fatalf("sanitized properties = %#v, want allowlisted metadata", props)
		}
		if props["method"] != http.MethodGet || props["path"] != "/api/v1/sessions/demo" || props["panic_kind"] != "error" {
			t.Fatalf("sanitized properties = %#v, want allowlisted fields", props)
		}
		if props["fingerprint"] != "abc123" || props["stack_fingerprint"] != "def456" {
			t.Fatalf("sanitized properties = %#v, want exported fingerprints", props)
		}
		if _, ok := props["panic"]; ok {
			t.Fatalf("panic property should be dropped: %#v", props)
		}
		if _, ok := props["stack"]; ok {
			t.Fatalf("stack property should be dropped: %#v", props)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("PostHog sink did not send request")
	}
}

func TestPostHogSinkSanitizesAppActivePayload(t *testing.T) {
	requests := make(chan map[string]any, 1)
	sink, err := NewPostHogSink(t.TempDir(), "phc_test", "https://us.i.posthog.com", roundTripClient(func(req *http.Request) (*http.Response, error) {
		defer req.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			return nil, err
		}
		requests <- body
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       http.NoBody,
		}, nil
	}), nil)
	if err != nil {
		t.Fatalf("NewPostHogSink: %v", err)
	}

	sink.Emit(context.Background(), ports.TelemetryEvent{
		Name:       "ao.app.active",
		Source:     "cli",
		OccurredAt: time.Unix(1700000000, 0).UTC(),
		Level:      ports.TelemetryLevelInfo,
		Payload: map[string]any{
			"channel":      "cli",
			"command":      "spawn",
			"command_path": "ao spawn",
			"ip":           "203.0.113.10",
			"country":      "US",
			"city":         "San Francisco",
			"latitude":     37.7749,
			"longitude":    -122.4194,
		},
	})
	if err := sink.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}

	select {
	case req := <-requests:
		props, ok := req["properties"].(map[string]any)
		if !ok {
			t.Fatalf("properties type = %T, want map[string]any", req["properties"])
		}
		if props["channel"] != "cli" || props["command"] != "spawn" || props["command_path"] != "ao spawn" {
			t.Fatalf("sanitized properties = %#v, want active CLI metadata", props)
		}
		for _, key := range []string{"ip", "country", "city", "latitude", "longitude"} {
			if _, ok := props[key]; ok {
				t.Fatalf("%s property should be dropped: %#v", key, props)
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("PostHog sink did not send request")
	}
}

type roundTripClient func(*http.Request) (*http.Response, error)

func (f roundTripClient) Do(req *http.Request) (*http.Response, error) { return f(req) }

var _ postHogClient = roundTripClient(nil)
