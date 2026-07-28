package controlplane

import (
	"context"
	"errors"
	"testing"
)

type fakeConn struct{ sent []Frame }

func (c *fakeConn) send(f Frame) error { c.sent = append(c.sent, f); return nil }

type fakeRelay struct {
	cmds []struct {
		url string
		cmd Command
	}
	events []struct {
		url string
		ev  Event
	}
}

func (r *fakeRelay) Relay(_ context.Context, url string, cmd Command) error {
	r.cmds = append(r.cmds, struct {
		url string
		cmd Command
	}{url, cmd})
	return nil
}
func (r *fakeRelay) RelayEvent(_ context.Context, url string, ev Event) error {
	r.events = append(r.events, struct {
		url string
		ev  Event
	}{url, ev})
	return nil
}

func newTestHub() (*Hub, LocationRegistry, *fakeRelay) {
	reg := NewInMemoryLocationRegistry()
	relay := &fakeRelay{}
	return NewHub(reg, relay, nil), reg, relay
}

func TestHub_RouteCommandToDaemon(t *testing.T) {
	h, _, _ := newTestHub()
	c := &fakeConn{}
	h.Connect("acme", "daemon-A", c)
	h.Register("acme", "daemon-A", []SessionRef{{SessionID: "w1", Kind: "worker"}})

	err := h.RouteCommand(context.Background(), "acme", Command{Op: "send", SessionID: "w1", Message: "hi"})
	if err != nil {
		t.Fatalf("route: %v", err)
	}
	if len(c.sent) != 1 || c.sent[0].Type != FrameCommand || c.sent[0].Command.Message != "hi" {
		t.Fatalf("daemon conn got %+v", c.sent)
	}
}

func TestHub_RouteCommandToSandbox(t *testing.T) {
	h, reg, relay := newTestHub()
	reg.Register(SessionLocation{
		SessionID: "w2", TenantID: "acme", Type: LocationSandbox, PreviewURL: "https://preview/sb",
	})
	if err := h.RouteCommand(context.Background(), "acme", Command{Op: "kill", SessionID: "w2"}); err != nil {
		t.Fatalf("route: %v", err)
	}
	if len(relay.cmds) != 1 || relay.cmds[0].url != "https://preview/sb" || relay.cmds[0].cmd.Op != "kill" {
		t.Fatalf("relay got %+v", relay.cmds)
	}
}

func TestHub_RouteCommandUnknownSession(t *testing.T) {
	h, _, _ := newTestHub()
	if err := h.RouteCommand(context.Background(), "acme", Command{Op: "send", SessionID: "nope"}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("want ErrSessionNotFound, got %v", err)
	}
}

func TestHub_RouteCommandDaemonOffline(t *testing.T) {
	h, _, _ := newTestHub()
	// Session registered to a daemon, but that daemon has no live conn.
	h.Register("acme", "ghost", []SessionRef{{SessionID: "w3", Kind: "worker"}})
	if err := h.RouteCommand(context.Background(), "acme", Command{Op: "send", SessionID: "w3"}); !errors.Is(err, ErrDaemonOffline) {
		t.Fatalf("want ErrDaemonOffline, got %v", err)
	}
}

func TestHub_DeliverEventToOrchestratorOnDaemon(t *testing.T) {
	h, _, _ := newTestHub()
	orch := &fakeConn{}
	h.Connect("acme", "daemon-O", orch)
	h.Register("acme", "daemon-O", []SessionRef{{SessionID: "orch1", Kind: "orchestrator"}})

	ev := Event{FromSessionID: "w1", ToSessionID: "orch1", Kind: "message"}
	if err := h.DeliverEvent(context.Background(), "acme", ev); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if len(orch.sent) != 1 || orch.sent[0].Type != FrameEvent || orch.sent[0].Event.FromSessionID != "w1" {
		t.Fatalf("orchestrator got %+v", orch.sent)
	}
}

func TestHub_DeliverEventToSandbox(t *testing.T) {
	h, reg, relay := newTestHub()
	reg.Register(SessionLocation{SessionID: "orch1", TenantID: "acme", Type: LocationSandbox, PreviewURL: "https://preview/orch"})
	if err := h.DeliverEvent(context.Background(), "acme", Event{FromSessionID: "w1", ToSessionID: "orch1"}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if len(relay.events) != 1 || relay.events[0].url != "https://preview/orch" {
		t.Fatalf("relay events %+v", relay.events)
	}
}

func TestHub_DisconnectRemovesSessions(t *testing.T) {
	h, _, _ := newTestHub()
	c := &fakeConn{}
	h.Connect("acme", "daemon-A", c)
	h.Register("acme", "daemon-A", []SessionRef{{SessionID: "w1", Kind: "worker"}})

	h.Disconnect("acme", "daemon-A")

	if err := h.RouteCommand(context.Background(), "acme", Command{Op: "send", SessionID: "w1"}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("after disconnect want ErrSessionNotFound, got %v", err)
	}
}

func TestHub_TenantIsolationInRouting(t *testing.T) {
	h, _, _ := newTestHub()
	c := &fakeConn{}
	h.Connect("acme", "d", c)
	h.Register("acme", "d", []SessionRef{{SessionID: "w1", Kind: "worker"}})
	// Another tenant must not be able to route to acme's session.
	if err := h.RouteCommand(context.Background(), "other", Command{Op: "send", SessionID: "w1"}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("cross-tenant route should fail, got %v", err)
	}
}
