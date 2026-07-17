package httpd

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"reflect"
	"syscall"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

func TestLANManagerSpecifiedPortUsesIPv4Wildcard(t *testing.T) {
	t.Parallel()
	ln := newIPv4WildcardListener(t)
	port := ln.Addr().(*net.TCPAddr).Port
	var calls []listenCall

	m := NewLANManager(http.NotFoundHandler(), &authState{}, port, slog.Default())
	m.listen = func(network, address string) (net.Listener, error) {
		calls = append(calls, listenCall{network: network, address: address})
		return ln, nil
	}
	bound, err := m.Start(port)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer m.Stop(context.Background())

	if bound != port {
		t.Fatalf("bound port = %d, want specified port %d", bound, port)
	}
	assertListenCalls(t, calls, []listenCall{{network: "tcp4", address: fmt.Sprintf("0.0.0.0:%d", port)}})
	assertIPv4WildcardListener(t, m.ln)
	assertIPv4LoopbackReachable(t, bound)
}

func TestLANManagerPortConflictFallbackUsesIPv4Wildcard(t *testing.T) {
	t.Parallel()
	fallback := newIPv4WildcardListener(t)
	fallbackPort := fallback.Addr().(*net.TCPAddr).Port
	const wantedPort = 3011
	var calls []listenCall

	m := NewLANManager(http.NotFoundHandler(), &authState{}, wantedPort, slog.Default())
	m.listen = func(network, address string) (net.Listener, error) {
		calls = append(calls, listenCall{network: network, address: address})
		if len(calls) == 1 {
			return nil, syscall.EADDRINUSE
		}
		return fallback, nil
	}
	bound, err := m.Start(wantedPort)
	if err != nil {
		t.Fatalf("start with occupied port: %v", err)
	}
	defer m.Stop(context.Background())

	if bound != fallbackPort {
		t.Fatalf("bound port = %d, want fallback listener port %d", bound, fallbackPort)
	}
	assertListenCalls(t, calls, []listenCall{
		{network: "tcp4", address: "0.0.0.0:3011"},
		{network: "tcp4", address: "0.0.0.0:0"},
	})
	assertIPv4WildcardListener(t, m.ln)
	assertIPv4LoopbackReachable(t, bound)
}

type listenCall struct {
	network string
	address string
}

func newIPv4WildcardListener(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatalf("pre-bind IPv4 wildcard listener: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return ln
}

func assertListenCalls(t *testing.T, got, want []listenCall) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("listen calls = %#v, want %#v", got, want)
	}
}

func assertIPv4WildcardListener(t *testing.T, ln net.Listener) {
	t.Helper()
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("listener address type = %T, want *net.TCPAddr", ln.Addr())
	}
	if !addr.IP.IsUnspecified() {
		t.Fatalf("listener address = %s, want wildcard", addr)
	}
	if addr.IP.To4() == nil {
		t.Fatalf("listener address = %s, want IPv4 wildcard", addr)
	}
}

func assertIPv4LoopbackReachable(t *testing.T, port int) {
	t.Helper()
	conn, err := net.DialTimeout("tcp4", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		t.Fatalf("dial IPv4 loopback: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("close IPv4 loopback connection: %v", err)
	}
}

func TestLANManagerAuthGatesSharedHandler(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	})
	st := &authState{}
	st.setHash(mobilebridge.HashPassword("secret12"))
	m := NewLANManager(inner, st, 0, slog.Default()) // port 0 → ephemeral
	port, err := m.Start(0)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer m.Stop(context.Background())
	if !m.Running() || m.BoundPort() != port {
		t.Fatalf("running=%v boundPort=%d port=%d", m.Running(), m.BoundPort(), port)
	}

	base := fmt.Sprintf("http://127.0.0.1:%d/anything", port)
	// no auth → 401
	resp, _ := http.Get(base)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-auth: got %d want 401", resp.StatusCode)
	}
	// with auth → 200
	req, _ := http.NewRequest(http.MethodGet, base, nil)
	req.Header.Set("Authorization", "Bearer secret12")
	resp2, _ := http.DefaultClient.Do(req)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("auth: got %d want 200", resp2.StatusCode)
	}
}

// TestLANManagerBlocksLoopbackOnlyControlRoutes proves the LAN listener never
// serves /shutdown, /internal/*, or /api/v1/mobile* — even when the request
// carries a spoofed Host: 127.0.0.1 and valid LAN auth, since gating on Host
// alone (localControlRequest) is what let a LAN client reach these routes.
func TestLANManagerBlocksLoopbackOnlyControlRoutes(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	})
	st := &authState{}
	st.setHash(mobilebridge.HashPassword("secret12"))
	m := NewLANManager(inner, st, 0, slog.Default())
	port, err := m.Start(0)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer m.Stop(context.Background())

	blocked := []string{
		"/shutdown",
		"/internal/telemetry/cli-invoked",
		"/api/v1/mobile/status",
	}
	for _, path := range blocked {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
		req.Host = "127.0.0.1" // spoofed loopback Host
		req.Header.Set("Authorization", "Bearer secret12")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s: request failed: %v", path, err)
		}
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: got %d want 404 (Host-spoof + valid auth must not reach control routes)", path, resp.StatusCode)
		}
	}

	// A normal app route must still be reachable through the LAN listener
	// (not swallowed by the control-route filter). Auth-gating, not the
	// control filter, decides its fate.
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/v1/sessions", port), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("sessions: request failed: %v", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		t.Fatalf("/api/v1/sessions: got 404, should not be blocked by the control-route filter")
	}
}

func TestLANManagerStartStopIdempotent(t *testing.T) {
	m := NewLANManager(http.NotFoundHandler(), &authState{}, 0, slog.Default())
	p1, _ := m.Start(0)
	p2, _ := m.Start(0) // idempotent — same port, no error
	if p1 != p2 {
		t.Fatalf("second start changed port: %d != %d", p1, p2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := m.Stop(ctx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if m.Running() {
		t.Fatal("still running after stop")
	}
	_ = m.Stop(ctx) // second stop is a no-op
}
