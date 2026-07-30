package worker

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
)

const (
	maxClaudeStreamLine = 8 << 20
	maxClaudeStderr     = 64 << 10
)

func (r *Runner) runStructuredClaude(
	ctx context.Context,
	adapterArgv []string,
	environment []string,
) error {
	existingSessionID := r.bootstrap.Launch.Session.AgentSessionID
	argv, err := structuredClaudeArgv(adapterArgv, existingSessionID)
	if err != nil {
		return err
	}
	sessionID := existingSessionID
	if sessionID == "" {
		sessionID = claudeSessionID(argv)
	}
	if sessionID == "" {
		sessionID = string(r.bootstrap.Launch.Session.ID)
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	command := exec.CommandContext(runCtx, argv[0], argv[1:]...)
	command.Dir = r.workspaceDir
	command.Env = environment
	stdin, err := command.StdinPipe()
	if err != nil {
		return fmt.Errorf("open Claude stdin: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return fmt.Errorf("open Claude stdout: %w", err)
	}
	stderr := newTailBuffer(maxClaudeStderr)
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("start structured Claude runtime: %w", err)
	}
	_ = r.client.Event(ctx, "agent.started", map[string]any{
		"harness": "claude-code",
		"argv0":   filepath.Base(argv[0]),
		"mode":    "stream-json",
	})

	writer := &claudeInputWriter{writer: stdin, sessionID: sessionID}
	heartbeatCtx, cancelHeartbeat := context.WithCancel(runCtx)
	var heartbeatWG sync.WaitGroup
	heartbeatWG.Add(1)
	go func() {
		defer heartbeatWG.Done()
		r.heartbeatLoop(heartbeatCtx)
	}()
	commandCtx, cancelCommands := context.WithCancel(runCtx)
	var commandWG sync.WaitGroup
	commandWG.Add(1)
	go func() {
		defer commandWG.Done()
		r.structuredCommandLoop(commandCtx, writer)
	}()

	readErr := r.streamClaudeOutput(runCtx, stdout)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		cancel()
	}
	waitErr := command.Wait()
	cancelHeartbeat()
	cancelCommands()
	_ = stdin.Close()
	heartbeatWG.Wait()
	commandWG.Wait()

	exitCode := 0
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() == nil && readErr == nil {
			return fmt.Errorf("wait for structured Claude runtime: %w", waitErr)
		}
	}
	_ = r.client.Event(context.Background(), "agent.exited", map[string]any{"exitCode": exitCode})
	if readErr != nil && !errors.Is(readErr, io.EOF) && ctx.Err() == nil {
		return fmt.Errorf("read structured Claude output: %w", readErr)
	}
	if waitErr != nil && ctx.Err() == nil {
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return fmt.Errorf("structured Claude runtime exited with code %d: %s", exitCode, message)
		}
		return fmt.Errorf("structured Claude runtime exited with code %d", exitCode)
	}
	return nil
}

func structuredClaudeArgv(argv []string, resumeSessionID string) ([]string, error) {
	if len(argv) == 0 {
		return nil, errors.New("claude launch command is empty")
	}
	result := make([]string, 0, len(argv)+7)
	result = append(result, argv[0])
	for index := 1; index < len(argv); index++ {
		argument := argv[index]
		if argument == "--" {
			break
		}
		if resumeSessionID != "" &&
			(argument == "--session-id" || argument == "--resume") {
			if index+1 < len(argv) {
				index++
			}
			continue
		}
		result = append(result, argument)
	}
	if resumeSessionID != "" {
		result = append(result, "--resume", resumeSessionID)
	}
	result = append(
		result,
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
	)
	return result, nil
}

func claudeSessionID(argv []string) string {
	for index := 1; index+1 < len(argv); index++ {
		if argv[index] == "--session-id" {
			return argv[index+1]
		}
	}
	return ""
}

type claudeInputWriter struct {
	mu        sync.Mutex
	writer    io.Writer
	sessionID string
}

type structuredPromptWriter interface {
	Prompt(string, int64) error
	Interrupt() (bool, error)
	AcknowledgeOnWrite() bool
}

func (w *claudeInputWriter) Prompt(text string, _ int64) error {
	envelope := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role": "user",
			"content": []map[string]string{{
				"type": "text",
				"text": text,
			}},
		},
		"parent_tool_use_id": nil,
		"session_id":         w.sessionID,
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("encode Claude prompt: %w", err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := w.writer.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("write Claude prompt: %w", err)
	}
	return nil
}

