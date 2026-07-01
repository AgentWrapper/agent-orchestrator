package session

import (
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// noSignalGrace is how long after spawn/restore a session may stay silent
// before its idle reading is downgraded to StatusNoSignal. It covers the
// agent's TUI boot plus the gap to the first activity-bearing hook callback
// (for Codex that is UserPromptSubmit, seconds after the auto-submitted spawn
// prompt — its SessionStart hook fires earlier but carries no activity state);
// past it, a silent session is indistinguishable from one with a broken hook
// pipeline, and the dashboard must not claim a confident "idle".
const noSignalGrace = 90 * time.Second

// deriveStatus computes the display status. signalCapable says whether this
// session's harness has an activity hook pipeline at all; only then can
// prolonged silence mean the pipeline is broken (no_signal) rather than the
// permanent, normal silence of a hook-less harness.
//
// A session may own several PRs at once (independent or stacked). The PR-derived
// status is the worst-wins aggregate across its open PRs; stacked children whose
// parent is still open are exempt from the aggregation since they cannot merge
// until the parent does. Merged/closed PRs only matter once no open PR remains.
func deriveStatus(rec domain.SessionRecord, prs []domain.PRFacts, now time.Time, signalCapable bool) domain.SessionStatus {
	if rec.IsTerminated {
		if anyMerged(prs) {
			return domain.StatusMerged
		}
		return domain.StatusTerminated
	}

	open := openPRs(prs)
	if len(open) > 0 {
		status := aggregatePRStatus(open)
		if status == domain.StatusConflicting {
			return status
		}
		if rec.Activity.State == domain.ActivityWaitingInput {
			return domain.StatusNeedsInput
		}
		return status
	}
	if anyMerged(prs) {
		return domain.StatusMerged
	}

	if rec.Activity.State == domain.ActivityWaitingInput {
		return domain.StatusNeedsInput
	}

	if rec.Activity.State == domain.ActivityActive {
		return domain.StatusWorking
	}

	// No hook callback has ever arrived for this spawn/restore even though the
	// harness has a hook pipeline. The seeded LastActivityAt marks the launch,
	// so once the grace passes the honest status is "no signal", not "idle".
	if signalCapable && rec.FirstSignalAt.IsZero() && now.Sub(rec.Activity.LastActivityAt) > noSignalGrace {
		return domain.StatusNoSignal
	}
	return domain.StatusIdle
}

// openPRs returns the PRs that are neither merged nor closed, preserving order.
func openPRs(prs []domain.PRFacts) []domain.PRFacts {
	out := make([]domain.PRFacts, 0, len(prs))
	for _, p := range prs {
		if !p.Merged && !p.Closed {
			out = append(out, p)
		}
	}
	return out
}

func anyMerged(prs []domain.PRFacts) bool {
	for _, p := range prs {
		if p.Merged {
			return true
		}
	}
	return false
}

// aggregatePRStatus is the worst-wins reduction over a session's open PRs.
// A stacked child blocked by an open parent cannot merge yet, so its readiness
// signals (mergeable/approved/review-pending/open) are not actionable for the
// session and are suppressed. Its problem signals are still actionable: failing
// CI, merge conflicts, draft state, and requested-changes/unresolved-comments
// must stay visible so a broken child is not hidden behind the stack. If no PR
// contributes any signal (a degenerate stack with no visible root), it falls
// back to aggregating the raw status across all open PRs so the session never
// goes dark.
func aggregatePRStatus(open []domain.PRFacts) domain.SessionStatus {
	stacks := buildStacks(open)
	candidates := make([]domain.SessionStatus, 0, len(open))
	for _, p := range open {
		s := prPipelineStatus(p)
		if stacks[p.URL].Blocked && !isActionableChildSignal(s) {
			continue
		}
		candidates = append(candidates, s)
	}
	if len(candidates) == 0 {
		for _, p := range open {
			candidates = append(candidates, prPipelineStatus(p))
		}
	}
	worst := candidates[0]
	for _, s := range candidates[1:] {
		if statusSeverity(s) < statusSeverity(worst) {
			worst = s
		}
	}
	return worst
}

// isActionableChildSignal reports whether a blocked stacked child's pipeline
// status is a problem the user can act on now, independent of the child's
// inability to merge until its parent does.
func isActionableChildSignal(s domain.SessionStatus) bool {
	switch s {
	case domain.StatusCIFailed, domain.StatusConflicting, domain.StatusDraft, domain.StatusChangesRequested:
		return true
	default:
		return false
	}
}

// statusSeverity ranks PR pipeline statuses from most to least urgent so the
// aggregate surfaces the PR that most needs attention. mergeable is least urgent
// so a session only reports mergeable when every aggregated PR is mergeable.
func statusSeverity(s domain.SessionStatus) int {
	switch s {
	case domain.StatusCIFailed:
		return 0
	case domain.StatusConflicting:
		return 1
	case domain.StatusChangesRequested:
		return 2
	case domain.StatusDraft:
		return 3
	case domain.StatusReviewPending:
		return 4
	case domain.StatusPROpen:
		return 5
	case domain.StatusApproved:
		return 6
	case domain.StatusMergeable:
		return 7
	default:
		return 8
	}
}

func prPipelineStatus(pr domain.PRFacts) domain.SessionStatus {
	switch {
	case pr.CI == domain.CIFailing:
		return domain.StatusCIFailed
	case pr.Mergeability == domain.MergeConflicting:
		return domain.StatusConflicting
	case pr.Draft:
		return domain.StatusDraft
	case pr.Review == domain.ReviewChangesRequest || pr.ReviewComments:
		return domain.StatusChangesRequested
	case pr.Mergeability == domain.MergeMergeable:
		return domain.StatusMergeable
	case pr.Review == domain.ReviewApproved:
		return domain.StatusApproved
	case pr.Review == domain.ReviewRequired:
		return domain.StatusReviewPending
	default:
		return domain.StatusPROpen
	}
}
