# Issue 151 - Orchestrator Kickoff And Wake

## Settled Behavior

- Orchestrator spawn and restore deliver a Go-owned kickoff user message through the existing prompt delivery path.
- The kickoff message tells the orchestrator to read its repo standing policy file and begin the supervision loop.
- The daemon owns kickoff and wake delivery mechanics; repos own policy content through the existing role instructions file.
- Project config may set `orchestrator.wakeInterval`; unset uses the daemon default of 15 minutes.
- Periodic wake nudges are sent only to live orchestrator sessions in `waiting_input` or `idle` whose last activity is older than the resolved interval.
- Wake eligibility requires a harness with AO activity hooks and at least one observed activity signal. Spawn and restore kickoff delivery is handled by the prompt-delivery path; the periodic wake loop does not paste into panes whose state is only the seeded launch default.
- Sessions in `blocked` are never auto-woken.
- Wake nudges use a dedicated guarded idle-wake path that re-reads session state immediately before sending and permits only `waiting_input` or `idle`; `blocked`, terminated, and already-active races are suppressed.
- A per-daemon wake memo prevents repeated 30-second wake attempts when a wake send fails or does not produce a fresh activity hook. Delivered-but-unanswered wakes now use `wakeBackoff` exponential intervals (`enabled`, `base`, `max`) capped by config; relevant reset events only collapse the interval after the daemon role has recorded activity, and idle sessions are not suspended or killed.

## Implementation Plan

1. Session manager kickoff
   - Add a dedicated orchestrator kickoff message helper beside `orchestratorPrompt`.
   - Return that message from spawn prompt construction when the session kind is orchestrator and no explicit prompt was supplied.
   - Persist the kickoff in session metadata so fresh-launch restore fallbacks replay it through existing launch config.
   - Keep role instructions and confidentiality rules in the system prompt, not the user message.

2. Restore behavior
   - Ensure orchestrator restore paths send the kickoff prompt when the adapter natively resumes and carry it when the adapter falls back to fresh launch.
   - Add tests that cover spawn kickoff, after-start kickoff delivery, native restore kickoff, and fallback restore kickoff.

3. Project wake configuration
   - Extend role settings with `orchestrator.wakeInterval`.
   - Default unset to 15 minutes and reject non-positive values.
   - Preserve JSON config shape under the existing `orchestrator` object.

4. Supervisor wake loop
   - Continue ensuring one orchestrator per project as today.
   - After ensure, send a wake nudge to eligible waiting or idle orchestrators only.
   - Route wake sends through `Manager.WakeIdle` / `sessionguard.WakeIdle` so blocked-session safety remains centralized while the waiting-input orchestrator wake is an explicit exception to generic automated nudges.
   - Confirm a sent wake using the same safe Enter-confirmation loop as user sends, stamp delivered or failed wake sends in the supervisor loop to throttle repeated attempts until the configured interval elapses again, leave guard-suppressed wakes unstamped, and back off delivered-but-unanswered wakes exponentially until fresh activity or an activity-backed reset event returns the session to the base interval.

5. Tests and gates
   - Add unit tests for kickoff on spawn, kickoff on restore and switch, wake after idle threshold, no wake before the first observed signal, no wake while blocked, repeated wake throttling and cap, guarded idle wake behavior, and project wake interval defaults/validation.
   - Run backend tests, vet, and build before push.
