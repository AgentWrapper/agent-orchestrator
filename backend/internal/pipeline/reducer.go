package pipeline

import (
	"fmt"
	"maps"
	"time"
)

// Reduce applies one event to one run and returns the next run state plus the
// effects the driver should execute. It is the whole transition core: fan-out,
// joins, cascading skip and run settlement all live here.
//
// The reducer is per-run (one run is an independent snapshot) and pure: it
// never mutates its input, never reads the clock, and never touches the world.
// Purity is load-bearing, because the engine keeps the pre-reduce state around
// until the returned effects have been walked.
//
// Effects come back in the order the driver should apply them: Context.md
// pointer lines first (the next stage's prompt reads them), then PersistRun so
// the state is durable before anything is launched, then the stage commands,
// then RunSettled last.
func Reduce(run RunState, ev Event) (RunState, []Effect) {
	if fired, ok := ev.(TriggerFired); ok {
		return reduceTriggerFired(run, fired)
	}
	// A settled run is done: late events from an executor that was already
	// torn down change nothing.
	if run.Status.isSettled() {
		return run, nil
	}

	switch e := ev.(type) {
	case StageLaunched:
		return reduceStageLaunched(run, e)
	case StageLaunchFailed:
		// The stage never got to run at all, so it settles failed with the
		// driver's reason and routes like any other failure.
		return settleFailure(run, e.Stage, OutcomeFailed, e.Reason, e.Now, nil)
	case AgentSignaled:
		if !e.Done {
			// Never nudge an explicit `ao pipeline fail`. The agent decided;
			// respect it (spec section 7.1).
			return settleFailure(run, e.Stage, OutcomeFailed, e.Reason, e.Now, nil)
		}
		if !e.ArtifactOK {
			// Signalled done with the declared artifact missing or empty: one
			// nudge, then no_output. ArtifactOK is true when nothing is
			// declared, so getting here means there is a contract to point at.
			return nudgeOrSettle(run, e.Stage, e.ArtifactOK, e.Now)
		}
		// Nothing declared means nothing verified, and the signal was the whole
		// contract.
		outcome := OutcomeSucceededUnverified
		if s := run.Def.StageByID(e.Stage); s != nil && s.Produces != "" {
			outcome = OutcomeSucceeded
		}
		return settleSuccess(run, e.Stage, outcome, e.Now)
	case CommandExited:
		if e.ExitCode != 0 {
			return settleFailure(run, e.Stage, OutcomeFailed, fmt.Sprintf("command exited %d", e.ExitCode), e.Now, nil)
		}
		return settleSuccess(run, e.Stage, OutcomeSucceeded, e.Now)
	case SessionIdle:
		// Idle-without-signal is where the nudge is most valuable: it is the
		// disambiguator between "finished and forgot to call the CLI" and
		// "stuck waiting" (spec section 7.1).
		return nudgeOrSettle(run, e.Stage, e.ArtifactOK, e.Now)
	case SessionGone:
		// Never nudge an exited session. Nothing to nudge.
		return settleFailure(run, e.Stage, OutcomeNoSignal, "session exited without signalling", e.Now, nil)
	case NudgeDelivered:
		return reduceNudgeDelivered(run, e)
	case Tick:
		return reduceTick(run, e)
	case CancelRequested:
		return reduceCancel(run, e)
	default:
		return run, nil
	}
}

// reduceTriggerFired seeds the run: every reachable stage lands `pending` so
// the board renders the whole shape immediately, and the entry stage starts.
func reduceTriggerFired(run RunState, e TriggerFired) (RunState, []Effect) {
	next := run.clone()
	next.RunID = e.RunID
	next.RunDir = e.RunDir
	next.Subject = e.Subject
	next.Def = e.Def
	next.PipelineName = e.Def.Name
	if e.Subject.ProjectID != "" {
		next.ProjectID = e.Subject.ProjectID
	}
	if next.CreatedAt.IsZero() {
		next.CreatedAt = e.Now
	}
	next.UpdatedAt = e.Now
	next.Stages = map[string]*StageState{}

	plan, err := ComputePlan(&next.Def, e.Subject, KnownCredentialSet(e.KnownCredentials))
	if err != nil {
		return failAtPlanTime(next, err, e.Now)
	}

	for _, id := range plan.Reachable {
		next.Stages[id] = &StageState{
			ID:      id,
			Outcome: OutcomePending,
			// A failure-entered stage keeps the symbolic "inherit" here: the
			// tree it gets is whichever stage routes into it, known only when
			// that happens.
			WorkspaceKind: plan.Workspaces[id],
		}
	}

	next.Status = RunRunning
	entry := next.Def.EntryStage()
	starts := []Effect{startStage(&next, entry.ID, EntryTrigger, "", e.Now)}

	// advance writes through next, so it has to run before next is copied into
	// the result.
	effects := append([]Effect{PersistRun{}}, advance(&next, starts, e.Now)...)
	return next, effects
}

