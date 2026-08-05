// Package contract contains storage-free AO semantics shared by local and Cloud.
package contract

import "time"

// SessionKind distinguishes worker and orchestrator sessions.
type SessionKind string

const (
	// KindWorker is a delegated implementation session.
	KindWorker SessionKind = "worker"
	// KindOrchestrator is a coordination session that manages workers.
	KindOrchestrator SessionKind = "orchestrator"
)

// ActivityState is the portable activity vocabulary reported by agent runtimes.
type ActivityState string

const (
	// ActivityActive means the runtime is actively working.
	ActivityActive ActivityState = "active"
	// ActivityIdle means the runtime is available and not actively working.
	ActivityIdle ActivityState = "idle"
	// ActivityWaitingInput means progress is blocked on user input.
	ActivityWaitingInput ActivityState = "waiting_input"
	// ActivityBlocked means progress is blocked on an external issue.
	ActivityBlocked ActivityState = "blocked"
	// ActivityExited means the runtime process exited.
	ActivityExited ActivityState = "exited"
)

// SessionStatus is the dashboard/Kanban display status. It is derived from
// durable facts and should not be persisted.
type SessionStatus string

const (
	// StatusWorking means the session is actively progressing.
	StatusWorking SessionStatus = "working"
	// StatusPROpen means a pull request exists but has no stronger status.
	StatusPROpen SessionStatus = "pr_open"
	// StatusDraft means the pull request is currently a draft.
	StatusDraft SessionStatus = "draft"
	// StatusCIFailed means CI has failed for the session PR.
	StatusCIFailed SessionStatus = "ci_failed"
	// StatusReviewPending means the session PR is waiting for review.
	StatusReviewPending SessionStatus = "review_pending"
	// StatusChangesRequested means review feedback requires worker action.
	StatusChangesRequested SessionStatus = "changes_requested"
	// StatusApproved means the session PR has approval.
	StatusApproved SessionStatus = "approved"
	// StatusMergeable means the session PR is ready to merge.
	StatusMergeable SessionStatus = "mergeable"
	// StatusMerged means the session PR has merged.
	StatusMerged SessionStatus = "merged"
	// StatusNeedsInput means the session needs user input or has a blocker.
	StatusNeedsInput SessionStatus = "needs_input"
	// StatusExited means the runtime process exited.
	StatusExited SessionStatus = "exited"
	// StatusIdle means the session is available but inactive.
	StatusIdle SessionStatus = "idle"
	// StatusTerminated means the session was intentionally terminated.
	StatusTerminated SessionStatus = "terminated"
	// StatusNoSignal means a signal-capable session has not reported activity.
	StatusNoSignal SessionStatus = "no_signal"
)

// SessionFacts are portable facts used to derive a session's display status.
type SessionFacts struct {
	Terminated      bool
	Activity        ActivityState
	HasActiveTurn   bool
	SignalCapable   bool
	FirstSignalSeen bool
	LastActivityAt  time.Time
	Now             time.Time
	NoSignalGrace   time.Duration
}

// DeriveSessionStatus computes the display status shared by local and Cloud.
func DeriveSessionStatus(session SessionFacts, prs []PRFacts) SessionStatus {
	if session.Terminated {
		if anyMerged(prs) {
			return StatusMerged
		}
		return StatusTerminated
	}
	switch session.Activity {
	case ActivityActive:
		return StatusWorking
	case ActivityExited:
		return StatusExited
	case ActivityWaitingInput, ActivityBlocked:
		return StatusNeedsInput
	}
	if session.HasActiveTurn {
		return StatusWorking
	}
	if scmStatus := DeriveSCMStatus(prs); scmStatus != "" {
		return scmStatus
	}
	if session.SignalCapable &&
		!session.FirstSignalSeen &&
		session.NoSignalGrace > 0 &&
		session.Now.Sub(session.LastActivityAt) > session.NoSignalGrace {
		return StatusNoSignal
	}
	return StatusIdle
}

// DeriveSCMStatus returns the session's stack-aware PR context independently of
// runtime activity. It is empty when the session has no open or merged PR.
func DeriveSCMStatus(prs []PRFacts) SessionStatus {
	open := openPRs(prs)
	if len(open) > 0 {
		return aggregatePRStatus(open)
	}
	if anyMerged(prs) {
		return StatusMerged
	}
	return ""
}

func openPRs(prs []PRFacts) []PRFacts {
	out := make([]PRFacts, 0, len(prs))
	for _, pr := range prs {
		if !pr.Merged && !pr.Closed {
			out = append(out, pr)
		}
	}
	return out
}

func anyMerged(prs []PRFacts) bool {
	for _, pr := range prs {
		if pr.Merged {
			return true
		}
	}
	return false
}

func aggregatePRStatus(open []PRFacts) SessionStatus {
	stacks := buildStacks(open)
	candidates := make([]SessionStatus, 0, len(open))
	for _, pr := range open {
		status := prPipelineStatus(pr)
		if stacks[pr.URL].Blocked && !isActionableChildSignal(status) {
			continue
		}
		candidates = append(candidates, status)
	}
	if len(candidates) == 0 {
		for _, pr := range open {
			candidates = append(candidates, prPipelineStatus(pr))
		}
	}
	worst := candidates[0]
	for _, status := range candidates[1:] {
		if statusSeverity(status) < statusSeverity(worst) {
			worst = status
		}
	}
	return worst
}

func isActionableChildSignal(status SessionStatus) bool {
	switch status {
	case StatusCIFailed, StatusDraft, StatusChangesRequested:
		return true
	default:
		return false
	}
}

func statusSeverity(status SessionStatus) int {
	switch status {
	case StatusCIFailed:
		return 0
	case StatusChangesRequested:
		return 1
	case StatusDraft:
		return 2
	case StatusReviewPending:
		return 3
	case StatusPROpen:
		return 4
	case StatusApproved:
		return 5
	case StatusMergeable:
		return 6
	default:
		return 7
	}
}

func prPipelineStatus(pr PRFacts) SessionStatus {
	switch {
	case pr.CI == CIFailing:
		return StatusCIFailed
	case pr.Draft:
		return StatusDraft
	case pr.Review == ReviewChangesRequested || pr.ReviewComments:
		return StatusChangesRequested
	case pr.Mergeability == MergeMergeable:
		return StatusMergeable
	case pr.Review == ReviewApproved:
		return StatusApproved
	case pr.Review == ReviewRequired:
		return StatusReviewPending
	default:
		return StatusPROpen
	}
}
