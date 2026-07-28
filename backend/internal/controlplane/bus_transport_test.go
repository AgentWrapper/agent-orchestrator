package controlplane

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// testServer builds a Server with just the bus wired (no sup/auth needed for the
// POST endpoints; the sandbox relay is a fake).
func testServer() (*Server, *fakeRelay) {
	reg := NewInMemoryLocationRegistry()
	relay := &fakeRelay{}
	return &Server{
		log:       slog.Default(),
		locations: reg,
		hub:       NewHub(reg, relay, nil),
	}, relay
}

// withTenant stamps the authenticated tenant the auth middleware would set.
func withTenant(r *http.Request, tenant string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), tenantContextKey{}, tenant))
}

func TestSSEConn_BufferBackpressureAndClose(t *testing.T) {
	c := newSSEConn()
	for i := 0; i < busSendBuffer; i++ {
		if err := c.send(Frame{Type: FrameEvent}); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	// Buffer full → backpressure, not a block.
	if err := c.send(Frame{Type: FrameEvent}); err == nil {
		t.Fatal("want backpressure error when buffer full")
	}
	close(c.done)
	if err := c.send(Frame{Type: FrameEvent}); err == nil {
		t.Fatal("want closed error after done")
	}
}

func TestBusRegister_PopulatesRegistry(t *testing.T) {
	s, _ := testServer()
	body := `{"daemonId":"d1","sessions":[{"sessionId":"w1","kind":"worker"}]}`
	req := withTenant(httptest.NewRequest("POST", "/api/v1/cloud/bus/register", strings.NewReader(body)), "acme")
	rec := httptest.NewRecorder()
	s.busRegister(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("register status %d", rec.Code)
	}
	if _, ok := s.locations.Lookup("acme", "w1"); !ok {
		t.Fatal("session not registered")
	}
}

func TestBusRoute_ToConnectedDaemon(t *testing.T) {
	s, _ := testServer()
	conn := &fakeConn{}
	s.hub.Connect("acme", "d1", conn)
	s.hub.Register("acme", "d1", []SessionRef{{SessionID: "w1", Kind: "worker"}})

	body := `{"op":"send","sessionId":"w1","message":"hello"}`
	req := withTenant(httptest.NewRequest("POST", "/api/v1/cloud/bus/route", strings.NewReader(body)), "acme")
	rec := httptest.NewRecorder()
	s.busRoute(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("route status %d", rec.Code)
	}
	if len(conn.sent) != 1 || conn.sent[0].Command.Message != "hello" {
		t.Fatalf("daemon got %+v", conn.sent)
	}
}

func TestBusRoute_UnknownSession404(t *testing.T) {
	s, _ := testServer()
	req := withTenant(httptest.NewRequest("POST", "/api/v1/cloud/bus/route", strings.NewReader(`{"op":"send","sessionId":"ghost"}`)), "acme")
	rec := httptest.NewRecorder()
	s.busRoute(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404 for unknown session, got %d", rec.Code)
	}
}

func TestBusRoute_DaemonOffline503(t *testing.T) {
	s, _ := testServer()
	s.hub.Register("acme", "ghost", []SessionRef{{SessionID: "w1"}}) // no live conn
	req := withTenant(httptest.NewRequest("POST", "/api/v1/cloud/bus/route", strings.NewReader(`{"op":"send","sessionId":"w1"}`)), "acme")
	rec := httptest.NewRecorder()
	s.busRoute(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 for offline daemon, got %d", rec.Code)
	}
}

func TestBusEvent_ToSandboxRelays(t *testing.T) {
	s, relay := testServer()
	s.locations.Register(SessionLocation{SessionID: "orch1", TenantID: "acme", Type: LocationSandbox, PreviewURL: "https://preview/o"})
	req := withTenant(httptest.NewRequest("POST", "/api/v1/cloud/bus/event", strings.NewReader(`{"fromSessionId":"w1","toSessionId":"orch1","kind":"message"}`)), "acme")
	rec := httptest.NewRecorder()
	s.busEvent(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("event status %d", rec.Code)
	}
	if len(relay.events) != 1 || relay.events[0].url != "https://preview/o" {
		t.Fatalf("relay events %+v", relay.events)
	}
}

func TestBusStream_RequiresDaemonID(t *testing.T) {
	s, _ := testServer()
	req := withTenant(httptest.NewRequest("GET", "/api/v1/cloud/bus/stream", nil), "acme")
	rec := httptest.NewRecorder()
	s.busStream(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 without daemonId, got %d", rec.Code)
	}
}