// failAtPlanTime settles the run before any stage runs, which is the point of
// planning at start: the one impossible workspace combination fails with the
// reason stated rather than half way through (spec section 5.3).
//
// The reason lands on the entry stage because that is the stage that never got
// to run, and it is what run detail renders.
func failAtPlanTime(next RunState, planErr error, now time.Time) (RunState, []Effect) {
	if entry := next.Def.EntryStage(); entry != nil {
		next.Stages[entry.ID] = &StageState{
			ID:         entry.ID,
			Outcome:    OutcomeFailed,
			EnteredVia: EntryTrigger,
			SettledAt:  now,
			Reason:     planErr.Error(),
		}
	}
	next.Status = RunFailed
	next.SettledAt = now
	return next, []Effect{PersistRun{}, RunSettled{Status: RunFailed}}
}

// reduceStageLaunched moves a stage from pending to running and stamps its
// deadline from the moment it actually started, not from when the run did.
func reduceStageLaunched(run RunState, e StageLaunched) (RunState, []Effect) {
	if st := run.Stages[e.Stage]; st == nil || st.Outcome != OutcomePending {
		return run, nil
	}
	next := run.clone()
	st := next.Stages[e.Stage]
	st.Outcome = OutcomeRunning
	st.StartedAt = e.Now
	st.SessionID = e.SessionID
	st.PGID = e.PGID
	st.WorkspacePath = e.WorkspacePath
	if st.Attempt == 0 {
		st.Attempt = 1
	}
	if s := next.Def.StageByID(e.Stage); s != nil {
		st.DeadlineAt = e.Now.Add(s.EffectiveDeadline(next.Def.Defaults))
	}
	next.Status = RunRunning
	next.UpdatedAt = e.Now
	return next, []Effect{PersistRun{}}
}

// settleSuccess settles a running stage successfully and lets the run advance:
// on_success fans out, joins that are now complete start, and whatever can no
// longer be entered is skipped.
func settleSuccess(run RunState, stageID string, outcome Outcome, now time.Time) (RunState, []Effect) {
	if st := run.Stages[stageID]; st == nil || st.Outcome != OutcomeRunning {
		return run, nil
	}
	next := run.clone()
	st := next.Stages[stageID]
	st.Outcome = outcome
	st.SettledAt = now
	next.UpdatedAt = now

	effects := make([]Effect, 0, 4)
	// Context.md gets a pointer line only for a verified artifact: an
	// unverified success has nothing to point at.
	if def := next.Def.StageByID(stageID); outcome == OutcomeSucceeded && def != nil && def.Produces != "" {
		effects = append(effects, AppendContext{
			Line: fmt.Sprintf("stage `%s` finished, its output is at agent-outputs/%s", stageID, def.Produces),
		})
	}
	effects = append(effects, PersistRun{})
	effects = appendSessionDisposition(effects, &next, stageID, outcome)

	// advance writes through next, so it has to run before next is copied into
	// the result.
	starts := startSuccessTargets(&next, stageID, now)
	effects = append(effects, advance(&next, starts, now)...)
	return next, effects
}

// settleFailure settles an in-flight stage on one of the four outcomes that
// route to failure, then takes that stage's failure edge.
//
// extra carries the effects that belong to this particular failure and must
// land before the session disposition: today that is only the InterruptStage a
// timeout needs.
func settleFailure(run RunState, stageID string, outcome Outcome, reason string, now time.Time, extra []Effect) (RunState, []Effect) {
	if st := run.Stages[stageID]; st == nil || !inFlight(st) {
		return run, nil
	}
	next := run.clone()
	st := next.Stages[stageID]
	st.Outcome = outcome
	st.SettledAt = now
	if reason != "" {
		st.Reason = reason
	}
	next.UpdatedAt = now

	effects := make([]Effect, 0, len(extra)+4)
	effects = append(effects, PersistRun{})
	effects = append(effects, extra...)
	effects = appendSessionDisposition(effects, &next, stageID, outcome)

	// advance writes through next, so it has to run before next is copied into
	// the result.
	starts := startFailureTarget(&next, stageID, outcome, now)
	effects = append(effects, advance(&next, starts, now)...)
	return next, effects
}

