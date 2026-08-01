package domain

import "time"

// The durable conversation model for Chat-mode sessions.
//
// Two deliberate shapes here, both learned from how existing chat products
// settle:
//
//   - Messages and activities are separate records, not one polymorphic "item"
//     row. Assistant text is mutated in place as deltas arrive; a command
//     execution or approval is written once with a typed payload. Those are
//     different write patterns and fighting them in one table costs more than
//     the extra type.
//
//   - Sequence is conversation-scoped, assigned on insert, and immutable.
//     Timestamps are display metadata: provider events arrive out of order and
//     several can share a millisecond, so ordering must not depend on them.
//
// The provider conversation remains authoritative for model context. These rows
// are authoritative for what AO renders and for delivery state — AO never
// maintains a second independently writable model transcript.

// ConversationScope says whether a conversation belongs to a project (the
// orchestrator narrative, which outlives any single orchestrator session) or to
// one session (a worker).
type ConversationScope string

// Conversation scopes.
const (
	ConversationScopeSession ConversationScope = "session"
	ConversationScopeProject ConversationScope = "project"
)

// TurnState is the lifecycle of one request and the agent work that follows it.
type TurnState string

// Turn states. Interrupted is distinct from failed: the provider reports it as
// its own terminal status when a turn is cancelled, and AO must not relabel it.
const (
	TurnStateQueued      TurnState = "queued"
	TurnStateRunning     TurnState = "running"
	TurnStateCompleted   TurnState = "completed"
	TurnStateInterrupted TurnState = "interrupted"
	TurnStateFailed      TurnState = "failed"
)

// Terminal reports whether no further work is expected on the turn.
func (s TurnState) Terminal() bool {
	switch s {
	case TurnStateCompleted, TurnStateInterrupted, TurnStateFailed:
		return true
	default:
		return false
	}
}

// MessageRole distinguishes what the reader sees as their own text from the
// agent's.
type MessageRole string

// Message roles.
const (
	MessageRoleUser      MessageRole = "user"
	MessageRoleAssistant MessageRole = "assistant"
)

// MessageOrigin records who produced a message. It is durable and structural:
// worker and automation identity is never inferred from a text prefix.
type MessageOrigin string

// Message origins.
const (
	MessageOriginHuman      MessageOrigin = "human"
	MessageOriginAutomation MessageOrigin = "automation"
	MessageOriginDaemon     MessageOrigin = "daemon"
	MessageOriginProvider   MessageOrigin = "provider"
)

// ActivityKind is the type of a non-message timeline entry. Provider-specific
// detail lives in the activity's typed payload, never in a new kind per
// provider event subtype.
type ActivityKind string

// Activity kinds. Reasoning is retained as its own kind so it can be excluded
// from display without parsing message text.
const (
	ActivityKindCommand    ActivityKind = "command"
	ActivityKindFileChange ActivityKind = "file_change"
	ActivityKindPlan       ActivityKind = "plan"
	ActivityKindReasoning  ActivityKind = "reasoning"
	ActivityKindApproval   ActivityKind = "approval"
	ActivityKindUsage      ActivityKind = "usage"
	ActivityKindError      ActivityKind = "error"
	ActivityKindSystem     ActivityKind = "system"
)

// ActivityStatus is the lifecycle of one activity. Started items are not
// guaranteed to complete — a provider can start a command and supersede it — so
// readers must tolerate an activity that stays running.
type ActivityStatus string

// Activity statuses.
const (
	ActivityStatusRunning   ActivityStatus = "running"
	ActivityStatusCompleted ActivityStatus = "completed"
	ActivityStatusFailed    ActivityStatus = "failed"
	ActivityStatusPending   ActivityStatus = "pending"
	ActivityStatusResolved  ActivityStatus = "resolved"
)

// ConversationRecord is the durable head of one narrative.
type ConversationRecord struct {
	ID    string            `json:"id"`
	Scope ConversationScope `json:"scope"`
	// ProjectID is set for both scopes; SessionID only for session scope.
	ProjectID ProjectID `json:"projectId"`
	SessionID SessionID `json:"sessionId,omitempty"`
	// LatestSequence is the highest sequence handed out in this conversation.
	// New messages and activities take LatestSequence+1 under the same
	// transaction that bumps it, so ordering has a single writer.
	LatestSequence int64     `json:"latestSequence"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// ConversationTurn is one user or automation request plus the agent work it
// caused.
type ConversationTurn struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	// HandledBySessionID is the AO session whose controller ran the turn. For a
	// project-scoped conversation this changes when the orchestrator is
	// replaced; the conversation identity does not.
	HandledBySessionID SessionID `json:"handledBySessionId"`
	// ProviderTurnID correlates back to the provider's own turn. Opaque.
	ProviderTurnID string    `json:"providerTurnId,omitempty"`
	State          TurnState `json:"state"`
	// ErrorMessage is set for failed turns. Interrupted turns are not errors.
	ErrorMessage string     `json:"errorMessage,omitempty"`
	RequestedAt  time.Time  `json:"requestedAt"`
	StartedAt    *time.Time `json:"startedAt,omitempty"`
	CompletedAt  *time.Time `json:"completedAt,omitempty"`
}

// ConversationMessage is one readable block of text.
type ConversationMessage struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	TurnID         string `json:"turnId,omitempty"`
	Sequence       int64  `json:"sequence"`
	// Revision increases each time streaming rewrites this message's text, so a
	// client can detect a gap and resync instead of rendering stale text.
	Revision int64         `json:"revision"`
	Role     MessageRole   `json:"role"`
	Origin   MessageOrigin `json:"origin"`
	Text     string        `json:"text"`
	// Streaming is true while more deltas are expected.
	Streaming bool `json:"streaming"`
	// ProviderItemID deduplicates provider observations of the same message.
	ProviderItemID string `json:"providerItemId,omitempty"`
	// ClientMessageID is the caller-supplied idempotency key for user messages.
	// A retry carrying the same key must not create a second provider turn.
	ClientMessageID string    `json:"clientMessageId,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// ConversationActivity is one non-message timeline entry: a command, a diff, a
// plan, an approval request, a usage report, an error.
type ConversationActivity struct {
	ID             string         `json:"id"`
	ConversationID string         `json:"conversationId"`
	TurnID         string         `json:"turnId,omitempty"`
	Sequence       int64          `json:"sequence"`
	Revision       int64          `json:"revision"`
	Kind           ActivityKind   `json:"kind"`
	Status         ActivityStatus `json:"status"`
	// Summary is the one-line label a client renders when collapsed.
	Summary string `json:"summary"`
	// Detail is the typed provider-neutral payload for this kind, as JSON. It
	// never carries provider DTOs verbatim.
	Detail []byte `json:"detail,omitempty"`
	// RequestID is the provider's request identifier for approval activities.
	// Resolving an approval matches on this, so a stale card cannot resolve a
	// newer request.
	RequestID      string    `json:"requestId,omitempty"`
	ProviderItemID string    `json:"providerItemId,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}
