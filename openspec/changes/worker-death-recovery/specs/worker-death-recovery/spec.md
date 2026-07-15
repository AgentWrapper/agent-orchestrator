# worker-death-recovery

## ADDED Requirements

### Requirement: Death triggers automatic recovery

When a worker session dies with unfinished work, AO SHALL automatically enter the recovery loop (sense → diagnose → fix → verify-by-respawn). Manual operator restart SHALL NOT be a required step of recovery; the operator MAY halt recovery at any time via the existing pause control.

#### Scenario: Worker dies with unfinished work

- **WHEN** a worker session terminates and its work item is not complete (issue open, no merged PR closing it)
- **THEN** AO records the terminal failure reason and starts a diagnosis pass without operator action, and emits a durable recovery-started marker on the work item's issue

#### Scenario: Worker completes cleanly

- **WHEN** a worker session terminates with its work item complete
- **THEN** no recovery loop starts

### Requirement: Evidence is preserved for diagnosis

Recovery SHALL diagnose against the dead session's evidence (workspace, transcript/pane history, terminal failure reason, session metadata) BEFORE any cleanup that would destroy it. Workspace and session cleanup for an unexplained death SHALL be deferred until the diagnosis pass has captured what it needs.

#### Scenario: Cleanup deferred on unexplained death

- **WHEN** a worker dies and no diagnosis has yet recorded a root cause
- **THEN** automatic workspace/session cleanup for that session is deferred, and the diagnosis pass runs against the preserved evidence

#### Scenario: Cleanup proceeds after evidence capture

- **WHEN** the diagnosis pass records its root-cause report for a death
- **THEN** normal cleanup for that session is unblocked

### Requirement: Diagnosis produces a durable root cause

Each recovery cycle SHALL produce a root-cause report classifying the death by cause class (at minimum: code defect, config/environment, external dependency, unknown) and SHALL post it durably to the work item's GitHub issue, the operator attention projection, and Slack before any fix work begins.

#### Scenario: Root cause posted before fix

- **WHEN** a diagnosis pass completes
- **THEN** the work item's issue carries a root-cause comment (cause class, evidence summary, proposed fix direction) and the attention projection and Slack surface the recovery state

### Requirement: Fix routing by cause class

Fixes SHALL route by cause class. A code-caused death SHALL produce a fix through the standard worktree/TDD/PR flow with all existing merge gates unchanged. A config/environment-caused death SHALL produce either scoped remediation within existing agent authority or a parked, specific operator ask naming exactly the authority needed (credentials, billing/caps, operator-owned config). Recovery SHALL NOT end in an unactionable notification.

#### Scenario: Code cause

- **WHEN** diagnosis attributes the death to a code defect
- **THEN** a fix lands via the normal gated PR flow before any respawn of the affected work

#### Scenario: Operator-authority cause

- **WHEN** diagnosis attributes the death to a cause outside agent authority (e.g. a capped provider account)
- **THEN** recovery parks with a specific operator ask naming the needed action and authority, and remains parked until the operator acts

### Requirement: Respawn only behind a new fix, verified past the failure point

A respawn SHALL be authorized only by a fix (or remediation) that did not exist at the previous death. The respawned worker SHALL be observed past the original failure point, and that verification SHALL be recorded durably. Blind respawn — respawn with no new fix — SHALL NOT occur under any circumstances.

#### Scenario: Verified respawn

- **WHEN** a fix for the diagnosed cause is in place and the worker is respawned
- **THEN** AO observes the respawned worker past the point of the original failure and records the verification (fix reference, respawn session, observation result) on the work item's issue

#### Scenario: No new fix, no respawn

- **WHEN** no new fix exists since the last death of that work item
- **THEN** AO does not respawn the worker

### Requirement: Repeat death re-enters diagnosis and never abandons

A repeat death of the same work item SHALL be treated as new evidence: recovery SHALL re-enter diagnosis carrying the accumulated corpse evidence and failed-fix history. Recovery SHALL NOT terminate after a fixed number of attempts and SHALL NOT silently abandon the problem; it continues, escalating per the recovery-escalation capability, until the work item recovers or a parked operator-authority ask is outstanding.

#### Scenario: Fix did not hold

- **WHEN** a respawned worker dies again on the same work item
- **THEN** recovery re-enters diagnosis with the prior root-cause report, the failed fix, and both corpses' evidence as inputs, and escalates investigative intensity per the escalation ladder

#### Scenario: Death fingerprint distinguishes repeat from novel

- **WHEN** the new death's fingerprint (cause class + failure point + terminal reason) differs from the prior death
- **THEN** recovery treats it as a distinct cause requiring its own diagnosis rather than evidence that the prior fix failed

### Requirement: Every stage is operator-visible

Every recovery stage transition (recovery started, root cause posted, fix in progress, fix landed, respawn + verification, escalation rung change, operator-authority park) SHALL emit durable audit markers: a comment on the work item's issue and representation in the single operator attention projection, with Slack delivery via the existing notifier. The chat transcript SHALL NOT be the record.

#### Scenario: Operator observes a full cycle

- **WHEN** a recovery cycle runs end to end
- **THEN** the work item's issue alone is sufficient to reconstruct what died, why, what was fixed, how the fix was verified, and who (worker/Orc/prime) did each step

### Requirement: Landing gates and intake invariants unchanged

Recovery SHALL NOT weaken any landing gate or intake invariant: SHA-pinned final-review + merge-park merge authority, the config-mutation guard, assignment-only intake, and the worker cap remain exactly as specified outside this capability.

#### Scenario: Recovery fix PR merges

- **WHEN** a recovery-produced fix PR is ready
- **THEN** it merges only through the same review/CI/authority gates as any other PR
