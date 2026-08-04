package agentstream

import "fmt"

// ACPSessionUpdate is a thin, Go-side view of stable ACP v1 session/update
// notification payloads. It is deliberately SDK-free so adapters can map from
// coder/acp-go-sdk (or test fixtures) without this package importing the SDK.
//
// sessionUpdate values follow the public ACP v1 schema:
// agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update,
// plan, plan_update, plan_removed, and a few ignored lifecycle kinds.
type ACPSessionUpdate struct {
	// SessionUpdate is the ACP update kind (e.g. "agent_message_chunk").
	SessionUpdate string `json:"sessionUpdate"`

	// Message / thought chunks
	Content   any    `json:"content,omitempty"`
	MessageID string `json:"messageId,omitempty"`

	// Tool call
	ToolCallID string         `json:"toolCallId,omitempty"`
	Title      string         `json:"title,omitempty"`
	Name       string         `json:"name,omitempty"`
	Kind       string         `json:"kind,omitempty"`
	Status     string         `json:"status,omitempty"`
	RawInput   map[string]any `json:"rawInput,omitempty"`
	RawOutput  any            `json:"rawOutput,omitempty"`

	// Plan
	PlanID  string `json:"planId,omitempty"`
	Entries []any  `json:"entries,omitempty"`
	Plan    *struct {
		Type    string `json:"type,omitempty"`
		PlanID  string `json:"planId,omitempty"`
		Entries []any  `json:"entries,omitempty"`
	} `json:"plan,omitempty"`
}

// MapACPSessionUpdate converts one ACP session/update into a BridgeEvent.
// Returns ok=false for updates that have no stream representation (mode/config
// noise, empty text chunks). Modeled on ABF AcpAdapter.handleSessionUpdate.
func MapACPSessionUpdate(update ACPSessionUpdate) (BridgeEvent, bool) {
	switch update.SessionUpdate {
	case "agent_message_chunk":
		text := textFromContent(update.Content)
		if text == "" {
			return BridgeEvent{}, false
		}
		return BridgeEvent{
			Event:  "delta",
			Text:   text,
			ItemID: update.MessageID,
		}, true

	case "agent_thought_chunk":
		text := textFromContent(update.Content)
		if text == "" {
			return BridgeEvent{}, false
		}
		return BridgeEvent{
			Event:  "thinking",
			Text:   text,
			ItemID: update.MessageID,
		}, true

	case "tool_call":
		name := firstNonEmpty(update.Title, update.Name, update.Kind, "tool")
		return BridgeEvent{
			Event:      "tool",
			ToolCallID: update.ToolCallID,
			Name:       name,
			Input:      update.RawInput,
			Output:     update.RawOutput,
			ToolStatus: update.Status,
			IsUpdate:   false,
		}, true

	case "tool_call_update":
		name := firstNonEmpty(update.Title, update.Name, update.Kind, "tool")
		return BridgeEvent{
			Event:      "tool",
			ToolCallID: update.ToolCallID,
			Name:       name,
			Input:      update.RawInput,
			Output:     update.RawOutput,
			ToolStatus: update.Status,
			IsUpdate:   true,
		}, true

	case "plan":
		return BridgeEvent{
			Event:   "plan",
			Entries: update.Entries,
		}, true

	case "plan_update":
		be := BridgeEvent{Event: "plan"}
		if update.Plan != nil {
			be.PlanID = update.Plan.PlanID
			if update.Plan.Type == "items" {
				be.Entries = update.Plan.Entries
			}
			be.Data = map[string]any{"format": update.Plan.Type, "plan": update.Plan}
		}
		return be, true

	case "plan_removed":
		return BridgeEvent{
			Event:  "plan",
			PlanID: update.PlanID,
			Data:   map[string]any{"operation": "removed"},
		}, true

	// Accepted from agents but have no product consumer on the stream.
	case "usage_update", "current_mode_update", "config_option_update",
		"session_info_update", "available_commands_update", "user_message_chunk":
		return BridgeEvent{}, false

	default:
		return BridgeEvent{}, false
	}
}

// MapACPStopReason maps an ACP prompt stopReason to a terminal bridge event.
func MapACPStopReason(stopReason string) BridgeEvent {
	if stopReason == "cancelled" {
		return BridgeEvent{Event: "done", StopReason: "cancelled", Phase: "cancelled"}
	}
	return BridgeEvent{Event: "done", StopReason: stopReason}
}

// MapACPPermissionRequest maps a session/request_permission into a bridge event.
func MapACPPermissionRequest(requestID, toolCallID, title string, options []map[string]any) BridgeEvent {
	opts := make([]any, 0, len(options))
	for _, o := range options {
		opts = append(opts, o)
	}
	if title == "" {
		title = "tool"
	}
	return BridgeEvent{
		Event:      "permission",
		RequestID:  requestID,
		ToolCallID: toolCallID,
		Name:       title,
		Options:    opts,
	}
}

// MapACPError maps a transport/adapter failure to a bridge error.
func MapACPError(err error) BridgeEvent {
	msg := "Unknown error"
	if err != nil {
		msg = err.Error()
	}
	return BridgeEvent{Event: "error", Error: msg}
}

func textFromContent(content any) string {
	if content == nil {
		return ""
	}
	switch c := content.(type) {
	case string:
		return c
	case map[string]any:
		if t, ok := c["type"].(string); ok && t == "text" {
			if text, ok := c["text"].(string); ok {
				return text
			}
		}
		if text, ok := c["text"].(string); ok {
			return text
		}
		return ""
	default:
		// Arrays of content blocks: take first text.
		if arr, ok := content.([]any); ok {
			for _, item := range arr {
				if t := textFromContent(item); t != "" {
					return t
				}
			}
		}
		return fmt.Sprint(c)
	}
}
