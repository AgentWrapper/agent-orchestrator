package ports

import (
	"context"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// The Chat controller contract.
//
// This is deliberately separate from the Agent/Runtime ports: those describe
// launching a provider's native CLI into a terminal and writing keystrokes at
// it. A Chat driver speaks a machine protocol and reports typed events. Stretching
// one contract over both would make every call site guess which one it has.
//
// Rules this port exists to keep:
//   - provider DTOs never escape the adapter; callers see domain vocabulary;
//   - terminal byte streams are never a source of Chat events;
//   - an empty user message is not "press Enter"; there is no keystroke concept;
//   - shell-terminal lifecycle is unrelated to conversation lifecycle.

// Errors a Chat driver returns. They map to stable API error codes, so a client
// can tell "this harness cannot do Chat" from "Codex is not logged in".
var (
	// ErrChatUnsupported means the harness has no Chat driver at all.
	ErrChatUnsupported = errors.New("chat mode unsupported for harness")
	// ErrChatDriverUnavailable means the driver exists but its binary or
	// bridge is missing.
	ErrChatDriverUnavailable = errors.New("chat driver unavailable")
	// ErrChatDriverIncompatible means the installed provider speaks a protocol
	// version AO does not support.
	ErrChatDriverIncompatible = errors.New("chat driver incompatible")
	// ErrChatAuthRequired means the provider is installed but not authenticated.
	ErrChatAuthRequired = errors.New("chat driver requires authentication")
	// ErrChatResumeFailed means a stored provider conversation could not be
	// resumed. Callers must surface a recovery choice, never silently start a
	// new provider conversation.
	ErrChatResumeFailed = errors.New("chat conversation resume failed")
)

// ChatCapability names something a driver may or may not be able to do. AO gates
// features on these rather than on the harness name.
type ChatCapability string

// The capabilities AO currently checks.
const (
	ChatCapabilityStreaming   ChatCapability = "streaming"
	ChatCapabilityTools       ChatCapability = "tools"
	ChatCapabilityApprovals   ChatCapability = "approvals"
	ChatCapabilityInterrupt   ChatCapability = "interrupt"
	ChatCapabilitySteer       ChatCapability = "steer"
	ChatCapabilityResume      ChatCapability = "resume"
	ChatCapabilityHistory     ChatCapability = "history"
	ChatCapabilityUsage       ChatCapability = "usage"
	ChatCapabilityDiffs       ChatCapability = "diffs"
	ChatCapabilityPlans       ChatCapability = "plans"
	ChatCapabilityInteractive ChatCapability = "user_input"
)

// ChatCapabilities is the set a driver reports from Probe.
type ChatCapabilities map[ChatCapability]bool

// Has reports whether the capability is present and enabled.
func (c ChatCapabilities) Has(cap ChatCapability) bool { return c[cap] }

// chatProductionFloor is the minimum a driver must support before AO will let a
// session that can mutate a workspace run in Chat mode. Without approvals a
// mutating agent has no gate; without interrupt the user cannot stop it; without
// resume a daemon restart silently loses the conversation.
var chatProductionFloor = []ChatCapability{
	ChatCapabilityStreaming,
	ChatCapabilityApprovals,
	ChatCapabilityInterrupt,
	ChatCapabilityResume,
}

// MissingProductionCapabilities returns the floor capabilities a driver lacks.
// An empty result means the driver is Chat-ready.
func MissingProductionCapabilities(caps ChatCapabilities) []ChatCapability {
	var missing []ChatCapability
	for _, want := range chatProductionFloor {
		if !caps.Has(want) {
			missing = append(missing, want)
		}
	}
	return missing
}

// ChatStartConfig is what a driver needs to open a new provider conversation.
type ChatStartConfig struct {
	SessionID domain.SessionID
	// WorkspacePath is the session worktree. Always absolute: app-server-style
	// drivers resolve a relative path against their own process directory.
	WorkspacePath string
	// Env is the environment for the driver process and, transitively, for the
	// shell commands the agent runs. AO passes a HookPATH-augmented copy so the
	// agent can invoke `ao` — that is how an orchestrator delegates.
	Env map[string]string
	// Model is optional; empty defers to the provider's configured default.
	Model string
	// Permissions is AO's existing per-session approval policy. Drivers map it
	// onto their provider's native approval and sandbox settings.
	Permissions PermissionMode
	// SystemPrompt carries AO's standing instructions for the session.
	SystemPrompt string
}

// ChatResumeConfig reattaches to a provider conversation after a restart.
type ChatResumeConfig struct {
	SessionID              domain.SessionID
	ProviderConversationID string
	WorkspacePath          string
	Env                    map[string]string
	Permissions            PermissionMode
}

// ChatUserMessage is one inbound request to the agent.
type ChatUserMessage struct {
	Text string
	// ClientMessageID makes delivery idempotent: a retry with the same key must
	// not produce a second provider turn.
	ClientMessageID string
	// Origin records who is speaking. Automation shares the queue with the user
	// and can never resolve an approval.
	Origin domain.MessageOrigin
}

// ChatTurnRef identifies a turn the provider accepted.
type ChatTurnRef struct {
	ProviderTurnID string
}

// ChatDecisionOption is one choice the provider says is valid for a pending
// request. Providers vary the offered set per request — some do not offer a
// plain decline — so clients render from this list rather than a fixed enum.
type ChatDecisionOption struct {
	// ID is the stable identifier, e.g. "accept" or "acceptForSession".
	ID string
	// Label is a human-readable form when the provider supplies one.
	Label string
	// Raw is the provider's own encoding, preserved so a structured decision
	// (one carrying a policy amendment, say) can be echoed back exactly.
	Raw []byte
}

// ChatDecision is the answer to a pending request.
type ChatDecision struct {
	ID string
	// Raw, when set, is sent verbatim instead of ID. Used for the object-shaped
	// decisions some providers offer.
	Raw []byte
}

// ChatEventKind discriminates ChatEvent. These are provider-neutral: a driver
// translates its native notifications into this set and drops what has no
// meaning here rather than inventing semantics.
type ChatEventKind string

// The event kinds a driver emits.
const (
	ChatEventTurnStarted       ChatEventKind = "turn.started"
	ChatEventTurnCompleted     ChatEventKind = "turn.completed"
	ChatEventMessageDelta      ChatEventKind = "message.delta"
	ChatEventMessageCompleted  ChatEventKind = "message.completed"
	ChatEventActivityStarted   ChatEventKind = "activity.started"
	ChatEventActivityCompleted ChatEventKind = "activity.completed"
	ChatEventApprovalRequested ChatEventKind = "approval.requested"
	ChatEventApprovalResolved  ChatEventKind = "approval.resolved"
	ChatEventControllerState   ChatEventKind = "controller.state"
	ChatEventError             ChatEventKind = "error"
)

// ChatControllerState is the health of the driver's connection to the provider.
type ChatControllerState string

// Controller states. Unknown is not death: a failed probe is not proof a session
// is gone, matching how AO already treats runtime probes.
const (
	ChatControllerConnecting ChatControllerState = "connecting"
	ChatControllerReady      ChatControllerState = "ready"
	ChatControllerBusy       ChatControllerState = "busy"
	ChatControllerRecovering ChatControllerState = "recovering"
	ChatControllerStopped    ChatControllerState = "stopped"
)

// ChatEvent is one normalized observation from the provider.
//
// Deltas are the high-frequency case, so they carry only what changed. A
// projector folds a delta into the message identified by ProviderItemID and
// bumps its revision; it never allocates a new timeline position per token.
type ChatEvent struct {
	Kind ChatEventKind

	// ProviderTurnID is set on every event that belongs to a turn.
	ProviderTurnID string
	// ProviderItemID identifies the message or activity being reported.
	ProviderItemID string

	// TurnState is set on turn.completed.
	TurnState domain.TurnState

	// Delta is the text appended by a message.delta.
	Delta string
	// Text is the settled text on message.completed.
	Text string

	// ActivityKind and ActivityStatus are set on activity events.
	ActivityKind   domain.ActivityKind
	ActivityStatus domain.ActivityStatus
	// Summary is the one-line label for an activity or approval.
	Summary string
	// Detail is the provider-neutral typed payload, JSON-encoded.
	Detail []byte

	// RequestID and Decisions are set on approval.requested.
	RequestID string
	Decisions []ChatDecisionOption

	// ControllerState is set on controller.state.
	ControllerState ChatControllerState

	// Err carries a structured failure. Its presence does not imply the
	// conversation is over; check ControllerState for that.
	Err error
}

// ChatDriver opens conversations for one harness.
type ChatDriver interface {
	// Harness is the agent this driver serves.
	Harness() domain.AgentHarness
	// Probe checks the local install without creating anything: is the binary
	// present, is it authenticated, what can it do. It must be safe to call
	// before any durable session or worktree exists, so an unsupported request
	// can be rejected before AO commits resources.
	Probe(ctx context.Context) (ChatCapabilities, error)
	// Start opens a new provider conversation.
	Start(ctx context.Context, cfg ChatStartConfig) (ChatConversation, error)
	// Resume reattaches to an existing one. It returns ErrChatResumeFailed
	// rather than silently starting a new conversation.
	Resume(ctx context.Context, cfg ChatResumeConfig) (ChatConversation, error)
}

// ChatConversation is one live controller. Exactly one exists per Chat session,
// and it is the only writer to its provider conversation.
type ChatConversation interface {
	// ProviderConversationID is the opaque identifier AO persists so a later
	// process can resume this conversation.
	ProviderConversationID() string
	// Capabilities is what this conversation actually negotiated, which can be
	// narrower than what Probe reported.
	Capabilities() ChatCapabilities
	// SendTurn delivers a user or automation message. Calls are serialized by
	// the controller: only one dispatch mutates the provider at a time.
	SendTurn(ctx context.Context, msg ChatUserMessage) (ChatTurnRef, error)
	// Interrupt cancels an in-flight turn.
	Interrupt(ctx context.Context, providerTurnID string) error
	// ResolveRequest answers a pending approval or user-input request. It is a
	// typed action: it is never derived from sending a message.
	ResolveRequest(ctx context.Context, requestID string, decision ChatDecision) error
	// Events is the normalized event stream. It closes when the conversation
	// ends. A consumer that falls behind is disconnected rather than allowed to
	// block the provider reader.
	Events() <-chan ChatEvent
	// Close releases the controller. It does not delete provider-side history.
	Close() error
}

// ChatDriverRegistry resolves the driver for a harness.
type ChatDriverRegistry interface {
	// Driver returns the driver for a harness, or ErrChatUnsupported.
	Driver(harness domain.AgentHarness) (ChatDriver, error)
	// SupportsChat reports whether a harness has a Chat driver registered at
	// all, without probing the local install.
	SupportsChat(harness domain.AgentHarness) bool
}
