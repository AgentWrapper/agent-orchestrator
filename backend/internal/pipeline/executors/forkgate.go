package executors

import (
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// forkSkipObservation is the shared name every executor emits when the fork-PR
// trust gate self-skips a stage. Uniform across agent, command, and builtin so
// the run detail and telemetry treat the boundary identically.
const forkSkipObservation = "pipeline.stage.skipped_fork_pr"

// forkFromContext derives the fork verdict for a stage from the run context
// alone (the #275 tri-state), mirroring the command path's session-lookup
// semantics without needing a session read:
//
//   - IsFromFork known -> that verdict (true -> ForkYes, false -> ForkNo);
//   - IsFromFork unknown but a PR exists -> ForkUnknown (fail-safe block);
//   - IsFromFork unknown and no PR (manual/no-PR run) -> ForkNo (runs).
//
// This lets the agent and builtin executors gate without a fork-status seam of
// their own: a PR run always carries IsFromFork from the trigger bridge, and a
// manual run has no PR so it resolves to ForkNo and flows normally.
func forkFromContext(c pipeline.RunContext) (ForkStatus, int) {
	if c.IsFromFork != nil {
		if *c.IsFromFork {
			return ForkYes, c.PRNumber
		}
		return ForkNo, c.PRNumber
	}
	if c.PRNumber > 0 {
		return ForkUnknown, c.PRNumber
	}
	return ForkNo, c.PRNumber
}

// forkGateDecision applies the fork-PR trust gate. It returns (skip, true) with
// a completed/neutral self-skip outcome when the stage must not run untrusted
// code, else (Outcome{}, false). ForkUnknown is fail-safe (blocked): provenance
// we cannot classify never executes. allowForkPRs opens the gate for genuine
// fork PRs. The outcome carries a uniform observation whose Note explains the
// skip in the run detail.
func forkGateDecision(fork ForkStatus, prNumber int, stageName string, allowForkPRs bool) (Outcome, bool) {
	if fork == ForkNo || allowForkPRs {
		return Outcome{}, false
	}

	reason := fmt.Sprintf("PR #%d is from a fork and pipeline.allowForkPRs is not enabled", prNumber)
	if fork == ForkUnknown {
		reason = fmt.Sprintf("SCM plugin could not determine fork status for PR #%d; blocking by default", prNumber)
	}

	return Outcome{
		Status:  OutcomeCompleted,
		Verdict: pipeline.VerdictNeutral,
		Observations: []Observation{{
			Name: forkSkipObservation,
			Data: map[string]any{
				"stage":      stageName,
				"prNumber":   prNumber,
				"isFromFork": fork == ForkYes,
				"reason":     reason,
			},
			Note: "stage skipped: " + reason,
		}},
	}, true
}
