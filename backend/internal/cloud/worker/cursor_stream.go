package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strings"
)

func (r *Runner) runStructuredCursor(
	ctx context.Context,
	adapterArgv []string,
	launchConfigPrompt string,
	environment []string,
) error {
	baseArgv, err := structuredCursorArgv(adapterArgv)
	if err != nil {
		return err
	}
	state := &cursorStreamState{startedTools: make(map[string]struct{})}
	return r.runStructuredTurns(
		ctx,
		"cursor",
		"stream-json",
		filepath.Base(baseArgv[0]),
		launchConfigPrompt,
		func(turnCtx context.Context, prompt, sessionID string, sequence int64) (string, error) {
			return r.runCursorTurn(
				turnCtx,
				baseArgv,
				environment,
				prompt,
				sessionID,
				sequence,
				state,
			)
		},
	)
}

func structuredCursorArgv(argv []string) ([]string, error) {
	if len(argv) == 0 {
		return nil, errors.New("cursor launch command is empty")
	}
	result := []string{argv[0]}
	for index := 1; index < len(argv); index++ {
		argument := argv[index]
		if argument == "--" {
			break
		}
		switch argument {
		case "--yolo", "--force", "--print", "-p", "--stream-partial-output", "--trust":
			continue
		case "--output-format":
			if index+1 >= len(argv) {
				return nil, errors.New("cursor output format flag is missing its value")
			}
			index++
		default:
			result = append(result, argument)
		}
	}
	return append(
		result,
		"--print",
		"--output-format", "stream-json",
		"--stream-partial-output",
		"--force",
		"--trust",
	), nil
}

func cursorTurnArgv(base []string, prompt, sessionID string) []string {
	result := make([]string, 0, len(base)+4)
	result = append(result, base...)
	if sessionID != "" {
		result = append(result, "--resume", sessionID)
	}
	return append(result, "--", prompt)
}

func (r *Runner) runCursorTurn(
	ctx context.Context,
	baseArgv []string,
	environment []string,
	prompt string,
	sessionID string,
	sequence int64,
	state *cursorStreamState,
) (string, error) {
	argv := cursorTurnArgv(baseArgv, prompt, sessionID)
	state.reportedError = false
	state.sawTextDelta = false
	state.sawTextMessage = false
	state.startedTools = make(map[string]struct{})
	err := r.runStructuredProcess(
		ctx,
		"cursor",
		argv,
		environment,
		func() bool { return state.reportedError },
		func(streamCtx context.Context, output io.Reader) error {
			return r.streamCursorOutput(streamCtx, output, state)
		},
		func(startedCtx context.Context) error {
			return r.acknowledgePromptUntil(startedCtx, sequence)
		},
	)
	return state.sessionID, err
}

type cursorStreamState struct {
	sessionID      string
	sessionStarted bool
	sawTextDelta   bool
	sawTextMessage bool
	reportedError  bool
	startedTools   map[string]struct{}
}

