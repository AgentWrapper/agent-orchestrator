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

func (r *Runner) runStructuredCodex(
	ctx context.Context,
	adapterArgv []string,
	environment []string,
) error {
	baseArgv, err := structuredCodexArgv(adapterArgv)
	if err != nil {
		return err
	}
	state := &codexStreamState{startedTools: make(map[string]struct{})}
	return r.runStructuredTurns(
		ctx,
		"codex",
		"exec-json",
		filepath.Base(baseArgv[0]),
		func(turnCtx context.Context, prompt, sessionID string, sequence int64) (string, error) {
			return r.runCodexTurn(
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

func structuredCodexArgv(argv []string) ([]string, error) {
	if len(argv) == 0 {
		return nil, errors.New("codex launch command is empty")
	}
	result := []string{argv[0], "exec"}
	for index := 1; index < len(argv); index++ {
		argument := argv[index]
		if argument == "--" {
			break
		}
		switch argument {
		case "--no-alt-screen":
			continue
		case "--ask-for-approval":
			if index+1 >= len(argv) {
				return nil, errors.New("codex approval flag is missing its value")
			}
			// #nosec G602 -- the next index is explicitly bounds-checked above.
			value := argv[index+1]
			index++
			result = append(result, "-c", `approval_policy="`+value+`"`)
		default:
			result = append(result, argument)
		}
	}
	return result, nil
}

func codexTurnArgv(base []string, prompt, sessionID string) []string {
	result := make([]string, 0, len(base)+5)
	result = append(result, base[0], "exec")
	if sessionID != "" {
		result = append(result, "resume")
	}
	result = append(result, base[2:]...)
	result = append(result, "--json", "--")
	if sessionID != "" {
		result = append(result, sessionID)
	}
	return append(result, prompt)
}

func (r *Runner) runCodexTurn(
	ctx context.Context,
	baseArgv []string,
	environment []string,
	prompt string,
	sessionID string,
	sequence int64,
	state *codexStreamState,
) (string, error) {
	argv := codexTurnArgv(baseArgv, prompt, sessionID)
	state.reportedError = false
	state.startedTools = make(map[string]struct{})
	err := r.runStructuredProcess(
		ctx,
		"codex",
		argv,
		environment,
		func() bool { return state.reportedError },
		func(streamCtx context.Context, output io.Reader) error {
			return r.streamCodexOutput(streamCtx, output, state)
		},
		func(startedCtx context.Context) error {
			return r.acknowledgePromptUntil(startedCtx, sequence)
		},
	)
	return state.sessionID, err
}

type codexStreamState struct {
	sessionID      string
	sessionStarted bool
	reportedError  bool
	startedTools   map[string]struct{}
}

func (r *Runner) streamCodexOutput(
	ctx context.Context,
	output io.Reader,
	state *codexStreamState,
) error {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64<<10), maxClaudeStreamLine)
	for scanner.Scan() {
		for _, event := range normalizeCodexLine(scanner.Bytes(), state) {
			if err := r.client.Event(ctx, event.eventType, event.payload); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}

func normalizeCodexLine(line []byte, state *codexStreamState) []normalizedChatEvent {
	var root map[string]json.RawMessage
	if json.Unmarshal(line, &root) != nil {
		return nil
	}
	switch rawString(root["type"]) {
	case "thread.started":
		threadID := rawString(root["thread_id"])
		if threadID == "" {
			return nil
		}
		state.sessionID = threadID
		if state.sessionStarted {
			return nil
		}
		state.sessionStarted = true
		return []normalizedChatEvent{{
			eventType: "chat.session_started",
			payload:   map[string]any{"sessionId": threadID},
		}}
	case "turn.started":
		// AO emits turn_started before spawning each one-shot Codex process so
		// startup/auth failures still have a balanced lifecycle.
		return nil
	case "turn.completed":
		events := make([]normalizedChatEvent, 0, 2)
		if raw := root["usage"]; len(raw) > 0 {
			var usage any
			if json.Unmarshal(raw, &usage) == nil {
				events = append(events, normalizedChatEvent{
					eventType: "chat.usage_updated",
					payload:   map[string]any{"usage": usage},
				})
			}
		}
		events = append(events, normalizedChatEvent{
			eventType: "chat.turn_completed",
			payload:   map[string]any{"isError": false},
		})
		state.startedTools = make(map[string]struct{})
		return events
	case "turn.failed":
		message := codexErrorMessage(root["error"])
		state.reportedError = true
		state.startedTools = make(map[string]struct{})
		return append(
			normalizedErrorEvents(message),
			normalizedChatEvent{
				eventType: "chat.turn_completed",
				payload: map[string]any{
					"isError": true,
					"error":   message,
				},
			},
		)
	case "error":
		state.reportedError = true
		return normalizedErrorEvents(rawString(root["message"]))
	case "item.started", "item.updated", "item.completed":
		return normalizeCodexItem(rawString(root["type"]), root["item"], state)
	default:
		return nil
	}
}

func normalizeCodexItem(
	eventType string,
	raw json.RawMessage,
	state *codexStreamState,
) []normalizedChatEvent {
	var item map[string]json.RawMessage
	if json.Unmarshal(raw, &item) != nil {
		return nil
	}
	itemType := rawString(item["type"])
	if itemType == "" {
		itemType = rawString(item["item_type"])
	}
	id := rawString(item["id"])

	switch itemType {
	case "agent_message":
		if eventType != "item.completed" {
			return nil
		}
		return []normalizedChatEvent{{
			eventType: "chat.assistant_message",
			payload:   map[string]any{"text": rawString(item["text"])},
		}}
	case "reasoning":
		if eventType != "item.completed" {
			return nil
		}
		return []normalizedChatEvent{{
			eventType: "chat.reasoning_message",
			payload:   map[string]any{"text": rawString(item["text"])},
		}}
	case "error":
		if eventType != "item.completed" {
			return nil
		}
		return normalizedErrorEvents(rawString(item["message"]))
	case "command_execution":
		input := map[string]any{"command": rawString(item["command"])}
		output := map[string]any{"output": rawString(item["aggregated_output"])}
		copyJSONField(output, "exitCode", item["exit_code"])
		return normalizeCodexTool(eventType, id, "command_execution", input, output, item, state)
	case "mcp_tool_call":
		name := rawString(item["tool"])
		if server := rawString(item["server"]); server != "" {
			name = server + "." + name
		}
		input := jsonValueMap(item["arguments"])
		output := map[string]any{}
		copyJSONField(output, "result", item["result"])
		copyJSONField(output, "error", item["error"])
		return normalizeCodexTool(eventType, id, name, input, output, item, state)
	case "file_change":
		if eventType != "item.completed" {
			return nil
		}
		input := jsonValueMap(item["changes"])
		return completedOnlyCodexTool(id, "file_change", input, map[string]any{}, item, state)
	case "web_search":
		if eventType != "item.completed" {
			return nil
		}
		input := map[string]any{"query": rawString(item["query"])}
		return completedOnlyCodexTool(id, "web_search", input, map[string]any{}, item, state)
	case "todo_list":
		input := jsonValueMap(item["items"])
		return normalizeCodexTool(eventType, id, "todo_list", input, map[string]any{}, item, state)
	default:
		return nil
	}
}

func normalizeCodexTool(
	protocolEvent string,
	id string,
	name string,
	input map[string]any,
	output map[string]any,
	item map[string]json.RawMessage,
	state *codexStreamState,
) []normalizedChatEvent {
	switch protocolEvent {
	case "item.started":
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
	case "item.updated":
		encoded, err := json.Marshal(input)
		if err != nil {
			return nil
		}
		return []normalizedChatEvent{{
			eventType: "chat.tool_input_delta",
			payload: map[string]any{
				"id":          id,
				"partialJson": string(encoded),
			},
		}}
	case "item.completed":
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
		status := rawString(item["status"])
		failed := status == "failed" || len(item["error"]) > 0 && string(item["error"]) != "null"
		completionType := "chat.tool_completed"
		if failed {
			completionType = "chat.tool_failed"
		}
		payload := map[string]any{"id": id, "output": output, "isError": failed}
		events = append(events, normalizedChatEvent{eventType: completionType, payload: payload})
		delete(state.startedTools, id)
		return events
	default:
		return nil
	}
}

func completedOnlyCodexTool(
	id string,
	name string,
	input map[string]any,
	output map[string]any,
	item map[string]json.RawMessage,
	state *codexStreamState,
) []normalizedChatEvent {
	return normalizeCodexTool("item.completed", id, name, input, output, item, state)
}

func codexErrorMessage(raw json.RawMessage) string {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) == nil {
		if message := rawString(object["message"]); message != "" {
			return message
		}
	}
	return rawString(raw)
}

func normalizedErrorEvents(message string) []normalizedChatEvent {
	if strings.TrimSpace(message) == "" {
		message = "agent runtime failed"
	}
	events := []normalizedChatEvent{{
		eventType: "chat.error",
		payload:   map[string]any{"message": message},
	}}
	if isAuthenticationError(message) {
		events = append(events, normalizedChatEvent{
			eventType: "chat.auth_status",
			payload: map[string]any{
				"status":  "invalid",
				"message": message,
			},
		})
	}
	return events
}

func jsonValueMap(raw json.RawMessage) map[string]any {
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]any{}
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return map[string]any{}
	}
	if encoded, ok := value.(string); ok {
		var nested any
		if json.Unmarshal([]byte(encoded), &nested) == nil {
			value = nested
		}
	}
	if object, ok := value.(map[string]any); ok {
		return object
	}
	return map[string]any{"value": value}
}