// startFailureTarget takes the settled stage's failure edge: its own
// on_failure, else defaults.on_failure, else the branch ends. The one carve-out
// (the default target does not route into itself) lives in failureEdges.
//
// Failure entry is first-arrival-wins (spec section 9.3): a second stage
// routing into a target that is no longer pending is dropped. The run is
// already failing, and three notifications from three dead builds is noise.
// needs is deliberately not consulted, because failure edges never join.
func startFailureTarget(run *RunState, from string, outcome Outcome, now time.Time) []Effect {
	targets := run.Def.failureEdges()[from]
	if len(targets) == 0 || !canEnter(run, targets[0]) {
		return nil
	}
	target := targets[0]
	st := run.Stages[target]
	st.FailedStage = from
	st.FailedOutcome = outcome
	// PrevStage stays empty: AO_PREV_* names the success predecessor, and a
	// failure entry surfaces as AO_FAILED_* instead (spec section 12.2). The
	// stage's workspace stays the symbolic `inherit`; the driver resolves it at
	// launch to FailedStage's tree, which is the whole point of the failure
	// default (spec section 5.4).
	return []Effect{startStage(run, target, EntryFailure, "", now)}
}

// nudgeMissingArtifactFormat is the spec section 7.1 nudge, verbatim. It says
// overwrite, not write: there is no reliable way to detect a partial file after
// the fact, so the fix is prescriptive rather than detective.
const nudgeMissingArtifactFormat = "You signaled done but agent-outputs/%s does not exist or is empty.\n" +
	"Overwrite it now, then signal again."

// nudgeUnsignalledMessage is the nudge for a session that went idle with
// nothing left to verify: what is missing is the signal, not the artifact.
const nudgeUnsignalledMessage = "You appear to be finished but have not signalled. " +
	"Run 'ao pipeline done' or 'ao pipeline fail --reason ...' now."

// nudgeOrSettle is the one nudge each stage gets, and the settlement that
// follows a second arrival at the same dead end.
//
// The discriminator is artifactOK, not the presence of `produces`: the driver
// reports artifactOK true when nothing is declared, so a stage with no contract
// and a stage whose file is actually there take the same branch, and neither is
// told its artifact is missing. What each is missing is the signal.
//
// Two attempts total, not configurable. If a second nudge would help, the
// prompt is wrong (spec section 7.1).
func nudgeOrSettle(run RunState, stageID string, artifactOK bool, now time.Time) (RunState, []Effect) {
	st := run.Stages[stageID]
	if st == nil || st.Outcome != OutcomeRunning {
		return run, nil
	}

	outcome, message, reason := OutcomeNoSignal, nudgeUnsignalledMessage, "session went idle without signalling"
	if !artifactOK {
		produces := ""
		if def := run.Def.StageByID(stageID); def != nil {
			produces = def.Produces
		}
		outcome = OutcomeNoOutput
		message = fmt.Sprintf(nudgeMissingArtifactFormat, produces)
		reason = fmt.Sprintf("declared artifact agent-outputs/%s is missing or empty", produces)
	}

	if run.Nudged[stageID] {
		return settleFailure(run, stageID, outcome, reason, now, nil)
	}

	next := run.clone()
	if next.Nudged == nil {
		next.Nudged = map[string]bool{}
	}
	next.Nudged[stageID] = true
	next.UpdatedAt = now
	// The stage stays running: the nudge never leaves it, and it works because
	// the session is still alive with its context. Attempt becomes 2 only once
	// the driver reports the nudge delivered.
	return next, []Effect{
		PersistRun{},
		NudgeStage{Stage: stageID, SessionID: st.SessionID, Message: message},
	}
}

// reduceNudgeDelivered records that the stage is on its second and last
// attempt, which surfaces to the prompt as AO_ATTEMPT.
func reduceNudgeDelivered(run RunState, e NudgeDelivered) (RunState, []Effect) {
	st := run.Stages[e.Stage]
	if st == nil || st.Outcome != OutcomeRunning || !run.Nudged[e.Stage] || st.Attempt >= 2 {
		return run, nil
	}
	next := run.clone()
	next.Stages[e.Stage].Attempt = 2
	next.UpdatedAt = e.Now
	return next, []Effect{PersistRun{}}
}

