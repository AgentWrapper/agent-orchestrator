package session

import (
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/contract"
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
	return contract.DeriveSessionStatus(contract.SessionFacts{
		Terminated:      rec.IsTerminated,
		Activity:        contract.ActivityState(rec.Activity.State),
		SignalCapable:   signalCapable,
		FirstSignalSeen: !rec.FirstSignalAt.IsZero(),
		LastActivityAt:  rec.Activity.LastActivityAt,
		Now:             now,
		NoSignalGrace:   noSignalGrace,
	}, contractPRFacts(prs))
}

// deriveSCMStatus returns the session's stack-aware PR context independently
// of runtime activity. It is empty when the session has no open or merged PR.
func deriveSCMStatus(prs []domain.PRFacts) domain.SessionStatus {
	return contract.DeriveSCMStatus(contractPRFacts(prs))
}

func contractPRFacts(prs []domain.PRFacts) []contract.PRFacts {
	out := make([]contract.PRFacts, 0, len(prs))
	for _, pr := range prs {
		out = append(out, contract.PRFacts{
			URL:            pr.URL,
			Number:         pr.Number,
			Draft:          pr.Draft,
			Merged:         pr.Merged,
			Closed:         pr.Closed,
			CI:             contract.CIState(pr.CI),
			Review:         contract.ReviewState(pr.Review),
			Mergeability:   contract.Mergeability(pr.Mergeability),
			ReviewComments: pr.ReviewComments,
			SourceBranch:   pr.SourceBranch,
			TargetBranch:   pr.TargetBranch,
			UpdatedAt:      pr.UpdatedAt,
		})
	}
	return out
}
