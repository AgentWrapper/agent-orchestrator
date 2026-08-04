package agentstream

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// sessionStreamState tracks per-session sequencing and tool output diffs.
type sessionStreamState struct {
	sequence              int64
	source                Source
	toolOutputText        map[string]string
	defaultTextItemID     string
	defaultThinkingItemID string
}

// Normalizer converts BridgeEvent values into sequenced AgentStreamEvent
// values. Sequence numbers are strictly increasing per session (0-based).
//
// Modeled on AllBeingsFuture electron/services/agent-stream-normalizer.ts.
type Normalizer struct {
	mu       sync.Mutex
	sessions map[string]*sessionStreamState
	// now is injectable for tests; defaults to time.Now.
	now func() time.Time
}

// NewNormalizer builds an empty normalizer.
func NewNormalizer() *Normalizer {
	return &Normalizer{
		sessions: make(map[string]*sessionStreamState),
		now:      time.Now,
	}
}

// ConfigureSession sets the stream source for a session. Creating a new
// session resets sequence to start at 0 on the next event.
func (n *Normalizer) ConfigureSession(sessionID string, source Source) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if existing, ok := n.sessions[sessionID]; ok {
		existing.source = source
		return
	}
	n.sessions[sessionID] = newSessionState(source)
}

// ClearSession drops sequencing state for a session.
func (n *Normalizer) ClearSession(sessionID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.sessions, sessionID)
}

// Normalize maps one bridge event. Returns nil when the event should not be
// streamed (empty deltas, permission outcomes, ignored status phases, etc.).
// Terminal events (done/error/cancelled) clear tool-output tracking for the turn.
func (n *Normalizer) Normalize(sessionID string, event BridgeEvent) *Event {
	n.mu.Lock()
	defer n.mu.Unlock()

	state := n.ensureSessionLocked(sessionID)
	sequence := state.sequence + 1
	base := Event{
		SessionID: sessionID,
		Sequence:  sequence,
		Timestamp: n.now().UTC(),
		Source:    &Source{Kind: state.source.Kind, Provider: state.source.Provider},
	}

	var out *Event
	switch event.Event {
	case "delta":
		delta := event.Text
		if delta == "" {
			return nil
		}
		itemID := event.ItemID
		if itemID == "" {
			itemID = state.defaultTextItemID
		}
		e := base
		e.Type = TypeTextDelta
		e.ItemID = itemID
		e.Delta = delta
		out = &e

	case "thinking":
		text := event.Text
		if text == "" {
			text = event.Thinking
		}
		if text == "" {
			return nil
		}
		itemID := event.ItemID
		if itemID == "" {
			itemID = state.defaultThinkingItemID
		}
		e := base
		e.Type = TypeThinkingUpdate
		e.ItemID = itemID
		e.Text = text
		// Bridge adapters emit thinking chunks; the reducer appends by default.
		e.Mode = string(ThinkingDelta)
		out = &e

	case "tool":
		toolCallID := firstNonEmpty(event.ToolCallID, event.ToolName2, event.Name)
		if toolCallID == "" {
			toolCallID = fmt.Sprintf("tool-%d", sequence)
		}
		title := firstNonEmpty(event.Name, event.ToolName, event.ToolName2, "Tool")
		if !event.IsUpdate {
			e := base
			e.Type = TypeToolCall
			e.ToolCallID = toolCallID
			e.Title = title
			e.Name = firstNonEmpty(event.Name, event.ToolName, event.ToolName2)
			e.Input = firstMap(event.Input, event.ToolInput, event.ToolInput2)
			out = &e
			break
		}
		status := mapToolStatus(firstNonEmpty(event.ToolStatus, event.Status))
		fullText := formatOutputText(event.Output)
		previous := state.toolOutputText[toolCallID]
		var resultDelta string
		if fullText != "" {
			if len(fullText) >= len(previous) && fullText[:len(previous)] == previous {
				resultDelta = fullText[len(previous):]
			} else {
				resultDelta = fullText
			}
			state.toolOutputText[toolCallID] = fullText
		}
		e := base
		e.Type = TypeToolUpdate
		e.ToolCallID = toolCallID
		e.Status = status
		e.Name = firstNonEmpty(event.Name, event.ToolName, event.ToolName2)
		e.Title = title
		e.Input = firstMap(event.Input, event.ToolInput, event.ToolInput2)
		if resultDelta != "" {
			e.ResultDelta = resultDelta
			e.Output = &ToolOutput{Stream: "stdout", Text: resultDelta}
		}
		if status == ToolFailed {
			errMsg := event.Error
			if errMsg == "" {
				errMsg = fullText
			}
			if errMsg == "" {
				errMsg = "Tool failed"
			}
			e.Error = errMsg
		}
		out = &e

	case "plan":
		if event.Data != nil {
			if op, _ := event.Data["operation"].(string); op == "removed" {
				e := base
				e.Type = TypePlan
				e.Entries = []PlanEntry{}
				out = &e
				break
			}
		}
		entries := normalizePlanEntries(event.Entries)
		// Ignore plan lifecycle noise without displayable entries.
		if len(entries) == 0 && event.PlanID == "" {
			return nil
		}
		e := base
		e.Type = TypePlan
		if event.PlanID != "" {
			e.PlanTitle = event.PlanID
		}
		e.Entries = entries
		out = &e

	case "permission":
		// Only surface the initial request; outcomes stay internal to the adapter.
		if event.Outcome != nil {
			return nil
		}
		requestID := event.RequestID
		options := normalizePermissionOptions(event.Options)
		if requestID == "" || len(options) == 0 {
			return nil
		}
		title := event.Name
		if title == "" {
			title = "Permission required"
		}
		e := base
		e.Type = TypePermissionRequest
		e.Request = &PermissionRequest{
			RequestID:   requestID,
			ToolCallID:  event.ToolCallID,
			Title:       title,
			Description: event.Description,
			Options:     options,
		}
		out = &e

	case "status":
		switch event.Phase {
		case "running":
			e := base
			e.Type = TypeStatus
			e.StreamStatus = StatusRunning
			e.Message = event.Detail
			out = &e
		case "idle":
			e := base
			e.Type = TypeStatus
			e.StreamStatus = StatusIdle
			e.Message = event.Detail
			out = &e
		case "waiting", "waiting_permission":
			e := base
			e.Type = TypeStatus
			e.StreamStatus = StatusWaiting
			e.Message = event.Detail
			out = &e
		case "starting":
			e := base
			e.Type = TypeStatus
			e.StreamStatus = StatusStarting
			e.Message = event.Detail
			out = &e
		default:
			// ready and other non-UI phases are ignored
			return nil
		}

	case "done":
		if event.StopReason == "cancelled" || event.Phase == "cancelled" {
			e := base
			e.Type = TypeCancelled
			reason := event.StopReason
			if reason == "" {
				reason = "cancelled"
			}
			e.Reason = reason
			out = &e
		} else {
			e := base
			e.Type = TypeDone
			e.StopReason = event.StopReason
			out = &e
		}
		state.toolOutputText = make(map[string]string)

	case "error":
		msg := event.Error
		if msg == "" {
			msg = event.Message
		}
		if msg == "" {
			msg = "Unknown error"
		}
		e := base
		e.Type = TypeError
		e.Message = msg
		out = &e
		state.toolOutputText = make(map[string]string)

	case "agent_task":
		// Child-agent lifecycle is not part of the agent stream contract.
		return nil
	default:
		return nil
	}

	if out == nil {
		return nil
	}
	state.sequence = sequence
	return out
}