// reduceTick enforces deadlines. Every stage has one: an agent that hangs must
// eventually settle as timed_out, or the run board grows entries nobody ever
// closes (spec section 13.1).
//
// Stages are walked in document order, because map iteration is random and the
// effect list the driver walks has to be deterministic.
func reduceTick(run RunState, e Tick) (RunState, []Effect) {
	effects := make([]Effect, 0, len(run.Stages))
	for _, id := range run.Def.stageIDs() {
		st := run.Stages[id]
		if st == nil || st.Outcome != OutcomeRunning || st.DeadlineAt.IsZero() || !e.Now.After(st.DeadlineAt) {
			continue
		}
		// InterruptStage kills the process and keeps the session: a timed-out
		// agent may still be running, and the scrollback is the point, but
		// keeping a runaway agent burning tokens for a day is not (spec 7.2).
		var settled []Effect
		run, settled = settleFailure(run, id, OutcomeTimedOut, "deadline exceeded", e.Now, []Effect{InterruptStage{Stage: id}})
		effects = append(effects, settled...)
	}
	return run, effects
}

// reduceCancel tears the run down: superseded by concurrency, or killed by a
// human. A cancelled stage does not route to on_failure, because the run is
// being torn down rather than routed (spec section 13.2).
func reduceCancel(run RunState, e CancelRequested) (RunState, []Effect) {
	next := run.clone()
	next.CancelReason = e.Reason
	next.UpdatedAt = e.Now

	effects := make([]Effect, 0, 2*len(next.Stages)+2)
	effects = append(effects, PersistRun{})
	for _, id := range next.Def.stageIDs() {
		st := next.Stages[id]
		if st == nil || st.Outcome.IsSettled() {
			continue
		}
		st.SettledAt = e.Now
		if st.Outcome != OutcomeRunning {
			// It never ran, and skipped is not failed.
			st.Outcome = OutcomeSkipped
			continue
		}
		st.Outcome = OutcomeCancelled
		effects = append(effects, CancelStageExec{Stage: id})
		effects = appendSessionDisposition(effects, &next, id, OutcomeCancelled)
	}

	next.Status = RunCancelled
	next.SettledAt = e.Now
	return next, append(effects, RunSettled{Status: RunCancelled})
}

// appendSessionDisposition hands the driver an agent stage's settled outcome so
// it can apply the stage's kill-on rule. The reducer only reports the
// settlement; kill versus keep-and-mark-orphaned is EffectiveKillOn's call.
//
// A command stage and a stage that never launched have no session, so neither
// produces one.
func appendSessionDisposition(effects []Effect, run *RunState, stageID string, outcome Outcome) []Effect {
	st := run.Stages[stageID]
	def := run.Def.StageByID(stageID)
	if st == nil || st.SessionID == "" || def == nil || def.Executor != ExecutorAgent {
		return effects
	}
	return append(effects, SettleSession{Stage: stageID, SessionID: st.SessionID, Outcome: outcome})
}

// inFlight reports whether a stage can still settle: running, or pending with a
// launch already committed. The second case is how a launch that never got off
// the ground settles.
func inFlight(st *StageState) bool {
	return st.Outcome == OutcomeRunning || (st.Outcome == OutcomePending && st.Attempt > 0)
}

// advance runs the two passes that follow any settlement, then settles the run
// if nothing is left in flight. It takes the stage commands the caller already
// decided on, so they land in effect order ahead of RunSettled.
//
// run is already a copy-on-write clone by the time advance sees it, so it is
// written through in place.
func advance(run *RunState, effects []Effect, now time.Time) []Effect {
	skipUnreachable(run, now)
	if !allSettled(run) {
		return effects
	}
	run.Status = settledRunStatus(run)
	run.SettledAt = now
	return append(effects, RunSettled{Status: run.Status})
}

// startSuccessTargets takes the settled stage's on_success edges. A list fans
// out and the targets start concurrently; a target that is a join starts only
// once every stage in its needs has succeeded.
func startSuccessTargets(run *RunState, from string, now time.Time) []Effect {
	src := run.Def.StageByID(from)
	if src == nil {
		return nil
	}
	effects := make([]Effect, 0, len(src.OnSuccess))
	for _, target := range src.OnSuccess {
		def := run.Def.StageByID(target)
		if def == nil || !canEnter(run, target) || !needsMet(run, def) {
			continue
		}
		// A join has no sole predecessor, so AO_PREV_* stays unset there
		// (spec section 12.2). Same ambiguity that rejects `inherit` at a join.
		prev := from
		if len(def.Needs) > 1 {
			prev = ""
		}
		effects = append(effects, startStage(run, target, EntrySuccess, prev, now))
	}
	return effects
}

// canEnter reports whether a stage can still be entered: it must be seeded,
// pending, and not already committed to a launch. The attempt check is what
// makes a second arrival at the same stage a no-op.
func canEnter(run *RunState, id string) bool {
	st := run.Stages[id]
	return st != nil && st.Outcome == OutcomePending && st.Attempt == 0
}

