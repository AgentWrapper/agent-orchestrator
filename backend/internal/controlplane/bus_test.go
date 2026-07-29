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
	// Routing key is the sandboxId; the in-sandbox session id (collides across
	// sandboxes) is stored separately and used for the relay.
	reg.Register(SessionLocation{
		SessionID: "sb-123", TenantID: "acme", Type: LocationSandbox,
		InSandboxSessionID: "proj-1", PreviewURL: "https://preview/sb",
	})
	if err := h.RouteCommand(context.Background(), "acme", Command{Op: "kill", SessionID: "sb-123"}); err != nil {
		t.Fatalf("route: %v", err)
	}
	if len(relay.cmds) != 1 || relay.cmds[0].url != "https://preview/sb" || relay.cmds[0].cmd.Op != "kill" {
		t.Fatalf("relay got %+v", relay.cmds)
	}
	// The command relayed INTO the sandbox must carry the in-sandbox session id,
	// not the sandboxId routing key.
	if relay.cmds[0].cmd.SessionID != "proj-1" {
		t.Fatalf("relay cmd sessionId = %q, want in-sandbox id proj-1", relay.cmds[0].cmd.SessionID)
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
	reg.Register(SessionLocation{
		SessionID: "sb-orch", TenantID: "acme", Type: LocationSandbox,
		InSandboxSessionID: "orch-local-1", PreviewURL: "https://preview/orch",
	})
	// A worker reports to the orchestrator by its routing key (sandboxId).
	if err := h.DeliverEvent(context.Background(), "acme", Event{FromSessionID: "w1", ToSessionID: "sb-orch"}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if len(relay.events) != 1 || relay.events[0].url != "https://preview/orch" {
		t.Fatalf("relay events %+v", relay.events)
	}
	// Delivered into the sandbox using the in-sandbox session id.
	if relay.events[0].ev.ToSessionID != "orch-local-1" {
		t.Fatalf("relay event ToSessionID = %q, want in-sandbox id orch-local-1", relay.events[0].ev.ToSessionID)
	}
}

func TestHub_DisconnectRemovesSessions(t *testing.T) {
	h, _, _ := newTestHub()
	c := &fakeConn{}
	h.Connect("acme", "daemon-A", c)
	h.Register("acme", "daemon-A", []SessionRef{{SessionID: "w1", Kind: "worker"}})

	h.Disconnect("acme", "daemon-A", c)

	if err := h.RouteCommand(context.Background(), "acme", Command{Op: "send", SessionID: "w1"}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("after disconnect want ErrSessionNotFound, got %v", err)
	}
}

// A stale stream's teardown must NOT clobber a daemon that reconnected with a new
// channel (audit #6/#11): Disconnect with the OLD conn is a no-op.
func TestHub_DisconnectStaleConnIsNoop(t *testing.T) {
	h, _, _ := newTestHub()
	oldC := &fakeConn{}
	h.Connect("acme", "daemon-A", oldC)
	newC := &fakeConn{}
	h.Connect("acme", "daemon-A", newC) // reconnect replaces the channel
	h.Register("acme", "daemon-A", []SessionRef{{SessionID: "w1", Kind: "worker"}})

	h.Disconnect("acme", "daemon-A", oldC) // stale teardown — must be ignored

	if err := h.RouteCommand(context.Background(), "acme", Command{Op: "send", SessionID: "w1", Message: "hi"}); err != nil {
		t.Fatalf("reconnected daemon should still route, got %v", err)
	}
	if len(newC.sent) != 1 {
		t.Fatalf("new channel should have received the command, got %d frames", len(newC.sent))
	}
}

// Two sandboxes whose in-sandbox session ids collide ("proj-1" each) must remain
// independently addressable via their distinct sandboxId routing keys — the bug
// the live run surfaced.
func TestHub_NoCollisionAcrossSandboxesWithSameInSandboxID(t *testing.T) {
	h, reg, relay := newTestHub()
	reg.Register(SessionLocation{SessionID: "sb-A", TenantID: "acme", Type: LocationSandbox, InSandboxSessionID: "proj-1", PreviewURL: "https://preview/A"})
	reg.Register(SessionLocation{SessionID: "sb-B", TenantID: "acme", Type: LocationSandbox, InSandboxSessionID: "proj-1", PreviewURL: "https://preview/B"})

	if err := h.RouteCommand(context.Background(), "acme", Command{Op: "send", SessionID: "sb-A", Message: "to-A"}); err != nil {
		t.Fatalf("route A: %v", err)
	}
	if err := h.RouteCommand(context.Background(), "acme", Command{Op: "send", SessionID: "sb-B", Message: "to-B"}); err != nil {
		t.Fatalf("route B: %v", err)
	}
	if len(relay.cmds) != 2 {
		t.Fatalf("want 2 relays, got %d", len(relay.cmds))
	}
	if relay.cmds[0].url != "https://preview/A" || relay.cmds[1].url != "https://preview/B" {
		t.Fatalf("collision: relays went to %q and %q", relay.cmds[0].url, relay.cmds[1].url)
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
