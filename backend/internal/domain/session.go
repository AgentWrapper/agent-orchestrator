package domain

import "time"

// These ID types are distinct string types so they can't be swapped at a call
// site by accident.
type (
	// SessionID identifies a session.
	SessionID string
	// ProjectID identifies a project.
	ProjectID string
	// IssueID identifies a tracker issue.
	IssueID string
)

// SessionKind distinguishes a worker session from an orchestrator session.
type SessionKind string

// Session kinds.
const (
	KindWorker       SessionKind = "worker"
	KindOrchestrator SessionKind = "orchestrator"
)

// CapabilityClass identifies the security boundary an actor runs within.
// AO workers are independent CLI processes with their own session, worktree,
// branch, and runtime. Orchestrators and any native in-process subagents are
// coordination/analysis actors and cannot perform formal implementation.
type CapabilityClass string

// Capability classes persisted in session metadata and policy audit events.
const (
	CapabilityClassOrchestrator   CapabilityClass = "orchestrator"
	CapabilityClassAOWorker       CapabilityClass = "ao_worker"
	CapabilityClassNativeSubagent CapabilityClass = "native_subagent"
)

// CapabilityClassForKind returns the capability class AO assigns to a durable
// session. Native subagents are not durable AO sessions; their class is still
// explicit so policy hooks and audit records can identify them.
func CapabilityClassForKind(kind SessionKind) CapabilityClass {
	if kind == KindWorker {
		return CapabilityClassAOWorker
	}
	return CapabilityClassOrchestrator
}

// SessionMetadata is the typed, off-status metadata for a session: operational
// handles and seed inputs used by Session Manager and reaper.
type SessionMetadata struct {
	Branch          string `json:"branch,omitempty"`
	WorkspacePath   string `json:"workspacePath,omitempty"`
	RuntimeHandleID string `json:"runtimeHandleId,omitempty"`
	AgentSessionID  string `json:"agentSessionId,omitempty"`
	Prompt          string `json:"prompt,omitempty"`
	// CapabilityClass records the implementation policy applied when AO
	// launched the session. Empty values from pre-policy databases are treated
	// as the class implied by SessionRecord.Kind.
	CapabilityClass CapabilityClass `json:"capabilityClass,omitempty"`
	// ExecutionProfile is persisted before any workspace or runtime is created.
	ExecutionProfile ExecutionProfile `json:"executionProfile,omitempty"`
	// ObservedExecutionProfileHash is recorded only after the adapter/runtime
	// accepted the profile. A mismatch is surfaced as drift by status/doctor.
	ObservedExecutionProfileHash string `json:"observedExecutionProfileHash,omitempty"`
	// PreviewURL is the browser preview target the desktop app opens for this
	// session. Set via `ao preview` (POST /sessions/{id}/preview); persisted so
	// it survives a daemon restart. Empty means no preview has been requested.
	PreviewURL string `json:"previewUrl,omitempty"`
	// PreviewRevision is a monotonic counter bumped on every `ao preview` call,
	// even when PreviewURL is unchanged. The desktop browser panel keys
	// navigation on it so a repeated `ao preview <same-url>` still refreshes.
	PreviewRevision int64 `json:"previewRevision,omitempty"`
}

// SessionRecord is the persistence shape. It intentionally stores only durable
// facts: identity, agent harness, activity_state, is_terminated, and operational
// metadata. The user-facing Status is derived from these facts plus PR facts.
type SessionRecord struct {
	ID          SessionID    `json:"id"`
	ProjectID   ProjectID    `json:"projectId"`
	IssueID     IssueID      `json:"issueId,omitempty"`
	Kind        SessionKind  `json:"kind"`
	Harness     AgentHarness `json:"harness,omitempty"`
	DisplayName string       `json:"displayName,omitempty"`
	Activity    Activity     `json:"activity"`
	// FirstSignalAt is when the FIRST agent hook callback arrived for the
	// current spawn/restore: raw signal receipt, independent of the derived
	// activity state. Zero means no hook has ever reported, which deriveStatus
	// surfaces as StatusNoSignal after a grace period. Internal fact, not part
	// of the API read model.
	FirstSignalAt time.Time       `json:"-"`
	IsTerminated  bool            `json:"isTerminated"`
	Metadata      SessionMetadata `json:"-"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

// Session is the read-model returned across the API boundary: a SessionRecord
// plus the derived display Status.
type Session struct {
	SessionRecord
	Status           SessionStatus `json:"status" enum:"working,pr_open,draft,ci_failed,review_pending,changes_requested,approved,mergeable,merged,needs_input,idle,terminated,no_signal"`
	TerminalHandleID string        `json:"terminalHandleId,omitempty"`
	// PRs are the session's attributed pull requests (one session can own many).
	// They feed status derivation and are surfaced on the API read model. Not
	// serialized here: the HTTP boundary maps them to the curated wire shape.
	PRs []PRFacts `json:"-"`
}
