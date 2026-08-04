// Package agentstream defines the provider-neutral agent stream contract and
// the normalizer that turns adapter-internal bridge events into sequenced
// AgentStreamEvent values for HTTP/SSE clients.
//
// Semantics match AllBeingsFuture's AgentStreamEvent / StreamNormalizer
// (stable ACP v1 product surface): text_delta, thinking_update, tool_call,
// tool_update, plan, status, permission_request, done, error, cancelled.
// The renderer must never speak ACP; it consumes only these events.
package agentstream

import "time"

// Source identifies which adapter produced a stream event.
type Source struct {
	// Kind is "native-acp-v1" or "legacy-adapter".
	Kind     string `json:"kind"`
	Provider string `json:"provider,omitempty"`
}

// Known source kinds.
const (
	SourceKindNativeACPv1   = "native-acp-v1"
	SourceKindLegacyAdapter = "legacy-adapter"
)

// PlanEntryStatus is one plan step state.
type PlanEntryStatus string

// Plan entry statuses.
const (
	PlanPending    PlanEntryStatus = "pending"
	PlanInProgress PlanEntryStatus = "in_progress"
	PlanCompleted  PlanEntryStatus = "completed"
	PlanBlocked    PlanEntryStatus = "blocked"
)

// PlanEntry is one step in a plan.
type PlanEntry struct {
	ID     string          `json:"id"`
	Title  string          `json:"title"`
	Status PlanEntryStatus `json:"status"`
}

// PermissionOptionKind is a stable permission choice family.
type PermissionOptionKind string

// Permission option kinds.
const (
	PermissionAllowOnce    PermissionOptionKind = "allow_once"
	PermissionAllowAlways  PermissionOptionKind = "allow_always"
	PermissionRejectOnce   PermissionOptionKind = "reject_once"
	PermissionRejectAlways PermissionOptionKind = "reject_always"
)

// PermissionOption is one choice offered for a permission request.
type PermissionOption struct {
	OptionID string               `json:"optionId"`
	Label    string               `json:"label"`
	Kind     PermissionOptionKind `json:"kind"`
}

// PermissionRequest is a structured permission prompt for the UI.
type PermissionRequest struct {
	RequestID   string             `json:"requestId"`
	ToolCallID  string             `json:"toolCallId,omitempty"`
	Title       string             `json:"title"`
	Description string             `json:"description,omitempty"`
	Options     []PermissionOption `json:"options"`
}

// EventType is the wire type of a stream event.
type EventType string

// Stream event types (ABF AgentStreamEvent).
const (
	TypeTextDelta         EventType = "text_delta"
	TypeThinkingUpdate    EventType = "thinking_update"
	TypeToolCall          EventType = "tool_call"
	TypeToolUpdate        EventType = "tool_update"
	TypePlan              EventType = "plan"
	TypeStatus            EventType = "status"
	TypePermissionRequest EventType = "permission_request"
	TypeDone              EventType = "done"
	TypeError             EventType = "error"
	TypeCancelled         EventType = "cancelled"
)

// ToolUpdateStatus is a tool call lifecycle state.
type ToolUpdateStatus string

// Tool update statuses.
const (
	ToolPending    ToolUpdateStatus = "pending"
	ToolInProgress ToolUpdateStatus = "in_progress"
	ToolCompleted  ToolUpdateStatus = "completed"
	ToolFailed     ToolUpdateStatus = "failed"
)

// StreamStatus is a coarse agent phase for the status event.
type StreamStatus string

// Stream status values.
const (
	StatusStarting StreamStatus = "starting"
	StatusRunning  StreamStatus = "running"
	StatusWaiting  StreamStatus = "waiting"
	StatusIdle     StreamStatus = "idle"
)

// ThinkingMode controls how thinking text is applied.
type ThinkingMode string

// Thinking modes.
const (
	ThinkingDelta   ThinkingMode = "delta"
	ThinkingReplace ThinkingMode = "replace"
)

// ToolOutput is optional structured tool result text.
type ToolOutput struct {
	Stream string `json:"stream"` // stdout | stderr
	Text   string `json:"text"`
}

// Event is the provider-neutral stream event a client reduces.
// Optional fields are populated according to Type.
type Event struct {
	Type      EventType `json:"type"`
	SessionID string    `json:"sessionId"`
	// Sequence is monotonic per session (0-based). Clients ignore duplicates
	// and can reconnect with after=<last applied sequence>.
	Sequence  int64     `json:"sequence"`
	Timestamp time.Time `json:"timestamp,omitempty"`
	Source    *Source   `json:"source,omitempty"`

	// text_delta / thinking_update
	ItemID string `json:"itemId,omitempty"`
	Delta  string `json:"delta,omitempty"`
	Text   string `json:"text,omitempty"`
	Mode   string `json:"mode,omitempty"` // delta | replace for thinking

	// tool_call / tool_update
	ToolCallID  string           `json:"toolCallId,omitempty"`
	Name        string           `json:"name,omitempty"`
	Title       string           `json:"title,omitempty"`
	Input       map[string]any   `json:"input,omitempty"`
	Status      ToolUpdateStatus `json:"status,omitempty"`
	ResultDelta string           `json:"resultDelta,omitempty"`
	Output      *ToolOutput      `json:"output,omitempty"`
	Error       string           `json:"error,omitempty"`

	// plan
	PlanTitle string      `json:"planTitle,omitempty"`
	Entries   []PlanEntry `json:"entries,omitempty"`

	// status
	StreamStatus StreamStatus `json:"streamStatus,omitempty"`
	Message      string       `json:"message,omitempty"`

	// permission_request
	Request *PermissionRequest `json:"request,omitempty"`

	// done / cancelled
	StopReason string `json:"stopReason,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

// IsTerminal reports whether the event ends a turn (clients flush turn state).
func (e Event) IsTerminal() bool {
	switch e.Type {
	case TypeDone, TypeError, TypeCancelled:
		return true
	default:
		return false
	}
}

// BridgeEvent is the adapter-internal event shape (ABF BridgeEvent). Drivers
// map ACP session/update (and legacy adapters) into this before normalization.
type BridgeEvent struct {
	Event string `json:"event"` // delta|done|error|tool|thinking|plan|permission|status|agent_task

	Text    string `json:"text,omitempty"`
	ItemID  string `json:"itemId,omitempty"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`

	// Thinking
	Thinking string `json:"thinking,omitempty"`

	// Tool
	ToolCallID string         `json:"toolCallId,omitempty"`
	Name       string         `json:"name,omitempty"`
	ToolName   string         `json:"toolName,omitempty"`
	ToolName2  string         `json:"tool_name,omitempty"`
	Input      map[string]any `json:"input,omitempty"`
	ToolInput  map[string]any `json:"toolInput,omitempty"`
	ToolInput2 map[string]any `json:"tool_input,omitempty"`
	Output     any            `json:"output,omitempty"`
	ToolStatus string         `json:"toolStatus,omitempty"`
	Status     string         `json:"status,omitempty"`
	IsUpdate   bool           `json:"isUpdate,omitempty"`

	// Plan
	PlanID  string         `json:"planId,omitempty"`
	Entries []any          `json:"entries,omitempty"`
	Data    map[string]any `json:"data,omitempty"`

	// Permission
	RequestID   string `json:"requestId,omitempty"`
	Description string `json:"description,omitempty"`
	Options     []any  `json:"options,omitempty"`
	Outcome     any    `json:"outcome,omitempty"`

	// Status / done
	Phase      string `json:"phase,omitempty"`
	Detail     string `json:"detail,omitempty"`
	StopReason string `json:"stopReason,omitempty"`
}
