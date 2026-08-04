package controllers_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentstream"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
)

func TestAgentStreamSSEReplaysAndLives(t *testing.T) {
	hub := agentstream.NewHub()
	hub.ConfigureSession("sess-1", agentstream.Source{
		Kind: agentstream.SourceKindNativeACPv1, Provider: "test",
	})
	hub.PublishBridge("sess-1", agentstream.BridgeEvent{Event: "delta", Text: "hello"})
	hub.PublishACPSessionUpdate("sess-1", agentstream.ACPSessionUpdate{
		SessionUpdate: "agent_thought_chunk",
		Content:       map[string]any{"type": "text", "text": "think"},
	})

	c := &controllers.AgentStreamController{Stream: hub}
	r := chi.NewRouter()
	r.Route("/api/v1", func(api chi.Router) {
		c.RegisterStreams(api)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/sess-1/agent-stream?after=-1", nil)
	// Cancel after we have read the buffered frames so the handler exits.
	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.ServeHTTP(rec, req)
	}()

	// Wait for headers + body.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rec.Code != 0 && rec.Body.Len() > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q", ct)
	}

	// Publish a live event.
	hub.PublishBridge("sess-1", agentstream.BridgeEvent{Event: "done", StopReason: "end_turn"})

	// Wait until we see done in the body.
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(rec.Body.String(), `"type":"done"`) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done

	events := parseAgentStreamSSE(t, rec.Body.String())
	if len(events) < 3 {
		t.Fatalf("events = %d, want >= 3; body=%s", len(events), rec.Body.String())
	}
	if events[0].Type != "text_delta" || events[0].Delta != "hello" {
		t.Fatalf("first = %+v", events[0])
	}
	if events[0].Sequence != 0 {
		t.Fatalf("first sequence = %d", events[0].Sequence)
	}
	if events[1].Type != "thinking_update" {
		t.Fatalf("second = %+v", events[1])
	}
	foundDone := false
	for _, e := range events {
		if e.Type == "done" {
			foundDone = true
			if !e.IsTerminalLike() {
				// not on DTO; check type only
			}
		}
	}
	if !foundDone {
		t.Fatalf("missing done event in %v", events)
	}
}

func TestAgentStreamNilReturns501(t *testing.T) {
	c := &controllers.AgentStreamController{Stream: nil}
	r := chi.NewRouter()
	r.Route("/api/v1", func(api chi.Router) {
		c.RegisterStreams(api)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/x/agent-stream", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
}

func TestAgentStreamAfterSkipsApplied(t *testing.T) {
	hub := agentstream.NewHub()
	hub.ConfigureSession("s", agentstream.Source{Kind: agentstream.SourceKindNativeACPv1})
	hub.PublishBridge("s", agentstream.BridgeEvent{Event: "delta", Text: "a"})
	hub.PublishBridge("s", agentstream.BridgeEvent{Event: "delta", Text: "b"})

	c := &controllers.AgentStreamController{Stream: hub}
	r := chi.NewRouter()
	r.Route("/api/v1", func(api chi.Router) {
		c.RegisterStreams(api)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/s/agent-stream?after=0", nil)
	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.ServeHTTP(rec, req)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(rec.Body.String(), `"delta":"b"`) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done

	events := parseAgentStreamSSE(t, rec.Body.String())
	if len(events) != 1 || events[0].Delta != "b" || events[0].Sequence != 1 {
		t.Fatalf("events = %+v", events)
	}
}

type streamFrame struct {
	Type     string `json:"type"`
	Delta    string `json:"delta"`
	Sequence int64  `json:"sequence"`
}

func (f streamFrame) IsTerminalLike() bool {
	return f.Type == "done" || f.Type == "error" || f.Type == "cancelled"
}

func parseAgentStreamSSE(t *testing.T, body string) []streamFrame {
	t.Helper()
	var out []streamFrame
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		raw := strings.TrimPrefix(line, "data: ")
		var f streamFrame
		if err := json.Unmarshal([]byte(raw), &f); err != nil {
			t.Fatalf("unmarshal %q: %v", raw, err)
		}
		out = append(out, f)
	}
	return out
}