func (r *Runner) streamCursorOutput(
	ctx context.Context,
	output io.Reader,
	state *cursorStreamState,
) error {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64<<10), maxClaudeStreamLine)
	for scanner.Scan() {
		for _, event := range normalizeCursorLine(scanner.Bytes(), state) {
			if err := r.client.Event(ctx, event.eventType, event.payload); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}

func normalizeCursorLine(line []byte, state *cursorStreamState) []normalizedChatEvent {
	var root map[string]json.RawMessage
	if json.Unmarshal(line, &root) != nil {
		return nil
	}
	switch rawString(root["type"]) {
	case "system":
		if rawString(root["subtype"]) != "init" {
			return nil
		}
		sessionID := rawString(root["session_id"])
		if sessionID == "" {
			return nil
		}
		state.sessionID = sessionID
		if state.sessionStarted {
			return nil
		}
		state.sessionStarted = true
		payload := map[string]any{"sessionId": sessionID}
		copyJSONField(payload, "model", root["model"])
		copyJSONField(payload, "permissionMode", root["permissionMode"])
		return []normalizedChatEvent{{
			eventType: "chat.session_started",
			payload:   payload,
		}}
	case "user":
		// The server has already persisted chat.user_message, and AO emits
		// turn_started before spawning the one-shot Cursor process.
		return nil
	case "assistant":
		text := cursorMessageText(root["message"])
		if text == "" {
			return nil
		}
		_, hasTimestamp := root["timestamp_ms"]
		_, hasModelCall := root["model_call_id"]
		switch {
		case hasTimestamp && !hasModelCall:
			state.sawTextDelta = true
			return []normalizedChatEvent{{
				eventType: "chat.assistant_delta",
				payload:   map[string]any{"text": text},
			}}
		case hasModelCall || state.sawTextDelta:
			return nil
		default:
			state.sawTextMessage = true
			return []normalizedChatEvent{{
				eventType: "chat.assistant_message",
				payload:   map[string]any{"text": text},
			}}
		}
	case "tool_call":
		return normalizeCursorTool(root, state)
	case "result":
		events := make([]normalizedChatEvent, 0, 3)
		resultText := rawString(root["result"])
		if !state.sawTextDelta && !state.sawTextMessage && resultText != "" {
			events = append(events, normalizedChatEvent{
				eventType: "chat.assistant_message",
				payload:   map[string]any{"text": resultText},
			})
		}
		isError := rawBool(root["is_error"])
		if isError {
			state.reportedError = true
			events = append(events, normalizedErrorEvents(resultText)...)
		}
		payload := map[string]any{"isError": isError}
		copyJSONField(payload, "subtype", root["subtype"])
		copyJSONField(payload, "result", root["result"])
		copyJSONField(payload, "durationMs", root["duration_ms"])
		copyJSONField(payload, "durationApiMs", root["duration_api_ms"])
		copyJSONField(payload, "requestId", root["request_id"])
		events = append(events, normalizedChatEvent{
			eventType: "chat.turn_completed",
			payload:   payload,
		})
		state.sawTextDelta = false
		state.sawTextMessage = false
		state.startedTools = make(map[string]struct{})
		return events
	default:
		return nil
	}
}

func normalizeCursorTool(
	root map[string]json.RawMessage,
	state *cursorStreamState,
) []normalizedChatEvent {
	id := rawString(root["call_id"])
	name, input, output, failed := cursorToolPayload(root["tool_call"])
	if name == "" {
		name = "tool"
	}
	switch rawString(root["subtype"]) {
	case "started":
		if state.startedTools == nil {
			state.startedTools = make(map[string]struct{})
		}
		state.startedTools[id] = struct{}{}
		return []normalizedChatEvent{{
			eventType: "chat.tool_started",
			payload: map[string]any{
				"id":    id,
				"name":  name,
				"input": input,
			},
		}}
	case "completed":
		if state.startedTools == nil {
			state.startedTools = make(map[string]struct{})
		}
		events := make([]normalizedChatEvent, 0, 2)
		if _, started := state.startedTools[id]; !started {
			events = append(events, normalizedChatEvent{
				eventType: "chat.tool_started",
				payload: map[string]any{
					"id":    id,
					"name":  name,
					"input": input,
				},
			})
		}
		completionType := "chat.tool_completed"
		if failed {
			completionType = "chat.tool_failed"
		}
		events = append(events, normalizedChatEvent{
			eventType: completionType,
			payload: map[string]any{
				"id":      id,
				"output":  output,
				"isError": failed,
			},
		})
		delete(state.startedTools, id)
		return events
	default:
		return nil
	}
}

func cursorToolPayload(raw json.RawMessage) (string, map[string]any, any, bool) {
	var wrapper map[string]json.RawMessage
	if json.Unmarshal(raw, &wrapper) != nil {
		return "", map[string]any{}, nil, false
	}
	if functionRaw, ok := wrapper["function"]; ok {
		var function map[string]json.RawMessage
		if json.Unmarshal(functionRaw, &function) != nil {
			return "function", map[string]any{}, nil, false
		}
		name := rawString(function["name"])
		input := jsonValueMap(function["arguments"])
		var output any
		_ = json.Unmarshal(function["result"], &output)
		return name, input, output, cursorResultFailed(function["result"])
	}
	for name, callRaw := range wrapper {
		var call map[string]json.RawMessage
		if json.Unmarshal(callRaw, &call) != nil {
			continue
		}
		input := jsonValueMap(call["args"])
		var output any
		_ = json.Unmarshal(call["result"], &output)
		return name, input, output, cursorResultFailed(call["result"])
	}
	return "", map[string]any{}, nil, false
}

func cursorResultFailed(raw json.RawMessage) bool {
	var result map[string]json.RawMessage
	if json.Unmarshal(raw, &result) != nil {
		return false
	}
	errorValue, exists := result["error"]
	return exists && len(errorValue) > 0 && string(errorValue) != "null"
}

func cursorMessageText(raw json.RawMessage) string {
	var message struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &message) != nil {
		return ""
	}
	var text strings.Builder
	for _, block := range message.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	return text.String()
}
