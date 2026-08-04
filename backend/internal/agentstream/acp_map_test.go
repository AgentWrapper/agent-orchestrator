package agentstream

import "testing"

func TestMapACPSessionUpdateMessageAndThought(t *testing.T) {
	be, ok := MapACPSessionUpdate(ACPSessionUpdate{
		SessionUpdate: "agent_message_chunk",
		Content:       map[string]any{"type": "text", "text": "hello"},
		MessageID:     "m1",
	})
	if !ok || be.Event != "delta" || be.Text != "hello" || be.ItemID != "m1" {
		t.Fatalf("message chunk = %+v ok=%v", be, ok)
	}

	be, ok = MapACPSessionUpdate(ACPSessionUpdate{
		SessionUpdate: "agent_thought_chunk",
		Content:       map[string]any{"type": "text", "text": "hmm"},
	})
	if !ok || be.Event != "thinking" || be.Text != "hmm" {
		t.Fatalf("thought chunk = %+v ok=%v", be, ok)
	}
}

func TestMapACPSessionUpdateToolsAndPlan(t *testing.T) {
	be, ok := MapACPSessionUpdate(ACPSessionUpdate{
		SessionUpdate: "tool_call",
		ToolCallID:    "tc1",
		Title:         "Read",
		RawInput:      map[string]any{"path": "x.go"},
		Status:        "pending",
	})
	if !ok || be.Event != "tool" || be.IsUpdate || be.ToolCallID != "tc1" {
		t.Fatalf("tool_call = %+v ok=%v", be, ok)
	}

	be, ok = MapACPSessionUpdate(ACPSessionUpdate{
		SessionUpdate: "tool_call_update",
		ToolCallID:    "tc1",
		Title:         "Read",
		Status:        "completed",
		RawOutput:     "ok",
	})
	if !ok || !be.IsUpdate || be.ToolStatus != "completed" {
		t.Fatalf("tool_call_update = %+v ok=%v", be, ok)
	}

	be, ok = MapACPSessionUpdate(ACPSessionUpdate{
		SessionUpdate: "plan",
		Entries: []any{
			map[string]any{"content": "A", "status": "pending"},
		},
	})
	if !ok || be.Event != "plan" || len(be.Entries) != 1 {
		t.Fatalf("plan = %+v ok=%v", be, ok)
	}

	be, ok = MapACPSessionUpdate(ACPSessionUpdate{
		SessionUpdate: "plan_removed",
		PlanID:        "p1",
	})
	if !ok || be.Data["operation"] != "removed" {
		t.Fatalf("plan_removed = %+v ok=%v", be, ok)
	}
}

func TestMapACPSessionUpdateIgnoresNoise(t *testing.T) {
	for _, kind := range []string{
		"usage_update", "current_mode_update", "user_message_chunk", "unknown_thing",
	} {
		if _, ok := MapACPSessionUpdate(ACPSessionUpdate{SessionUpdate: kind}); ok {
			t.Fatalf("%s should be ignored", kind)
		}
	}
}

func TestMapACPStopReasonAndError(t *testing.T) {
	done := MapACPStopReason("end_turn")
	if done.Event != "done" || done.StopReason != "end_turn" {
		t.Fatalf("done = %+v", done)
	}
	cancel := MapACPStopReason("cancelled")
	if cancel.Event != "done" || cancel.StopReason != "cancelled" {
		t.Fatalf("cancel = %+v", cancel)
	}
	errEv := MapACPError(assertErr("boom"))
	if errEv.Event != "error" || errEv.Error != "boom" {
		t.Fatalf("error = %+v", errEv)
	}
}

type assertErr string

func (e assertErr) Error() string { return string(e) }