func (n *Normalizer) ensureSessionLocked(sessionID string) *sessionStreamState {
	state, ok := n.sessions[sessionID]
	if !ok {
		state = newSessionState(Source{Kind: SourceKindLegacyAdapter})
		n.sessions[sessionID] = state
	}
	return state
}

func newSessionState(source Source) *sessionStreamState {
	return &sessionStreamState{
		sequence:              -1,
		source:                source,
		toolOutputText:        make(map[string]string),
		defaultTextItemID:     "assistant-text",
		defaultThinkingItemID: "assistant-thinking",
	}
}

func mapPlanStatus(status any) PlanEntryStatus {
	s, _ := status.(string)
	switch s {
	case "cancelled", "failed", "blocked":
		return PlanBlocked
	case "in_progress", "completed", "pending":
		return PlanEntryStatus(s)
	default:
		return PlanPending
	}
}

func mapToolStatus(status string) ToolUpdateStatus {
	switch status {
	case "pending", "completed", "failed":
		return ToolUpdateStatus(status)
	case "in_progress":
		return ToolInProgress
	default:
		return ToolInProgress
	}
}

func mapPermissionKind(kind any) (PermissionOptionKind, bool) {
	s, ok := kind.(string)
	if !ok {
		return "", false
	}
	switch PermissionOptionKind(s) {
	case PermissionAllowOnce, PermissionAllowAlways, PermissionRejectOnce, PermissionRejectAlways:
		return PermissionOptionKind(s), true
	default:
		return "", false
	}
}

func normalizePlanEntries(entries []any) []PlanEntry {
	if len(entries) == 0 {
		return nil
	}
	out := make([]PlanEntry, 0, len(entries))
	for i, entry := range entries {
		record, _ := entry.(map[string]any)
		if record == nil {
			// json-decoded objects are map[string]any; tolerate structs via marshal.
			if b, err := json.Marshal(entry); err == nil {
				_ = json.Unmarshal(b, &record)
			}
		}
		if record == nil {
			record = map[string]any{}
		}
		content, _ := record["content"].(string)
		if content == "" {
			if t, ok := record["title"].(string); ok {
				content = t
			}
		}
		if content == "" {
			content = fmt.Sprintf("Step %d", i+1)
		}
		id, _ := record["id"].(string)
		if id == "" {
			id = fmt.Sprintf("plan-entry-%d", i)
		}
		out = append(out, PlanEntry{
			ID:     id,
			Title:  content,
			Status: mapPlanStatus(record["status"]),
		})
	}
	return out
}

func normalizePermissionOptions(options []any) []PermissionOption {
	if len(options) == 0 {
		return nil
	}
	out := make([]PermissionOption, 0, len(options))
	for _, option := range options {
		record, _ := option.(map[string]any)
		if record == nil {
			if b, err := json.Marshal(option); err == nil {
				_ = json.Unmarshal(b, &record)
			}
		}
		if record == nil {
			continue
		}
		optionID, _ := record["optionId"].(string)
		label, _ := record["name"].(string)
		if label == "" {
			if l, ok := record["label"].(string); ok {
				label = l
			}
		}
		kind, ok := mapPermissionKind(record["kind"])
		if optionID == "" || label == "" || !ok {
			continue
		}
		out = append(out, PermissionOption{OptionID: optionID, Label: label, Kind: kind})
	}
	return out
}

func formatOutputText(value any) string {
	if value == nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	case float64, float32, int, int64, int32, bool:
		return fmt.Sprint(v)
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprint(v)
		}
		return string(b)
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstMap(vals ...map[string]any) map[string]any {
	for _, v := range vals {
		if v != nil {
			return v
		}
	}
	return nil
}
