package session

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeRemoteRouter struct {
	routed   []struct{ id, msg string }
	err      error
	canRoute bool
}

func (f *fakeRemoteRouter) RouteSend(_ context.Context, id, msg string) error {
	if f.err != nil {
		return f.err
	}
	f.routed = append(f.routed, struct{ id, msg string }{id, msg})
	return nil
}

func (f *fakeRemoteRouter) CanRoute() bool { return f.canRoute }

func TestSend_RoutesRemoteWhenSessionNotLocal(t *testing.T) {
	fc := &fakeCommander{}
	st := newFakeStore()
	svc := NewWithDeps(Deps{Manager: fc, Store: st})
	rr := &fakeRemoteRouter{canRoute: true}
	svc.SetRemoteRouter(rr)

	if err := svc.Send(context.Background(), "remote-1", "hi"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(rr.routed) != 1 || rr.routed[0].id != "remote-1" || rr.routed[0].msg != "hi" {
		t.Fatalf("routed = %+v", rr.routed)
	}
	if len(fc.sent) != 0 {
		t.Fatalf("must not deliver locally for a non-local session, got %v", fc.sent)
	}
}

func TestSend_LocalWhenSessionKnown(t *testing.T) {
	fc := &fakeCommander{}
	st := newFakeStore()
	st.sessions["local-1"] = domain.SessionRecord{ID: "local-1"}
	svc := NewWithDeps(Deps{Manager: fc, Store: st})
	rr := &fakeRemoteRouter{canRoute: true}
	svc.SetRemoteRouter(rr)

	if err := svc.Send(context.Background(), "local-1", "hi"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(fc.sent) != 1 {
		t.Fatalf("should deliver a known session locally, sent=%v", fc.sent)
	}
	if len(rr.routed) != 0 {
		t.Fatalf("must not route a locally-known session, routed=%+v", rr.routed)
	}
}

func TestSend_NoRouterAlwaysLocal(t *testing.T) {
	fc := &fakeCommander{}
	st := newFakeStore()
	svc := NewWithDeps(Deps{Manager: fc, Store: st})
	if err := svc.Send(context.Background(), "whoever", "hi"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(fc.sent) != 1 {
		t.Fatalf("no router → local passthrough, sent=%v", fc.sent)
	}
}

func TestSend_UnconfiguredRouterStaysLocal(t *testing.T) {
	fc := &fakeCommander{}
	st := newFakeStore()
	svc := NewWithDeps(Deps{Manager: fc, Store: st})
	rr := &fakeRemoteRouter{canRoute: false} // bus present but not ready (signed out)
	svc.SetRemoteRouter(rr)

	if err := svc.Send(context.Background(), "unknown-1", "hi"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(rr.routed) != 0 {
		t.Fatalf("must not route when CanRoute() is false, routed=%+v", rr.routed)
	}
	if len(fc.sent) != 1 {
		t.Fatalf("should fall back to local delivery, sent=%v", fc.sent)
	}
}

func TestSendLocal_NeverRoutes(t *testing.T) {
	fc := &fakeCommander{}
	st := newFakeStore()
	svc := NewWithDeps(Deps{Manager: fc, Store: st})
	rr := &fakeRemoteRouter{canRoute: true}
	svc.SetRemoteRouter(rr)

	// SendLocal on an unknown session must still stay local (loop guard for
	// inbound routed commands), never bounce back out to the router.
	if err := svc.SendLocal(context.Background(), "remote-x", "hi"); err != nil {
		t.Fatalf("sendLocal: %v", err)
	}
	if len(fc.sent) != 1 || len(rr.routed) != 0 {
		t.Fatalf("SendLocal must never route: sent=%v routed=%+v", fc.sent, rr.routed)
	}
}
