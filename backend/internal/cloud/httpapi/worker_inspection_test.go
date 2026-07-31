package httpapi

import (
	"encoding/json"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

func TestAssistantResultPreservesNarrationAcrossTools(t *testing.T) {
	events := []clouddomain.Event{
		inspectionEvent("chat.assistant_delta", map[string]any{"turnId": "turn-one", "text": "Checking "}),
		inspectionEvent("chat.assistant_delta", map[string]any{"turnId": "turn-one", "text": "the tests."}),
		inspectionEvent("chat.assistant_message", map[string]any{"turnId": "turn-one", "text": "duplicate fallback"}),
		inspectionEvent("chat.tool_started", map[string]any{"turnId": "turn-one", "name": "Shell"}),
		inspectionEvent("chat.assistant_message", map[string]any{"turnId": "turn-one", "text": "All tests now pass."}),
		inspectionEvent("chat.assistant_message", map[string]any{"turnId": "another-turn", "text": "wrong turn"}),
		inspectionEvent("chat.turn_completed", map[string]any{"turnId": "turn-one"}),
	}

	result := assistantResult(events, "turn-one")
	if result != "Checking the tests.\n\nAll tests now pass." {
		t.Fatalf("assistantResult() = %q", result)
	}
}

func TestAssistantResultUsesTerminalFirstCompletionHook(t *testing.T) {
	events := []clouddomain.Event{
		inspectionEvent("chat.user_message", map[string]any{
			"turnId": "turn-one",
			"text":   "Read the README",
		}),
		inspectionEvent("agent.activity", map[string]any{
			"event": "stop",
			"state": "idle",
			"native": map[string]any{
				"last_assistant_message": "The repository contains a local-first agent arena.",
			},
		}),
	}

	result := assistantResult(events, "turn-one")
	if result != "The repository contains a local-first agent arena." {
		t.Fatalf("assistantResult() = %q", result)
	}
}

func inspectionEvent(eventType string, payload map[string]any) clouddomain.Event {
	encoded, _ := json.Marshal(payload)
	return clouddomain.Event{Type: eventType, Payload: encoded}
}