func (w *claudeInputWriter) AcknowledgeOnWrite() bool {
	return true
}

func (w *claudeInputWriter) Interrupt() (bool, error) {
	envelope := map[string]any{
		"type":       "control_request",
		"request_id": uuid.NewString(),
		"request": map[string]string{
			"subtype": "interrupt",
		},
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return false, fmt.Errorf("encode Claude interrupt: %w", err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := w.writer.Write(append(encoded, '\n')); err != nil {
		return false, fmt.Errorf("write Claude interrupt: %w", err)
	}
	return true, nil
}

func (r *Runner) structuredCommandLoop(ctx context.Context, writer structuredPromptWriter) {
	backoff := time.Second
	var highestPrompt atomic.Int64
	var acknowledgedPrompt int64
	for ctx.Err() == nil {
		if highest := highestPrompt.Load(); writer.AcknowledgeOnWrite() && highest > acknowledgedPrompt {
			if err := r.acknowledgePrompt(ctx, highest); err != nil {
				if !waitForRetry(ctx, backoff) {
					return
				}
				if backoff < 8*time.Second {
					backoff *= 2
				}
				continue
			}
			acknowledgedPrompt = highest
		}
		connectionStartedAt := time.Now()
		err := r.client.RunCommandStream(ctx, highestPrompt.Load(), func(command cloudworkerhub.Command) error {
			before := highestPrompt.Load()
			interrupted, err := handleStructuredCommand(command, writer, &highestPrompt)
			if err != nil {
				return err
			}
			if interrupted {
				return r.reportTurnInterrupted(ctx, command.Sequence)
			}
			if !writer.AcknowledgeOnWrite() ||
				command.Sequence <= before ||
				command.Sequence <= 0 {
				return nil
			}
			if err := r.acknowledgePrompt(ctx, command.Sequence); err != nil {
				return err
			}
			acknowledgedPrompt = command.Sequence
			return nil
		})
		if ctx.Err() != nil {
			return
		}
		stableConnection := time.Since(connectionStartedAt) >= 10*time.Second
		if stableConnection {
			backoff = time.Second
		}
		_ = r.client.Event(ctx, "worker.command_stream_disconnected", map[string]string{"error": err.Error()})
		if !waitForRetry(ctx, backoff) {
			return
		}
		if !stableConnection && backoff < 8*time.Second {
			backoff *= 2
		}
	}
}

func (r *Runner) acknowledgePrompt(ctx context.Context, sequence int64) error {
	return r.client.Event(ctx, "worker.prompt_accepted", map[string]int64{"sequence": sequence})
}

func waitForRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func handleStructuredCommand(
	command cloudworkerhub.Command,
	writer structuredPromptWriter,
	highestPrompt *atomic.Int64,
) (bool, error) {
	if command.Type == "interrupt" {
		return writer.Interrupt()
	}
	if command.Type != "prompt" {
		return false, nil
	}
	if command.Sequence > 0 && command.Sequence <= highestPrompt.Load() {
		return false, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(command.Data)
	if err != nil || len(decoded) == 0 || len(decoded) > 64<<10 {
		return false, errors.New("decode structured prompt")
	}
	if err := writer.Prompt(string(decoded), command.Sequence); err != nil {
		return false, err
	}
	if command.Sequence > 0 {
		highestPrompt.Store(command.Sequence)
	}
	return false, nil
}

type claudeStreamState struct {
	sawTextDelta      bool
	sawReasoningDelta bool
	startedTools      map[string]struct{}
}

type normalizedChatEvent struct {
	eventType string
	payload   map[string]any
}

func (r *Runner) streamClaudeOutput(ctx context.Context, output io.Reader) error {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64<<10), maxClaudeStreamLine)
	state := &claudeStreamState{}
	for scanner.Scan() {
		for _, event := range normalizeClaudeLine(scanner.Bytes(), state) {
			if err := r.client.Event(ctx, event.eventType, event.payload); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}

func normalizeClaudeLine(line []byte, state *claudeStreamState) []normalizedChatEvent {
	var root map[string]json.RawMessage
	if json.Unmarshal(line, &root) != nil {
		return nil
	}
	var eventType string
	if json.Unmarshal(root["type"], &eventType) != nil {
		return nil
	}
	switch eventType {
	case "system":
		subtype := rawString(root["subtype"])
		if subtype == "compact_boundary" {
			return []normalizedChatEvent{{
				eventType: "chat.context_compacted",
				payload:   map[string]any{},
			}}
		}
		if subtype != "init" {
			return nil
		}
		payload := map[string]any{}
		payload["subtype"] = subtype
		copyJSONField(payload, "sessionId", root["session_id"])
		copyJSONField(payload, "model", root["model"])
		copyJSONField(payload, "tools", root["tools"])
		return []normalizedChatEvent{{
			eventType: "chat.session_started",
			payload:   payload,
		}}
	case "stream_event":
		return normalizeClaudeStreamEvent(root["event"], state)
	case "assistant":
		var message struct {
			Content []struct {
				Type     string          `json:"type"`
				Text     string          `json:"text"`
				Thinking string          `json:"thinking"`
				ID       string          `json:"id"`
				Name     string          `json:"name"`
				Input    json.RawMessage `json:"input"`
			} `json:"content"`
		}
		if json.Unmarshal(root["message"], &message) != nil {
			return nil
		}
		events := make([]normalizedChatEvent, 0)
		var text, reasoning strings.Builder
		for _, block := range message.Content {
			switch block.Type {
			case "text":
				text.WriteString(block.Text)
			case "thinking":
				reasoning.WriteString(block.Thinking)
			case "tool_use":
				if state.startedTools == nil {
					state.startedTools = make(map[string]struct{})
				}
				if _, exists := state.startedTools[block.ID]; exists {
					continue
				}
				state.startedTools[block.ID] = struct{}{}
				payload := map[string]any{"id": block.ID, "name": block.Name}
				if len(block.Input) > 0 {
					var input any
					if json.Unmarshal(block.Input, &input) == nil {
						payload["input"] = input
					}
				}
				events = append(events, normalizedChatEvent{
					eventType: "chat.tool_started",
					payload:   payload,
				})
			}
		}
		if reasoning.Len() > 0 && !state.sawReasoningDelta {
			events = append(events, normalizedChatEvent{
				eventType: "chat.reasoning_message",
				payload:   map[string]any{"text": reasoning.String()},
			})
		}
		if text.Len() > 0 && !state.sawTextDelta {
			events = append(events, normalizedChatEvent{
				eventType: "chat.assistant_message",
				payload:   map[string]any{"text": text.String()},
			})
		}
		return events
	case "user":
		return normalizeClaudeToolResults(root["message"])
	case "result":
		payload := map[string]any{"isError": rawBool(root["is_error"])}
		copyJSONField(payload, "subtype", root["subtype"])
		copyJSONField(payload, "result", root["result"])
		copyJSONField(payload, "durationMs", root["duration_ms"])
		copyJSONField(payload, "costUsd", root["total_cost_usd"])
		copyJSONField(payload, "usage", root["usage"])
		events := make([]normalizedChatEvent, 0, 3)
		if raw := root["usage"]; len(raw) > 0 {
			var usage any
			if json.Unmarshal(raw, &usage) == nil {
				events = append(events, normalizedChatEvent{
					eventType: "chat.usage_updated",
					payload:   map[string]any{"usage": usage},
				})
			}
		}
		resultText := rawString(root["result"])
		if rawBool(root["is_error"]) &&
			(strings.Contains(strings.ToLower(resultText), "oauth") ||
				strings.Contains(resultText, "401")) {
			events = append(events, normalizedChatEvent{
				eventType: "chat.auth_status",
				payload: map[string]any{
					"status":  "invalid",
					"message": resultText,
				},
			})
		}
		events = append(events, normalizedChatEvent{eventType: "chat.turn_completed", payload: payload})
		state.sawTextDelta = false
		state.sawReasoningDelta = false
		state.startedTools = nil
		return events
	case "compact_boundary":
		return []normalizedChatEvent{{
			eventType: "chat.context_compacted",
			payload:   map[string]any{},
		}}
	default:
		return nil
	}
}

func normalizeClaudeToolResults(raw json.RawMessage) []normalizedChatEvent {
	var message struct {
		Content []struct {
			Type      string `json:"type"`
			ToolUseID string `json:"tool_use_id"`
			Content   any    `json:"content"`
			IsError   bool   `json:"is_error"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &message) != nil {
		return nil
	}
	events := make([]normalizedChatEvent, 0)
	for _, block := range message.Content {
		if block.Type != "tool_result" {
			continue
		}
		eventType := "chat.tool_completed"
		if block.IsError {
			eventType = "chat.tool_failed"
		}
		events = append(events, normalizedChatEvent{
			eventType: eventType,
			payload: map[string]any{
				"id":      block.ToolUseID,
				"output":  block.Content,
				"isError": block.IsError,
			},
		})
	}
	return events
}

func normalizeClaudeStreamEvent(raw json.RawMessage, state *claudeStreamState) []normalizedChatEvent {
	var event struct {
		Type  string `json:"type"`
		Index int    `json:"index"`
		Delta struct {
			Type        string `json:"type"`
			Text        string `json:"text"`
			Thinking    string `json:"thinking"`
			PartialJSON string `json:"partial_json"`
		} `json:"delta"`
		ContentBlock struct {
			Type  string          `json:"type"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content_block"`
		Message json.RawMessage `json:"message"`
		Usage   json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(raw, &event) != nil {
		return nil
	}
	switch {
	case event.Type == "message_start":
		payload := map[string]any{}
		if len(event.Message) > 0 {
			var message any
			if json.Unmarshal(event.Message, &message) == nil {
				payload["message"] = message
			}
		}
		return []normalizedChatEvent{{eventType: "chat.turn_started", payload: payload}}
	case event.Type == "content_block_delta" &&
		event.Delta.Type == "text_delta" &&
		event.Delta.Text != "":
		state.sawTextDelta = true
		return []normalizedChatEvent{{
			eventType: "chat.assistant_delta",
			payload:   map[string]any{"text": event.Delta.Text},
		}}
	case event.Type == "content_block_delta" &&
		event.Delta.Type == "thinking_delta" &&
		event.Delta.Thinking != "":
		state.sawReasoningDelta = true
		return []normalizedChatEvent{{
			eventType: "chat.reasoning_delta",
			payload:   map[string]any{"text": event.Delta.Thinking},
		}}
	case event.Type == "content_block_delta" &&
		event.Delta.Type == "input_json_delta" &&
		event.Delta.PartialJSON != "":
		return []normalizedChatEvent{{
			eventType: "chat.tool_input_delta",
			payload: map[string]any{
				"index":       event.Index,
				"partialJson": event.Delta.PartialJSON,
			},
		}}
	case event.Type == "content_block_start" && event.ContentBlock.Type == "tool_use":
		if state.startedTools == nil {
			state.startedTools = make(map[string]struct{})
		}
		state.startedTools[event.ContentBlock.ID] = struct{}{}
		payload := map[string]any{
			"id":   event.ContentBlock.ID,
			"name": event.ContentBlock.Name,
		}
		if len(event.ContentBlock.Input) > 0 {
			var input any
			if json.Unmarshal(event.ContentBlock.Input, &input) == nil {
				payload["input"] = input
			}
		}
		return []normalizedChatEvent{{eventType: "chat.tool_started", payload: payload}}
	case event.Type == "message_delta" && len(event.Usage) > 0:
		var usage any
		if json.Unmarshal(event.Usage, &usage) != nil {
			return nil
		}
		return []normalizedChatEvent{{
			eventType: "chat.usage_updated",
			payload:   map[string]any{"usage": usage},
		}}
	default:
		return nil
	}
}

func rawBool(raw json.RawMessage) bool {
	var value bool
	_ = json.Unmarshal(raw, &value)
	return value
}

func rawString(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}

func copyJSONField(target map[string]any, name string, raw json.RawMessage) {
	if len(raw) == 0 || string(raw) == "null" {
		return
	}
	var value any
	if json.Unmarshal(raw, &value) == nil {
		target[name] = value
	}
}

type tailBuffer struct {
	mu       sync.Mutex
	maxBytes int
	data     []byte
}

func newTailBuffer(maxBytes int) *tailBuffer {
	return &tailBuffer{maxBytes: maxBytes}
}

func (b *tailBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, data...)
	if len(b.data) > b.maxBytes {
		b.data = append([]byte(nil), b.data[len(b.data)-b.maxBytes:]...)
	}
	return len(data), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(append([]byte(nil), b.data...))
}
