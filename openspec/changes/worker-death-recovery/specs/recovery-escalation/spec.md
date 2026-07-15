# recovery-escalation

## ADDED Requirements

### Requirement: Escalation ladder uses the full fleet hierarchy

Unresolved recovery SHALL escalate within the fleet with increasing investigative intensity across three rungs: (1) worker-level diagnosis, (2) Orc-coordinated multi-angle investigation (parallel hypotheses, cross-family deep reasoning), (3) prime-level engagement for systemic or cross-cutting causes. Worker death is the case the hierarchy exists for; recovery SHALL be entitled to the fleet's full investigative resources.

#### Scenario: First death

- **WHEN** a work item's first death enters recovery
- **THEN** a worker-level diagnosis pass runs (rung 1)

#### Scenario: Fix failed once

- **WHEN** a repeat death occurs after a rung-1 fix (same fingerprint, fix did not hold)
- **THEN** the investigation promotes to rung 2: the project Orc coordinates a multi-angle investigation with independent parallel hypotheses, including at least one reviewer/investigator from a different model family than the failed fix's author

#### Scenario: Systemic cause suspected

- **WHEN** diagnosis at any rung attributes the cause to something beyond the single work item (daemon defect, provider outage, config plane, multiple work items dying with related fingerprints)
- **THEN** the investigation promotes to rung 3 (prime), which owns the cross-cutting diagnosis and MAY pause affected intake while the systemic fix lands

### Requirement: Promotion triggers are explicit

Rung promotion SHALL be rule-driven, not discretionary: a failed fix on the same fingerprint promotes one rung; a systemic-cause classification promotes directly to prime; a diagnosis pass that ends in cause class "unknown" promotes one rung rather than guessing. Each promotion SHALL be recorded durably with its trigger.

#### Scenario: Unknown cause promotes

- **WHEN** a diagnosis pass cannot establish a root cause (class "unknown")
- **THEN** the investigation promotes one rung and re-runs with broader resources, rather than authorizing any fix or respawn on a guess

### Requirement: Operator park only for operator authority

Recovery SHALL park to the operator only when the diagnosed cause requires authority agents do not hold (credentials, billing/provider caps, operator-owned config), and the park SHALL name the specific action requested. Escalation to the operator SHALL NOT be used as a give-up valve for difficult diagnosis; difficulty escalates rungs, not to the operator.

#### Scenario: Capped provider account

- **WHEN** diagnosis attributes deaths to a capped provider account
- **THEN** recovery parks with the ask naming the account and the operator action needed, and the affected work items are shielded from re-dispatch until it is resolved

### Requirement: Spend and attempts are transparent, not capped

Recovery SHALL NOT impose a hard attempt or spend cap (operator direction, GH #321). Instead, every cycle SHALL leave a per-incident trail — attempts, rung, sessions consumed, and fixes tried — visible from the work item's issue, and the recovery state SHALL appear in the operator attention projection while active, so the operator can observe and halt (pause) at any time.

#### Scenario: Long-running recovery is observable

- **WHEN** a recovery incident runs multiple cycles across rungs
- **THEN** the work item's issue shows the cumulative attempt/rung/fix history and the attention projection shows the incident as active, without recovery self-terminating on a counter

### Requirement: Recovery capacity must not starve intake

Recovery and diagnosis sessions SHALL be accounted for such that normal intake is not starved: either a small reserved recovery lane or explicit priority rules over normal worker slots. The design SHALL pick one mechanism and specify it; recovery work SHALL NOT bypass capacity accounting entirely.

#### Scenario: Fleet at capacity when a death occurs

- **WHEN** a worker dies while the fleet is at its concurrency cap
- **THEN** the diagnosis pass still runs under the chosen capacity mechanism, and its capacity usage is visible in fleet status
