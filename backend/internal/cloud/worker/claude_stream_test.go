package worker

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"sync/atomic"
	"testing"

	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
)

func TestStructuredClaudeArgvPreservesAdapterFlagsAndRemovesPrompt(t *testing.T) {
	got, err := structuredClaudeArgv([]string{
		"/usr/local/bin/claude",
		"--session-id", "claude-session",
		"--permission-mode", "bypassPermissions",
		"--append-system-prompt", "coordinate workers",
		"--", "old positional prompt",
	}, "")
	if err != nil {
		t.Fatalf("structuredClaudeArgv() error = %v", err)
	}
	want := []string{
		"/usr/local/bin/claude",
		"--session-id", "claude-session",
		"--permission-mode", "bypassPermissions",
		"--append-system-prompt", "coordinate workers",
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("structuredClaudeArgv() = %#v, want %#v", got, want)
	}
}

func TestStructuredClaudeArgvResumesPersistedSession(t *testing.T) {
	got, err := structuredClaudeArgv([]string{
		"/usr/local/bin/claude",
		"--session-id", "ao-session",
		"--permission-mode", "bypassPermissions",
	}, "provider-session")
	if err != nil {
		t.Fatalf("structuredClaudeArgv() error = %v", err)
	}
	if claudeSessionID(got) != "" {
		t.Fatalf("resume argv retained --session-id: %#v", got)
	}
	if !containsArgPair(got, "--resume", "provider-session") {
		t.Fatalf("resume argv = %#v", got)
	}
}

func containsArgPair(arguments []string, name, value string) bool {
	for index := 0; index+1 < len(arguments); index++ {
		if arguments[index] == name && arguments[index+1] == value {
			return true
		}
	}
	return false
}

func TestClaudeInputWriterWritesDocumentedUserEnvelope(t *testing.T) {
	var output bytes.Buffer
	writer := &claudeInputWriter{writer: &output, sessionID: "claude-session"}
	if err := writer.Prompt("Fix the tests", 0); err != nil {
		t.Fatalf("Prompt() error = %v", err)
	}
	var envelope struct {
		Type    string `json:"type"`
		Message struct {
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
		ParentToolUseID *string `json:"parent_tool_use_id"`
		SessionID       string  `json:"session_id"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &envelope); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if envelope.Type != "user" ||
		envelope.Message.Role != "user" ||
		len(envelope.Message.Content) != 1 ||
		envelope.Message.Content[0].Type != "text" ||
		envelope.Message.Content[0].Text != "Fix the tests" ||
		envelope.ParentToolUseID != nil ||
		envelope.SessionID != "claude-session" {
		t.Fatalf("envelope = %#v", envelope)
	}
	if !bytes.HasSuffix(output.Bytes(), []byte("\n")) {
		t.Fatal("prompt envelope is not newline-delimited")
	}
}

func TestNormalizeClaudeEvents(t *testing.T) {
	state := &claudeStreamState{}
	tests := []struct {
		name      string
		line      string
		eventType string
		payload   map[string]any
	}{
		{
			name:      "text delta",
			line:      `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}`,
			eventType: "chat.assistant_delta",
			payload:   map[string]any{"text": "hello"},
		},
		{
			name:      "tool start",
			line:      `{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"go test ./..."}}}}`,
			eventType: "chat.tool_started",
			payload: map[string]any{
				"id":    "tool-1",
				"name":  "Bash",
				"input": map[string]any{"command": "go test ./..."},
			},
		},
		{
			name:      "result",
			line:      `{"type":"result","is_error":false,"subtype":"success","result":"done","duration_ms":1234,"total_cost_usd":0.12}`,
			eventType: "chat.turn_completed",
			payload: map[string]any{
				"isError":    false,
				"subtype":    "success",
				"result":     "done",
				"durationMs": float64(1234),
				"costUsd":    0.12,
			},
		},
		{
			name:      "assistant fallback after result resets deltas",
			line:      `{"type":"assistant","message":{"content":[{"type":"text","text":"complete response"}]}}`,
			eventType: "chat.assistant_message",
			payload:   map[string]any{"text": "complete response"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			events := normalizeClaudeLine([]byte(test.line), state)
			if len(events) != 1 {
				t.Fatalf("len(events) = %d, want 1", len(events))
			}
			if events[0].eventType != test.eventType || !reflect.DeepEqual(events[0].payload, test.payload) {
				t.Fatalf("event = %#v, want type=%q payload=%#v", events[0], test.eventType, test.payload)
			}
		})
	}
}

func TestNormalizeClaudeAssistantCompleteIsSuppressedAfterDelta(t *testing.T) {
	state := &claudeStreamState{}
	_ = normalizeClaudeLine(
		[]byte(`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}}`),
		state,
	)
	events := normalizeClaudeLine(
		[]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"partial response"}]}}`),
		state,
	)
	if len(events) != 0 {
		t.Fatalf("assistant fallback emitted after deltas: %#v", events)
	}
}

