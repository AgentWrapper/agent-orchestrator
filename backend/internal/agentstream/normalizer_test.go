package agentstream

import (
	"testing"
	"time"
)

// Tests modeled on AllBeingsFuture electron/tests/agent-stream-normalizer.test.ts.

func TestNormalizerMapsACPStyleBridgeEventsWithIncreasingSequences(t *testing.T) {
	n := NewNormalizer()
	fixed := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	n.now = func() time.Time { return fixed }
	n.ConfigureSession("s1", Source{Kind: SourceKindNativeACPv1, Provider: "acp-agent"})

	text := n.Normalize("s1", BridgeEvent{Event: "delta", Text: "hi", ItemID: "m1"})
	if text == nil || text.Type != TypeTextDelta {
		t.Fatalf("text = %+v, want text_delta", text)
	}
	if text.Sequence != 0 {
		t.Fatalf("sequence = %d, want 0", text.Sequence)
	}
	if text.Delta != "hi" || text.ItemID != "m1" {
		t.Fatalf("text fields = delta:%q itemId:%q", text.Delta, text.ItemID)
	}
	if text.Source == nil || text.Source.Kind != SourceKindNativeACPv1 {
		t.Fatalf("source = %+v", text.Source)
	}

	thinking := n.Normalize("s1", BridgeEvent{Event: "thinking", Text: "hmm", ItemID: "t1"})
	if thinking == nil || thinking.Type != TypeThinkingUpdate {
		t.Fatalf("thinking = %+v", thinking)
	}
	if thinking.Sequence != 1 {
		t.Fatalf("thinking sequence = %d, want 1", thinking.Sequence)
	}
	if thinking.Mode != string(ThinkingDelta) {
		t.Fatalf("thinking mode = %q, want delta", thinking.Mode)
	}

	tool := n.Normalize("s1", BridgeEvent{
		Event:      "tool",
		ToolCallID: "tool-1",
		Name:       "Read file",
		Input:      map[string]any{"path": "a.ts"},
		IsUpdate:   false,
		ToolStatus: "pending",
	})
	if tool == nil || tool.Type != TypeToolCall {
		t.Fatalf("tool = %+v", tool)
	}
	if tool.Sequence != 2 {
		t.Fatalf("tool sequence = %d, want 2", tool.Sequence)
	}

	toolUpdate := n.Normalize("s1", BridgeEvent{
		Event:      "tool",
		ToolCallID: "tool-1",
		Name:       "Read file",
		IsUpdate:   true,
		ToolStatus: "completed",
		Output:     map[string]any{"bytes": 3},
	})
	if toolUpdate == nil || toolUpdate.Type != TypeToolUpdate {
		t.Fatalf("toolUpdate = %+v", toolUpdate)
	}
	if toolUpdate.Sequence != 3 {
		t.Fatalf("toolUpdate sequence = %d, want 3", toolUpdate.Sequence)
	}
	if toolUpdate.Status != ToolCompleted {
		t.Fatalf("status = %q", toolUpdate.Status)
	}
	if toolUpdate.ResultDelta == "" || !contains(toolUpdate.ResultDelta, "bytes") {
		t.Fatalf("resultDelta = %q, want bytes json", toolUpdate.ResultDelta)
	}

	plan := n.Normalize("s1", BridgeEvent{
		Event: "plan",
		Entries: []any{
			map[string]any{"content": "Step A", "priority": "high", "status": "completed"},
		},
	})
	if plan == nil || plan.Type != TypePlan {
		t.Fatalf("plan = %+v", plan)
	}
	if len(plan.Entries) != 1 || plan.Entries[0].Title != "Step A" {
		t.Fatalf("plan entries = %+v", plan.Entries)
	}
	if plan.Entries[0].ID != "plan-entry-0" || plan.Entries[0].Status != PlanCompleted {
		t.Fatalf("plan entry = %+v", plan.Entries[0])
	}

	permission := n.Normalize("s1", BridgeEvent{
		Event:      "permission",
		RequestID:  "42",
		Name:       "Inspect workspace",
		ToolCallID: "tool-1",
		Options: []any{
			map[string]any{"optionId": "allow", "name": "Allow once", "kind": "allow_once"},
			map[string]any{"optionId": "reject", "name": "Reject once", "kind": "reject_once"},
		},
	})
	if permission == nil || permission.Type != TypePermissionRequest {
		t.Fatalf("permission = %+v", permission)
	}
	if permission.Request == nil || permission.Request.RequestID != "42" {
		t.Fatalf("request = %+v", permission.Request)
	}
	if len(permission.Request.Options) == 0 || permission.Request.Options[0].Label != "Allow once" {
		t.Fatalf("options = %+v", permission.Request.Options)
	}

	// Permission outcomes are not streamed to the renderer.
	if got := n.Normalize("s1", BridgeEvent{
		Event:     "permission",
		RequestID: "42",
		Outcome:   map[string]any{"outcome": "selected", "optionId": "allow"},
	}); got != nil {
		t.Fatalf("permission outcome should be nil, got %+v", got)
	}

	done := n.Normalize("s1", BridgeEvent{Event: "done", StopReason: "end_turn"})
	if done == nil || done.Type != TypeDone {
		t.Fatalf("done = %+v", done)
	}
	if done.Sequence != 6 {
		t.Fatalf("done sequence = %d, want 6", done.Sequence)
	}
	if !done.IsTerminal() {
		t.Fatal("done should be terminal")
	}

	cancelled := n.Normalize("s1", BridgeEvent{Event: "done", StopReason: "cancelled"})
	if cancelled == nil || cancelled.Type != TypeCancelled {
		t.Fatalf("cancelled = %+v", cancelled)
	}
	if cancelled.Sequence != 7 {
		t.Fatalf("cancelled sequence = %d, want 7", cancelled.Sequence)
	}
}

