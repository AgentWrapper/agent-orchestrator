package busclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/busproto"
)

type sendCall struct{ id, msg string }

type fakeExec struct {
	sends  chan sendCall
	kills  chan string
	spawns chan json.RawMessage
	owned  []busproto.SessionRef
}

func newFakeExec() *fakeExec {
	return &fakeExec{
		sends:  make(chan sendCall, 4),
		kills:  make(chan string, 4),
		spawns: make(chan json.RawMessage, 4),
	}
}

func (f *fakeExec) Send(_ context.Context, id, msg string) error {
	f.sends <- sendCall{id, msg}
	return nil
}
func (f *fakeExec) Kill(_ context.Context, id string) error { f.kills <- id; return nil }
func (f *fakeExec) Spawn(_ context.Context, spec json.RawMessage) (string, error) {
	f.spawns <- spec
	return "new-session", nil
}
func (f *fakeExec) OwnedSessions(_ context.Context) ([]busproto.SessionRef, error) {
	return f.owned, nil
}

func TestClient_DisabledIsNoop(t *testing.T) {
	c := New(Config{}, newFakeExec(), nil)
	if c.cfg.Enabled() {
		t.Fatal("empty URL should be disabled")
	}
	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("disabled Run should return nil, got %v", err)
	}
}

// A daemon dials the stream, gets registered, and executes a pushed command.
func TestClient_StreamExecutesCommandAndRegisters(t *testing.T) {
	var (
		mu           sync.Mutex
		registered   bool
		sawAuth      bool
		sawTenant    string
		registerBody map[string]any
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/cloud/bus/register":
			mu.Lock()
			registered = true
			sawAuth = r.Header.Get("Authorization") == "Bearer tok"
			sawTenant = r.Header.Get("X-AO-Tenant")
			_ = json.NewDecoder(r.Body).Decode(&registerBody)
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/api/v1/cloud/bus/stream":
			fl, _ := w.(http.Flusher)
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			io.WriteString(w, ": connected\n\n")
			fl.Flush()
			// Push one command frame.
			frame, _ := json.Marshal(busproto.Frame{
				Type:    busproto.FrameCommand,
				Command: &busproto.Command{Op: "send", SessionID: "w1", Message: "hello"},
			})
			io.WriteString(w, "data: "+string(frame)+"\n\n")
			fl.Flush()
			<-r.Context().Done() // hold open until the client cancels
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	exec := newFakeExec()
	exec.owned = []busproto.SessionRef{{SessionID: "w1", Kind: "worker"}}
	c := New(Config{
		ControlPlaneURL: srv.URL,
		Token:           "tok",
		Tenant:          "acme",
		DaemonID:        "d1",
		ReconnectMin:    10 * time.Millisecond,
	}, exec, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Run(ctx) }()

	select {
	case got := <-exec.sends:
		if got.id != "w1" || got.msg != "hello" {
			t.Fatalf("executed %+v, want {w1 hello}", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("command was not executed within 2s")
	}

	// Wait for the async register (must finish before we cancel — it runs on the
	// same ctx).
	deadline := time.After(2 * time.Second)
	for {
		mu.Lock()
		done := registered
		mu.Unlock()
		if done {
			break
		}
		select {
		case <-deadline:
			t.Fatal("daemon never registered")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	mu.Lock()
	defer mu.Unlock()
	if !sawAuth {
		t.Error("register missing Bearer auth")
	}
	if sawTenant != "acme" {
		t.Errorf("register X-AO-Tenant = %q", sawTenant)
	}
	if registerBody["daemonId"] != "d1" {
		t.Errorf("register daemonId = %v", registerBody["daemonId"])
	}
}

func TestClient_RouteAndEmit(t *testing.T) {
	type hit struct {
		path string
		body map[string]any
	}
	hits := make(chan hit, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		hits <- hit{r.URL.Path, b}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(Config{ControlPlaneURL: srv.URL, DaemonID: "d1"}, newFakeExec(), nil)
	if err := c.Route(context.Background(), busproto.Command{Op: "send", SessionID: "w9", Message: "yo"}); err != nil {
		t.Fatalf("route: %v", err)
	}
	if err := c.Emit(context.Background(), busproto.Event{FromSessionID: "w9", ToSessionID: "orch", Kind: "message"}); err != nil {
		t.Fatalf("emit: %v", err)
	}

	got := map[string]map[string]any{}
	for i := 0; i < 2; i++ {
		h := <-hits
		got[h.path] = h.body
	}
	if got["/api/v1/cloud/bus/route"]["sessionId"] != "w9" {
		t.Errorf("route body %+v", got["/api/v1/cloud/bus/route"])
	}
	if got["/api/v1/cloud/bus/event"]["toSessionId"] != "orch" {
		t.Errorf("event body %+v", got["/api/v1/cloud/bus/event"])
	}
}

func TestClient_PostJSONNon2xxErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"offline"}`))
	}))
	defer srv.Close()
	c := New(Config{ControlPlaneURL: srv.URL}, newFakeExec(), nil)
	if err := c.Route(context.Background(), busproto.Command{Op: "send", SessionID: "x"}); err == nil {
		t.Fatal("want error on 503")
	}
}
