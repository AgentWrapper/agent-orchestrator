package worker

import (
	"reflect"
	"testing"
)

func TestStructuredCodexArgvBuildsExecAndResumeCommands(t *testing.T) {
	base, err := structuredCodexArgv([]string{
		"/usr/local/bin/codex",
		"-c", "check_for_update_on_startup=false",
		"--dangerously-bypass-approvals-and-sandbox",
		"--ask-for-approval", "on-request",
		"--no-alt-screen",
		"--", "old prompt",
	})
	if err != nil {
		t.Fatalf("structuredCodexArgv() error = %v", err)
	}
	wantBase := []string{
		"/usr/local/bin/codex",
		"exec",
		"-c", "check_for_update_on_startup=false",
		"--dangerously-bypass-approvals-and-sandbox",
		"-c", `approval_policy="on-request"`,
	}
	if !reflect.DeepEqual(base, wantBase) {
		t.Fatalf("base argv = %#v, want %#v", base, wantBase)
	}
	wantInitial := append(append([]string(nil), wantBase...), "--json", "--", "-fix tests")
	if got := codexTurnArgv(base, "-fix tests", ""); !reflect.DeepEqual(got, wantInitial) {
		t.Fatalf("initial argv = %#v, want %#v", got, wantInitial)
	}
	wantResume := []string{
		"/usr/local/bin/codex", "exec", "resume",
		"-c", "check_for_update_on_startup=false",
		"--dangerously-bypass-approvals-and-sandbox",
		"-c", `approval_policy="on-request"`,
		"--json", "--", "thread-123", "continue",
	}
	if got := codexTurnArgv(base, "continue", "thread-123"); !reflect.DeepEqual(got, wantResume) {
		t.Fatalf("resume argv = %#v, want %#v", got, wantResume)
	}
}

func TestNormalizeCodexLifecycleMessagesReasoningAndUsage(t *testing.T) {
	state := &codexStreamState{startedTools: make(map[string]struct{})}
	tests := []struct {
		line  string
		types []string
	}{
		{
			line:  `{"type":"thread.started","thread_id":"thread-123"}`,
			types: []string{"chat.session_started"},
		},
		{
			line:  `{"type":"item.completed","item":{"id":"reason-1","type":"reasoning","text":"Inspecting tests"}}`,
			types: []string{"chat.reasoning_message"},
		},
		{
			line:  `{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"Done"}}`,
			types: []string{"chat.assistant_message"},
		},
		{
			line:  `{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":3,"output_tokens":4}}`,
			types: []string{"chat.usage_updated", "chat.turn_completed"},
		},
	}
	for _, test := range tests {
		events := normalizeCodexLine([]byte(test.line), state)
		assertNormalizedTypes(t, events, test.types...)
	}
	if state.sessionID != "thread-123" {
		t.Fatalf("session ID = %q, want thread-123", state.sessionID)
	}
}

func TestNormalizeCodexToolProtocols(t *testing.T) {
	state := &codexStreamState{startedTools: make(map[string]struct{})}

	started := normalizeCodexLine([]byte(
		`{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"go test ./...","aggregated_output":"","status":"in_progress"}}`,
	), state)
	assertNormalizedTypes(t, started, "chat.tool_started")
	if got := started[0].payload["input"]; !reflect.DeepEqual(got, map[string]any{"command": "go test ./..."}) {
		t.Fatalf("command input = %#v", got)
	}

	completed := normalizeCodexLine([]byte(
		`{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"go test ./...","aggregated_output":"ok\n","exit_code":0,"status":"completed"}}`,
	), state)
	assertNormalizedTypes(t, completed, "chat.tool_completed")
	if completed[0].payload["isError"] != false {
		t.Fatalf("command completion = %#v", completed[0].payload)
	}

	failed := normalizeCodexLine([]byte(
		`{"type":"item.completed","item":{"id":"mcp-1","type":"mcp_tool_call","server":"github","tool":"search","arguments":{"q":"bug"},"error":{"message":"denied"},"status":"failed"}}`,
	), state)
	assertNormalizedTypes(t, failed, "chat.tool_started", "chat.tool_failed")
	if failed[0].payload["name"] != "github.search" {
		t.Fatalf("MCP tool name = %#v", failed[0].payload["name"])
	}

	fileChange := normalizeCodexLine([]byte(
		`{"type":"item.completed","item":{"id":"patch-1","type":"file_change","changes":[{"path":"a.go","kind":"update"}],"status":"completed"}}`,
	), state)
	assertNormalizedTypes(t, fileChange, "chat.tool_started", "chat.tool_completed")
}

func TestNormalizeCodexFailuresAndCompatibilityItemType(t *testing.T) {
	state := &codexStreamState{startedTools: make(map[string]struct{})}
	events := normalizeCodexLine([]byte(
		`{"type":"item.completed","item":{"id":"reason-1","item_type":"reasoning","text":"legacy field"}}`,
	), state)
	assertNormalizedTypes(t, events, "chat.reasoning_message")

	events = normalizeCodexLine([]byte(
		`{"type":"turn.failed","error":{"message":"HTTP 401 unauthorized"}}`,
	), state)
	assertNormalizedTypes(t, events, "chat.error", "chat.auth_status", "chat.turn_completed")
	if !state.reportedError {
		t.Fatal("turn failure was not marked as reported")
	}
}

func TestNormalizeCodexIgnoresMalformedAndUnknownLines(t *testing.T) {
	state := &codexStreamState{startedTools: make(map[string]struct{})}
	for _, line := range []string{`not-json`, `{"type":"future.event","secret":"ignored"}`} {
		if events := normalizeCodexLine([]byte(line), state); len(events) != 0 {
			t.Fatalf("normalizeCodexLine(%q) = %#v", line, events)
		}
	}
}

func assertNormalizedTypes(t *testing.T, events []normalizedChatEvent, types ...string) {
	t.Helper()
	if len(events) != len(types) {
		t.Fatalf("event count = %d, want %d: %#v", len(events), len(types), events)
	}
	for index, eventType := range types {
		if events[index].eventType != eventType {
			t.Fatalf("event %d type = %q, want %q", index, events[index].eventType, eventType)
		}
	}
}
