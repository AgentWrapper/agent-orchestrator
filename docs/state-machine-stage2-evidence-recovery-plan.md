# State Machine Stage 2 Plan: Evidence, Detecting, And Recovery

Status: Draft  
Primary issue: #95  
Target branch: `sessions-redone`  
Inputs:
- `~/.ao/ao-ahead/human-work/redesign.md`
- `~/.ao/ao-ahead/aa-2/state-machine-redesign-rollout-plan.md`
- `docs/state-machine-redesign.md`
- `CLAUDE.md`

## Purpose

Stage 2 is where lifecycle classification stops being a pile of loosely competing probes and becomes an explicit evidence assessment system.

The goal is not to add more statuses. The goal is to make AO answer six questions cleanly and in order:

1. what evidence exists right now
2. how fresh and trustworthy that evidence is
3. whether the evidence agrees
4. whether the system should enter `detecting`
5. whether retries are still allowed
6. whether AO should recover automatically, wait for a human, or declare a terminal outcome

This document is planning only. It defines policy, sequencing, and acceptance criteria for Stage 2. It does not prescribe code-level implementation details yet.

## Scope

Stage 2 covers:

- evidence assessment for runtime, process, activity, and PR-adjacent signals
- `detecting` state semantics and exit rules
- signal disagreement classification
- stale evidence policy by source type
- bounded retry policy for uncertain or failed probes
- recovery rules for worker and orchestrator sessions
- decision logging needed to explain why AO chose a state

Stage 2 does not cover:

- agent-authored lifecycle reporting commands
- prompt changes to force explicit acknowledgment or waiting signals
- UI redesign beyond the minimum data contracts Stage 2 requires
- full PR workflow automation redesign

## Design Position

Stage 2 should treat runtime truth, process truth, activity truth, and PR truth as separate inputs to an assessment pass. No single weak signal should be allowed to kill a session. `detecting` is the controlled buffer state used when the system cannot yet defend a confident answer.

The practical policy is:

- prefer explicit facts over heuristics
- prefer `detecting` over a false terminal label
- prefer bounded waiting over infinite ambiguity
- prefer recovery when the session is plausibly resumable
- prefer human escalation when the evidence is conflicting after retries

## Evidence Inventory

Each assessment pass should normalize evidence into a common shape with `source`, `observedAt`, `freshness`, `reliability`, and `value`.

### Source classes

- runtime evidence
  - tmux/session handle exists
  - runtime plugin reports reachable or unreachable
- process evidence
  - agent process scan reports running or not running
  - pid metadata exists or is missing
- activity evidence
  - structured agent activity
  - AO-generated activity markers
  - terminal output heartbeat only as weak fallback
- recovery evidence
  - provider-specific session resumability
  - known recovery action available
- PR evidence
  - PR open, merged, closed, CI pending, CI failing, review comments
- operator evidence
  - explicit user kill
  - explicit user continue/resume request

### Reliability tiers

- `authoritative`
  - explicit user kill
  - successful runtime/plugin confirmation
  - successful provider resumability check
- `strong`
  - process running or not running from a validated probe
  - fresh structured activity from AO or provider logs
- `supporting`
  - recent terminal output without structured semantics
  - existing metadata from prior successful scans
- `historical`
  - stale activity
  - previous assessment results

## Assessment Model

Every lifecycle pass should produce an evidence report before it produces a session state.

### Pass order

1. collect the latest evidence for runtime, process, activity, recovery, and PR
2. grade each evidence item for freshness and reliability
3. detect contradictions
4. decide whether the contradiction is resolvable within retry bounds
5. emit one of:
   - confident classification
   - `detecting`
   - terminal outcome with explicit reason
   - recovery-needed classification

### Required outputs

Each pass should produce:

- session assessment outcome
- primary reason
- evidence summary
- disagreement summary if any
- retry counter state
- recovery recommendation if any

## `detecting` State Semantics

`detecting` is not a synonym for `unknown`. It is an active assessment window where AO is intentionally trying to resolve conflicting, missing, or failed evidence.

### Enter `detecting` when

- runtime and process signals disagree
- runtime is unreachable but fresh activity still exists
- process probe fails in a way that could be transient
- activity is recent enough to block a dead classification but not enough to confirm health
- recovery appears possible but the recovery preconditions are not yet confirmed
- required probes time out or return incomplete data

### Do not enter `detecting` when

- user kill is explicit and confirmed
- runtime and process are both confirmed dead and no recovery path exists
- session is intentionally terminal for a reason independent of liveness
- the same disagreement has already exhausted the retry budget

### Exit `detecting` when

- evidence converges on a confident non-terminal state
- evidence converges on a terminal outcome
- bounded retries are exhausted and the result must be escalated
- recovery succeeds and a new healthy state is established
- recovery is impossible and the terminal reason is clear

## Signal Disagreement Handling

Disagreement handling must be explicit. Stage 2 should classify disagreements instead of burying them inside ad hoc fallthrough logic.

### Core disagreement classes

- `runtime_alive_process_dead`
- `runtime_dead_process_alive`
- `runtime_dead_recent_activity`
- `process_alive_no_recent_activity`
- `probe_failed_runtime_unknown`
- `probe_failed_process_unknown`
- `pr_terminal_runtime_alive`
- `recovery_possible_runtime_uncertain`

### Resolution policy

- `runtime_alive_process_dead`
  - treat as likely recoverable worker failure
  - enter `detecting`
  - retry process probe
  - evaluate resumability before declaring terminal