// needsMet reports whether every stage in the target's needs has succeeded. A
// need that settled any other way never becomes met, and the join is skipped
// by skipUnreachable rather than started here.
func needsMet(run *RunState, def *Stage) bool {
	for _, need := range def.Needs {
		st := run.Stages[need]
		if st == nil || !st.Outcome.IsSuccess() {
			return false
		}
	}
	return true
}

// startStage commits a stage to a launch and returns the effect that performs
// it. The stage stays pending until the driver reports it launched; Attempt is
// what records that a launch is already in flight.
func startStage(run *RunState, id string, via EntryEdge, prev string, now time.Time) Effect {
	st := run.Stages[id]
	st.Attempt = 1
	st.EnteredVia = via
	st.PrevStage = prev
	run.UpdatedAt = now
	return StartStage{Stage: id, Attempt: st.Attempt}
}

// skipUnreachable settles every pending stage that nothing can route into any
// more. Without it a run never settles: plan-at-start seeds the failure path
// too, and a run where everything succeeded must still close those cards.
//
// A stage is skipped, not failed. When B does not run because A died, B did
// not fail, and conflating them makes the board unreadable at exactly the
// moment someone is debugging.
func skipUnreachable(run *RunState, now time.Time) {
	dead := map[string]bool{}
	for {
		live := enterable(run, dead)
		grew := false
		for id, st := range run.Stages {
			if st.Outcome != OutcomePending || st.Attempt > 0 || live[id] || dead[id] {
				continue
			}
			// A join whose need did not succeed dies here even while another
			// need is still running, so the board stops promising a stage that
			// cannot happen. Its own targets die on the next pass.
			dead[id] = true
			grew = true
		}
		if !grew {
			break
		}
	}
	for id := range dead {
		st := run.Stages[id]
		st.Outcome = OutcomeSkipped
		st.SettledAt = now
		run.UpdatedAt = now
	}
}

// enterable is the set of stages the run can still reach: everything in flight
// (running, or committed to a launch), plus the forward closure of that over
// success and failure edges. Stages already known dead are not traversed, so
// the skip cascades down the branch behind them.
//
// A settled stage is never included: it already routed, so it cannot route
// again.
func enterable(run *RunState, dead map[string]bool) map[string]bool {
	live := make(map[string]bool, len(run.Stages))
	queue := make([]string, 0, len(run.Stages))
	for id, st := range run.Stages {
		if dead[id] {
			continue
		}
		if st.Outcome == OutcomeRunning || (st.Outcome == OutcomePending && st.Attempt > 0) {
			live[id] = true
			queue = append(queue, id)
		}
	}

	edges := run.Def.routingEdges()
	for len(queue) > 0 {
		id := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		for _, target := range edges[id] {
			st := run.Stages[target]
			if st == nil || dead[target] || live[target] || st.Outcome.IsSettled() {
				continue
			}
			live[target] = true
			queue = append(queue, target)
		}
	}
	return live
}

// allSettled reports whether no stage is pending or running, which is exactly
// when the run is over.
func allSettled(run *RunState) bool {
	for _, st := range run.Stages {
		if !st.Outcome.IsSettled() {
			return false
		}
	}
	return true
}

// settledRunStatus rolls the stage outcomes up into the run's board column:
// cancelled if the run was cancelled, else failed if any stage settled in
// {failed, no_output, no_signal, timed_out}, else succeeded. A
// succeeded_unverified stage still yields a succeeded run, and so does a
// skipped one.
func settledRunStatus(run *RunState) RunStatus {
	if run.Status == RunCancelled || run.CancelReason != "" {
		return RunCancelled
	}
	for _, st := range run.Stages {
		if st.Outcome.RoutesToFailure() {
			return RunFailed
		}
	}
	return RunSucceeded
}

// isSettled reports whether the run reached a terminal status.
func (s RunStatus) isSettled() bool {
	return s == RunSucceeded || s == RunFailed || s == RunCancelled
}

// clone returns a copy the reducer can write through without touching the
// caller's state. Def and Subject are frozen for the life of the run and only
// ever read, so they are shared rather than deep-copied; the stage map is
// rewritten entry by entry because that is the part every transition touches.
func (r RunState) clone() RunState {
	out := r
	out.Stages = make(map[string]*StageState, len(r.Stages))
	for id, st := range r.Stages {
		cp := *st
		out.Stages[id] = &cp
	}
	out.Nudged = maps.Clone(r.Nudged)
	return out
}