func TestNormalizerIgnoresReadyStatusAndMapsRunningIdle(t *testing.T) {
	n := NewNormalizer()
	n.ConfigureSession("s2", Source{Kind: SourceKindLegacyAdapter, Provider: "claude"})
	if got := n.Normalize("s2", BridgeEvent{Event: "status", Phase: "ready"}); got != nil {
		t.Fatalf("ready status should be nil, got %+v", got)
	}

	running := n.Normalize("s2", BridgeEvent{Event: "status", Phase: "running"})
	if running == nil || running.Type != TypeStatus || running.StreamStatus != StatusRunning {
		t.Fatalf("running = %+v", running)
	}

	thinking := n.Normalize("s2", BridgeEvent{Event: "thinking", Text: "legacy"})
	if thinking == nil || thinking.Type != TypeThinkingUpdate || thinking.Mode != string(ThinkingDelta) {
		t.Fatalf("thinking = %+v", thinking)
	}
}

func TestNormalizerDropsEmptyDeltasAndAgentTask(t *testing.T) {
	n := NewNormalizer()
	n.ConfigureSession("s3", Source{Kind: SourceKindNativeACPv1})
	if got := n.Normalize("s3", BridgeEvent{Event: "delta", Text: ""}); got != nil {
		t.Fatalf("empty delta should be nil, got %+v", got)
	}
	if got := n.Normalize("s3", BridgeEvent{Event: "agent_task"}); got != nil {
		t.Fatalf("agent_task should be nil, got %+v", got)
	}
	// Sequence must not advance on dropped events.
	next := n.Normalize("s3", BridgeEvent{Event: "delta", Text: "x"})
	if next == nil || next.Sequence != 0 {
		t.Fatalf("next sequence = %+v, want 0", next)
	}
}

func TestNormalizerToolOutputDiffIsIncremental(t *testing.T) {
	n := NewNormalizer()
	n.ConfigureSession("s4", Source{Kind: SourceKindNativeACPv1})
	_ = n.Normalize("s4", BridgeEvent{
		Event: "tool", ToolCallID: "t", Name: "run", IsUpdate: false,
	})
	u1 := n.Normalize("s4", BridgeEvent{
		Event: "tool", ToolCallID: "t", Name: "run", IsUpdate: true,
		ToolStatus: "in_progress", Output: "hel",
	})
	if u1 == nil || u1.ResultDelta != "hel" {
		t.Fatalf("u1 = %+v", u1)
	}
	u2 := n.Normalize("s4", BridgeEvent{
		Event: "tool", ToolCallID: "t", Name: "run", IsUpdate: true,
		ToolStatus: "completed", Output: "hello",
	})
	if u2 == nil || u2.ResultDelta != "lo" {
		t.Fatalf("u2 resultDelta = %q, want lo", u2.ResultDelta)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		(func() bool {
			for i := 0; i+len(sub) <= len(s); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		})())
}