- `runtime_dead_process_alive`
  - treat process evidence as suspicious
  - prefer `detecting`
  - retry runtime probe
  - downgrade process evidence if the runtime container/session cannot be confirmed
- `runtime_dead_recent_activity`
  - treat stale-vs-live timing carefully
  - recent structured activity blocks immediate death
  - historical activity does not
- `process_alive_no_recent_activity`
  - do not classify as dead
  - remain in current workflow state or `idle`/`stuck` depending on broader context
- `pr_terminal_runtime_alive`
  - do not kill solely because the PR state is terminal
  - classify workflow and runtime separately

## Stale Evidence Policy

Stale evidence should explain history, not overrule current hard facts.

### Freshness windows

- structured activity
  - `0s-60s`: strong support for liveness
  - `61s-5m`: weak support for liveness, enough to block immediate death on its own
  - `>5m`: historical only
- terminal heartbeat output
  - `0s-30s`: supporting only
  - `31s-2m`: weak historical context
  - `>2m`: ignore for liveness decisions
- runtime/process probe results
  - `0s-30s`: current
  - `31s-90s`: usable but should be refreshed before a terminal classification
  - `>90s`: stale for decisive outcomes
- PR state
  - remains authoritative for PR truth
  - does not become authoritative for runtime death

### Rules

- stale activity cannot by itself prove the session is alive
- stale activity can explain why AO avoided a dead classification earlier
- a terminal outcome requires current hard evidence or an explicit operator action
- recovery eligibility may use stale evidence only to rank options, not to assert that recovery is safe

## Bounded Retry Policy

`detecting` must be temporary. Every disagreement path needs a fixed retry budget and an explicit escalation outcome.

### Retry budgets

- transient probe failures
  - retry up to 3 times
  - exponential spacing such as immediate, 10s, 30s
- hard disagreement with partial evidence
  - retry up to 2 full assessment passes after the initial pass
- recovery attempt verification
  - allow 1 recovery attempt per assessment cycle unless the operator explicitly asks again

### Retry stop conditions

- decisive evidence arrives
- the retry budget is exhausted
- an operator action overrides automated handling
- the recovery subsystem returns a definitive non-recoverable result

### Escalation after retries

When retries are exhausted, AO should not loop forever. It should produce one of:

- `stuck` with a clear reason if human action is needed
- terminal with explicit reason if death is defensible
- recovery-pending-human if recovery exists but is unsafe to auto-run

## Recovery Rules

Recovery must be policy-driven, not implicit.

### Worker sessions

Auto-recovery is allowed when:

- the runtime is reachable or can be recreated safely
- the provider session is resumable or a new worker can be created with preserved context
- the failure reason is operational rather than semantic
- there is no explicit user kill or explicit human stop condition

Human-gated recovery is required when:

- the evidence is still contradictory after retries
- PR state suggests the worker should be preserved rather than replaced
- the replacement action could duplicate work or create PR confusion
- permissions or credentials are required

Do not auto-recover when:

- the user explicitly killed the session
- the provider reports the session as non-resumable and replacement would violate workflow policy
- the session is already intentionally terminal

### Orchestrator sessions

Orchestrators should have a higher bar for terminal classification and auto-recovery attempts because they coordinate other sessions.

Policy:

- prefer recovery over terminal classification
- require stronger evidence before declaring them dead
- never tie orchestrator death to PR state
- surface unresolved orchestrator disagreements prominently for human review

## Recovery Outcome Matrix

### Recover automatically

- worker runtime reachable, process dead, resumable session available
- worker runtime reachable, process dead, replacement worker policy explicitly allows restart

### Wait for human

- retries exhausted with unresolved disagreement
- PR merged or closed but runtime is still alive and policy choice is needed
- recovery would create a second worker or reopen a completed workflow

### Declare terminal

- explicit user kill confirmed
- runtime and process both confirmed dead after fresh probes
- recovery path explicitly unavailable and workflow policy allows termination

## Decision Logging Requirements

Stage 2 needs durable reasoning trails so the dashboard and operators can understand why a status changed.

Each assessment result should record:

- prior session state and reason
- new session state and reason
- major evidence items considered
- freshness classification for each decisive signal
- disagreement code if one existed
- retry count and remaining budget
- recovery action attempted, skipped, or blocked

## Acceptance Criteria

Stage 2 is ready when the plan can support these guarantees:

- AO no longer declares a session dead from one weak signal
- `detecting` has defined entry and exit conditions
- every disagreement class has a retry policy and an escalation outcome
- stale evidence has explicit freshness windows by source type
- worker and orchestrator recovery policies differ where operationally necessary
- every terminal outcome has a defendable reason
- operators can inspect why AO chose the current state

## Suggested Implementation Sequence

1. define evidence data shapes and disagreement codes
2. define freshness grading and stale evidence rules
3. extract lifecycle assessment into a dedicated evaluation step
4. wire `detecting` entry, exit, and retry counters
5. define recovery policy gates for worker versus orchestrator sessions
6. add decision logging and test scenarios for each disagreement class

## Open Decisions To Confirm Before Coding

- whether the activity freshness windows should differ by agent provider
- whether terminal output should be considered at all once structured activity exists
- whether worker replacement and session resume are separate recovery classes in Stage 2 or deferred to Stage 3
- whether retry counters live in session metadata or are recomputed from assessment history
- whether `stuck` is emitted directly by Stage 2 or remains a later projection over assessment outcomes