func TestNormalizeClaudeMalformedAndUnknownEventsAreIgnored(t *testing.T) {
	state := &claudeStreamState{}
	for _, line := range []string{
		`not json`,
		`{"type":"unknown","secret":"do-not-emit"}`,
	} {
		if events := normalizeClaudeLine([]byte(line), state); len(events) != 0 {
			t.Fatalf("normalizeClaudeLine(%q) = %#v, want no events", line, events)
		}
	}
}

func TestNormalizeClaudeCanonicalLifecycleEvents(t *testing.T) {
	state := &claudeStreamState{}
	tests := []struct {
		name      string
		line      string
		eventType string
	}{
		{
			name:      "session",
			line:      `{"type":"system","subtype":"init","session_id":"session-one","model":"claude"}`,
			eventType: "chat.session_started",
		},
		{
			name:      "turn",
			line:      `{"type":"stream_event","event":{"type":"message_start","message":{"id":"message-one"}}}`,
			eventType: "chat.turn_started",
		},
		{
			name:      "reasoning",
			line:      `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"checking"}}}`,
			eventType: "chat.reasoning_delta",
		},
		{
			name:      "tool input",
			line:      `{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}}`,
			eventType: "chat.tool_input_delta",
		},
		{
			name:      "tool result",
			line:      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-one","content":"passed","is_error":false}]}}`,
			eventType: "chat.tool_completed",
		},
		{
			name:      "usage",
			line:      `{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":12}}}`,
			eventType: "chat.usage_updated",
		},
		{
			name:      "compaction",
			line:      `{"type":"system","subtype":"compact_boundary"}`,
			eventType: "chat.context_compacted",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			events := normalizeClaudeLine([]byte(test.line), state)
			if len(events) != 1 || events[0].eventType != test.eventType {
				t.Fatalf("events = %#v, want %q", events, test.eventType)
			}
		})
	}
}

func TestStructuredPromptCommandsAreRoutedAndDeduplicated(t *testing.T) {
	var output bytes.Buffer
	writer := &claudeInputWriter{writer: &output, sessionID: "claude-session"}
	var highest atomic.Int64
	command := cloudworkerhub.Command{
		Type:     "prompt",
		Data:     base64.StdEncoding.EncodeToString([]byte("hello")),
		Sequence: 42,
	}
	if err := handleStructuredCommand(command, writer, &highest); err != nil {
		t.Fatalf("handleStructuredCommand(first) error = %v", err)
	}
	if err := handleStructuredCommand(command, writer, &highest); err != nil {
		t.Fatalf("handleStructuredCommand(duplicate) error = %v", err)
	}
	if highest.Load() != 42 {
		t.Fatalf("highest prompt = %d, want 42", highest.Load())
	}
	if bytes.Count(output.Bytes(), []byte("\n")) != 1 {
		t.Fatalf("prompt output = %q, want one envelope", output.String())
	}
	if err := handleStructuredCommand(
		cloudworkerhub.Command{Type: "input", Data: command.Data},
		writer,
		&highest,
	); err != nil {
		t.Fatalf("terminal input should be ignored by structured runtime: %v", err)
	}
	if bytes.Count(output.Bytes(), []byte("\n")) != 1 {
		t.Fatalf("terminal input reached structured runtime: %q", output.String())
	}
}
