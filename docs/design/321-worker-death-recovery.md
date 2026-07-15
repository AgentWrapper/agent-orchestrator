# Worker Death Recovery Design

Issue: #321

## Settled Behavior

AO treats a worker death with unfinished tracker work as a recovery incident, not
as a terminal notification and not as a blind retry. The recovery loop is:

1. Sense the dead worker and preserve the corpse facts.
2. Start or notify the project orchestrator to diagnose before cleanup removes
   evidence.
3. Record the diagnosis and the proposed fix/remediation on the issue and in
   operator attention.
4. Apply a new fix or scoped remediation through the normal authority boundary.
5. Respawn the worker only as verification of that new fix/remediation.
6. Observe the replacement past the original failure point.
7. If the replacement dies with the same fingerprint, re-enter diagnosis with
   the previous failed hypothesis attached and escalate the investigation rung.

The daemon owns deterministic state, evidence capture, notifications, and
spawn/observe mechanics. The project orchestrator owns judgment for the first
diagnosis/remediation pass. If the same incident repeats unresolved, the daemon
marks the rung for Orc-coordinated investigation; a subsequent repeat marks it
for prime-level engagement. The operator is paged only for causes that require
operator authority, such as credentials, billing, caps, or an explicit policy
change.

## Design Decisions

### Recovery Supervisor Placement

The daemon is the recovery supervisor of record because it is the only tier that
sees lifecycle, session, PR, notification, and spawn facts reliably. It does not
perform agent judgment. It creates and advances a durable recovery incident, then
routes judgment work to the project orchestrator through attention and a
session-safe prompt/nudge path.

The project orchestrator is the first judgment rung. It diagnoses the corpse,
files or works the fix according to the normal issue/PR gate, and asks AO to
verify by respawn only after a new fix/remediation exists. Repeated failures
escalate the incident rung: worker-level diagnosis, then Orc-coordinated
multi-angle investigation, then prime engagement for systemic causes.

### Evidence Preservation And Cleanup

Unexplained worker deaths defer automatic cleanup for the dead session's
workspace until recovery is resolved or an operator explicitly cleans it. The
incident stores a snapshot of durable evidence that cleanup cannot erase:

- dead session id, issue id, project id, display name, harness, model, branch,
  workspace path, created/updated timestamps, terminal failure reason, last
  activity state, and first signal timestamp;
- any open PR owned by the dead worker;
- the failure point as the best available durable marker, initially terminal
  failure reason plus activity state and PR state.

AO must not persist raw terminal byte streams in SQLite. A recovery prompt may
link the investigator to the session/workspace/log surfaces, but the durable
incident stores bounded metadata and diagnosis summaries only.

### Repeat-Death Fingerprint

The repeat fingerprint is:

```
project_id + canonical_issue_id + terminal_failure_reason + failure_point
```

`failure_point` is initially the activity state plus open-PR identity/state when
present. Later phases may enrich it with a structured phase marker if worker
hooks expose one, but the v1 fingerprint must not depend on terminal logs.

A replacement death with the same fingerprint and no intervening verified fix is
a repeat. A repeat increments the incident attempt, records the prior hypothesis
as failed, and prevents the same-fix respawn path from running again.

### Capacity Lane

Recovery diagnosis sessions use a small reserved lane outside the normal worker
cap: they are orchestrator/prime work, not ordinary implementation workers. The
respawn used to verify the fix remains a normal worker and consumes normal worker
capacity. If the normal worker cap is full, verification waits; diagnosis does
not starve behind unrelated intake.

### Spend Visibility

AO does not hard-cap recovery attempts by count. Each incident keeps an audit
trail with attempt number, rung, spawned session ids, fix/remediation reference,
verification result, and timestamps. Operator attention and Slack copy include
the attempt and rung so spend is visible while the loop continues.

### Authority Boundary

Respawn is authorized only when the incident records a new fix or scoped
remediation reference after the death being verified. The daemon refuses a
same-fix respawn for the same fingerprint. Merge authority, config mutation
guards, assignment-only intake, and normal worker cap semantics remain unchanged.

## Implementation Shape

Add a durable `recovery_incidents` noun under the existing domain -> migration /
store -> service -> transport pattern. The first slice should be backend-only
and projection-visible:

- create/update an incident when tracker intake sees a dead worker with
  unfinished work;
- preserve the existing `worker_died_unfinished` notification, enriched with
  recovery attempt/rung/action copy;
- project the incident through canonical operator attention instead of adding a
  parallel classifier;
- expose recovery state through session/issue-linked APIs or issue comments only
  where the existing service boundary already has those dependencies;
- defer cleanup for sessions with unresolved recovery incidents.

Later slices may add explicit CLI commands for `ao recovery diagnose`, `ao
recovery remediate`, and `ao recovery verify`, but the first implementation
must keep the lifecycle invariant: no automatic respawn without a new fix or
remediation record.

## Non-Goals

- No resurrection of the removed #210/#231/#243 retry subsystem.
- No blind respawn and no respawn count cap that abandons the incident.
- No new Slack or JavaScript attention classifier.
- No daemon-side PR merge or code mutation executor.
- No storage of raw terminal streams.
- No weakening of sensitive-path merge parking or operator-only authority.
