package worker

import (
	"reflect"
	"testing"
)

func TestStructuredCursorArgvBuildsPrintAndResumeCommands(t *testing.T) {
	base, err := structuredCursorArgv([]string{
		"/usr/local/bin/cursor-agent",
		"--yolo",
		"--model", "composer-2",
		"--", "old prompt",
	})
	if err != nil {
		t.Fatalf("structuredCursorArgv() error = %v", err)
	}
	wantBase := []string{
		"/usr/local/bin/cursor-agent",
		"--model", "composer-2",
		"--print",
		"--output-format", "stream-json",
		"--stream-partial-output",
		"--force",
		"--trust",
	}
	if !reflect.DeepEqual(base, wantBase) {
		t.Fatalf("base argv = %#v, want %#v", base, wantBase)
	}
	wantInitial := append(append([]string(nil), wantBase...), "--", "-fix tests")
	if got := cursorTurnArgv(base, "-fix tests", ""); !reflect.DeepEqual(got, wantInitial) {
		t.Fatalf("initial argv = %#v, want %#v", got, wantInitial)
	}
	wantResume := append(append([]string(nil), wantBase...), "--resume", "chat-123", "--", "continue")
	if got := cursorTurnArgv(base, "continue", "chat-123"); !reflect.DeepEqual(got, wantResume) {
		t.Fatalf("resume argv = %#v, want %#v", got, wantResume)
	}
}

func TestNormalizeCursorLifecycleAndPartialAssistantDeduplication(t *testing.T) {
	state := &cursorStreamState{startedTools: make(map[string]struct{})}
	events := normalizeCursorLine([]byte(
		`{"type":"system","subtype":"init","session_id":"chat-123","model":"Composer","permissionMode":"force"}`,
	), state)
	assertNormalizedTypes(t, events, "chat.session_started")

	events = normalizeCursorLine([]byte(
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix tests"}]},"session_id":"chat-123"}`,
	), state)
	assertNormalizedTypes(t, events)

	events = normalizeCursorLine([]byte(
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fix"}]},"timestamp_ms":1,"session_id":"chat-123"}`,
	), state)
	assertNormalizedTypes(t, events, "chat.assistant_delta")

	for _, duplicate := range []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fixing tests"}]},"timestamp_ms":2,"model_call_id":"model-1"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fixing tests"}]}}`,
	} {
		if got := normalizeCursorLine([]byte(duplicate), state); len(got) != 0 {
			t.Fatalf("duplicate assistant event emitted: %#v", got)
		}
	}

	events = normalizeCursorLine([]byte(
		`{"type":"result","subtype":"success","is_error":false,"duration_ms":123,"duration_api_ms":100,"result":"Fixing tests","request_id":"request-1"}`,
	), state)
	assertNormalizedTypes(t, events, "chat.turn_completed")
	if state.sessionID != "chat-123" {
		t.Fatalf("session ID = %q, want chat-123", state.sessionID)
	}
}

func TestNormalizeCursorToolStartCompletionAndFailure(t *testing.T) {
	state := &cursorStreamState{startedTools: make(map[string]struct{})}
	started := normalizeCursorLine([]byte(
		`{"type":"tool_call","subtype":"started","call_id":"tool-1","tool_call":{"readToolCall":{"args":{"path":"README.md"}}}}`,
	), state)
	assertNormalizedTypes(t, started, "chat.tool_started")
	if started[0].payload["name"] != "readToolCall" {
		t.Fatalf("tool name = %#v", started[0].payload["name"])
	}
	if got := started[0].payload["input"]; !reflect.DeepEqual(got, map[string]any{"path": "README.md"}) {
		t.Fatalf("tool input = %#v", got)
	}

	completed := normalizeCursorLine([]byte(
		`{"type":"tool_call","subtype":"completed","call_id":"tool-1","tool_call":{"readToolCall":{"args":{"path":"README.md"},"result":{"success":{"content":"hello"}}}}}`,
	), state)
	assertNormalizedTypes(t, completed, "chat.tool_completed")

	failed := normalizeCursorLine([]byte(
		`{"type":"tool_call","subtype":"completed","call_id":"tool-2","tool_call":{"function":{"name":"shell","arguments":{"command":"false"},"result":{"error":{"message":"exit 1"}}}}}`,
	), state)
	assertNormalizedTypes(t, failed, "chat.tool_started", "chat.tool_failed")
	if failed[0].payload["name"] != "shell" {
		t.Fatalf("function tool name = %#v", failed[0].payload["name"])
	}
}

func TestNormalizeCursorFallsBackToCompleteMessagesAndAuthErrors(t *testing.T) {
	state := &cursorStreamState{startedTools: make(map[string]struct{})}
	events := normalizeCursorLine([]byte(
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Complete response"}]}}`,
	), state)
	assertNormalizedTypes(t, events, "chat.assistant_message")

	state.sawTextMessage = false
	events = normalizeCursorLine([]byte(
		`{"type":"result","subtype":"error","is_error":true,"result":"API key is invalid"}`,
	), state)
	assertNormalizedTypes(
		t,
		events,
		"chat.assistant_message",
		"chat.error",
		"chat.auth_status",
		"chat.turn_completed",
	)
}

func TestNormalizeCursorIgnoresMalformedUnknownAndNonStreamingFlushes(t *testing.T) {
	state := &cursorStreamState{startedTools: make(map[string]struct{})}
	for _, line := range []string{
		`not-json`,
		`{"type":"future","secret":"ignored"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"buffered"}]},"timestamp_ms":2,"model_call_id":"model-1"}`,
	} {
		if events := normalizeCursorLine([]byte(line), state); len(events) != 0 {
			t.Fatalf("normalizeCursorLine(%q) = %#v", line, events)
		}
	}
}
