package domain

import "github.com/aoagents/agent-orchestrator/backend/internal/contract"

// SessionStatus is the single-word DISPLAY status the dashboard renders. It is
// derived from persisted session facts plus PR facts and is never stored.
type SessionStatus = contract.SessionStatus

// The display statuses the dashboard renders.
const (
	StatusWorking          SessionStatus = contract.StatusWorking
	StatusPROpen           SessionStatus = contract.StatusPROpen
	StatusDraft            SessionStatus = contract.StatusDraft
	StatusCIFailed         SessionStatus = contract.StatusCIFailed
	StatusReviewPending    SessionStatus = contract.StatusReviewPending
	StatusChangesRequested SessionStatus = contract.StatusChangesRequested
	StatusApproved         SessionStatus = contract.StatusApproved
	StatusMergeable        SessionStatus = contract.StatusMergeable
	StatusMerged           SessionStatus = contract.StatusMerged
	StatusNeedsInput       SessionStatus = contract.StatusNeedsInput
	StatusExited           SessionStatus = contract.StatusExited
	StatusIdle             SessionStatus = contract.StatusIdle
	StatusTerminated       SessionStatus = contract.StatusTerminated
	// StatusNoSignal marks a live session whose agent has never delivered a
	// hook callback for the current spawn/restore: AO cannot tell whether the
	// agent is working or stuck (broken hook pipeline, blocked interactive
	// prompt). Rendered instead of a confident idle.
	StatusNoSignal SessionStatus = contract.StatusNoSignal
)
