package domain

import (
	"errors"
	"time"
)

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
	LatestSequence int64 `json:"latestSequence"`
	// Settings are the provider choices for the conversation's NEXT turn. Empty
	// fields mean the provider's own default, which is why a conversation nobody
	// configures behaves exactly as it did before these existed.
	Settings ConversationSettings `json:"settings"`
	// Usage is how full this conversation is. Nil until the provider reports.
	Usage *ConversationUsage `json:"usage,omitempty"`
	// RateLimits is where the account stands. Nil until the provider reports.
	RateLimits *ConversationRateLimits `json:"rateLimits,omitempty"`
	// CompactedAt is when the provider last summarized earlier history to reclaim
	// context. Nil means never. Held as conversation state as well as a timeline
	// entry so a client can tell whether compaction has run without walking an
	// unbounded timeline on every render.
	CompactedAt *time.Time `json:"compactedAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

// ConversationUsage is the conversation's token position.
//
// Latest-wins state on the conversation, not timeline entries. The provider
// reports this after every tool call, so a row per report is what buried the
// conversation the first time round; there is only ever one current answer to
// "how full is this".
type ConversationUsage struct {
	// ContextUsed and ContextWindow are what make the readout mean anything: a
	// used figure without the window is a number with no scale, which is exactly
	// what the header used to show.
	ContextUsed   int64 `json:"contextUsed"`
	ContextWindow int64 `json:"contextWindow"`
	// The cumulative spend for the conversation, which grows without bound and is
	// deliberately kept apart from the context figures above.
	InputTokens  int64 `json:"inputTokens"`
	OutputTokens int64 `json:"outputTokens"`
	CachedTokens int64 `json:"cachedTokens"`
	TotalTokens  int64 `json:"totalTokens"`
}

// ContextFraction is how full the context is, in 0..1, or -1 when the provider
// did not state a window.
//
// A caller must handle the negative case rather than dividing: without a window
// there is no honest fullness to report, and defaulting to 0 would draw an empty
// meter for a conversation that might be nearly full.
func (u ConversationUsage) ContextFraction() float64 {
	if u.ContextWindow <= 0 || u.ContextUsed < 0 {
		return -1
	}
	return float64(u.ContextUsed) / float64(u.ContextWindow)
}

// ConversationRateLimits is the account's quota position.
//
// Stored because it explains a class of failure the user cannot otherwise
// diagnose: a turn that fails for a reason unrelated to what they asked.
type ConversationRateLimits struct {
	// Percentages in 0..100. Negative means the provider did not report that
	// window, which is not the same as reporting it empty.
	PrimaryUsedPercent       float64 `json:"primaryUsedPercent"`
	SecondaryUsedPercent     float64 `json:"secondaryUsedPercent"`
	PrimaryResetsInSeconds   int64   `json:"primaryResetsInSeconds,omitempty"`
	SecondaryResetsInSeconds int64   `json:"secondaryResetsInSeconds,omitempty"`
	// PlanLabel is the provider's name for the account tier, when it says.
	PlanLabel string `json:"planLabel,omitempty"`
}

// WorstUsedPercent is the tighter of the two windows, or -1 when neither was
// reported. The tighter one is what will actually stop the next turn.
func (l ConversationRateLimits) WorstUsedPercent() float64 {
	worst := l.PrimaryUsedPercent
	if l.SecondaryUsedPercent > worst {
		worst = l.SecondaryUsedPercent
	}
	if worst < 0 {
		return -1
	}
	return worst
}

// ConversationSettings are the per-turn provider choices AO remembers.
//
// Durable rather than client-side because they must apply to turns AO dispatches
// on the user's behalf: a queued message draining after a restart, a relay from
// `ao send`. A preference held in the renderer would quietly stop applying the
// moment the user was not the one pressing send.
type ConversationSettings struct {
	// Model is the provider's model id. Empty means the provider's default.
	Model string `json:"model,omitempty"`
	// ReasoningEffort is how much thinking to spend, from the model's own list.
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	// ApprovalMode is AO's permission vocabulary, applied per turn.
	ApprovalMode PermissionMode `json:"approvalMode,omitempty"`
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
	// Diff is what the turn has changed on disk so far. Nil when the provider has
	// reported nothing, which is not the same as "changed nothing": a provider
	// without diff support never reports at all.
	Diff *ConversationTurnDiff `json:"diff,omitempty"`
}

// ConversationTurnDiff is the turn's changed-file summary.
//
// Per-turn state rather than a timeline entry: the provider re-sends the whole
// diff on each update, so this is overwritten, and a reader sees the current
// answer instead of a stack of repeats.
type ConversationTurnDiff struct {
	Files []ConversationDiffFile `json:"files"`
	// Truncated reports that the file list was cut at AO's cap. A cut list shown
	// as a whole one would understate the size of the change.
	Truncated bool `json:"truncated,omitempty"`
}

// ChatDiffTruncatedSummary marks a turn-diff event whose file list the driver had
// to cut at its cap.
//
// It travels in the event's Summary because ports.ChatTurnDiff has no field for
// it, and the fact cannot simply be dropped: a cut list rendered as a complete one
// would understate the size of the change. Declared here so the adapter that sets
// it and the projection that reads it share one spelling rather than two string
// literals that can drift apart silently.
const ChatDiffTruncatedSummary = "diff file list truncated"

// ConversationDiffFile is one changed path in a turn diff.
type ConversationDiffFile struct {
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	// Status is the change kind: added, modified, deleted, renamed.
	Status string `json:"status"`
	// OldPath is set only for a rename.
	OldPath string `json:"oldPath,omitempty"`
}

// QueuedTurn is a turn that was recorded but never dispatched, paired with the
// text that still has to be sent.
//
// A message the user typed while the agent was busy is durable before it is
// delivered, so the queue survives a daemon restart as data rather than living
// only in a controller's memory.
type QueuedTurn struct {
	TurnID string
	Text   string
	// ClientMessageID is carried through to the provider so a dispatch retried
	// after a crash cannot produce a second provider turn.
	ClientMessageID string
	Origin          MessageOrigin
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
	// CommandOutput is streamed command output accumulated from output deltas.
	// Held outside Detail because it is appended to many times per command, while
	// Detail is written whole.
	//
	// Its presence does not make the output complete: the provider was measured
	// dropping the first chunk from the delta stream and the aggregate alike. What
	// it buys is output while the command is still running, and output at all for a
	// command that never completes.
	CommandOutput string `json:"commandOutput,omitempty"`
	// CommandOutputTruncated reports that accumulation stopped at AO's cap.
	CommandOutputTruncated bool `json:"commandOutputTruncated,omitempty"`
}

// ErrNoConversation reports that a session has no conversation row yet. It is not
// a failure: a Chat session has no conversation until its controller first
// starts, and a reader should show an empty conversation rather than an error.
var ErrNoConversation = errors.New("session has no conversation")

// ErrNoQueuedTurn reports that nothing is waiting to be sent. Draining an empty
// queue is the normal case, not an error.
var ErrNoQueuedTurn = errors.New("no queued turn")
