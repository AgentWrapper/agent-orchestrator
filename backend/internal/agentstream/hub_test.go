package agentstream

import (
	"testing"
	"time"
)

func TestHubPublishBridgeAndSubscribeReplay(t *testing.T) {
	h := NewHub()
	h.ConfigureSession("sess-1", Source{Kind: SourceKindNativeACPv1, Provider: "test"})

	e1 := h.PublishBridge("sess-1", BridgeEvent{Event: "delta", Text: "a"})
	e2 := h.PublishBridge("sess-1", BridgeEvent{Event: "delta", Text: "b"})
	if e1 == nil || e2 == nil || e1.Sequence != 0 || e2.Sequence != 1 {
		t.Fatalf("events = %+v %+v", e1, e2)
	}

	// Terminal flush
	done := h.PublishBridge("sess-1", BridgeEvent{Event: "done", StopReason: "end_turn"})
	if done == nil || !done.IsTerminal() {
		t.Fatalf("done = %+v", done)
	}

	replay := h.Replay("sess-1", -1)
	if len(replay) != 3 {
		t.Fatalf("replay len = %d, want 3", len(replay))
	}
	after0 := h.Replay("sess-1", 0)
	if len(after0) != 2 || after0[0].Sequence != 1 {
		t.Fatalf("after0 = %+v", after0)
	}

	// Live subscribe after sequence 1 should get only done (seq 2) from replay
	// plus future events.
	snap, live, unsub := h.Subscribe("sess-1", 1)
	defer unsub()
	if len(snap) != 1 || snap[0].Type != TypeDone {
		t.Fatalf("snap = %+v", snap)
	}

	go func() {
		time.Sleep(20 * time.Millisecond)
		h.PublishBridge("sess-1", BridgeEvent{Event: "status", Phase: "idle"})
	}()

	select {
	case ev := <-live:
		if ev.Type != TypeStatus || ev.StreamStatus != StatusIdle {
			t.Fatalf("live = %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for live event")
	}
}

func TestHubPublishACPSessionUpdate(t *testing.T) {
	h := NewHub()
	h.ConfigureSession("s", Source{Kind: SourceKindNativeACPv1})
	ev := h.PublishACPSessionUpdate("s", ACPSessionUpdate{
		SessionUpdate: "agent_message_chunk",
		Content:       map[string]any{"type": "text", "text": "via-acp"},
	})
	if ev == nil || ev.Type != TypeTextDelta || ev.Delta != "via-acp" {
		t.Fatalf("ev = %+v", ev)
	}
	if h.PublishACPSessionUpdate("s", ACPSessionUpdate{SessionUpdate: "usage_update"}) != nil {
		t.Fatal("usage_update should not publish")
	}
}
