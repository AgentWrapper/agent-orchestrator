# Stage 1 Plan: Canonical Lifecycle Model and Persistence Foundation

## Intent

Stage 1 is a planning and foundation stage. It does not redesign the dashboard, change reaction behavior, or implement auto-recovery. Its job is to replace the current overloaded lifecycle model with a canonical persisted model that can safely support later stages.

This plan is derived from the redesign brief for this project and from the current implementation in:

- `packages/core/src/types.ts`
- `packages/core/src/session-manager.ts`
- `packages/core/src/lifecycle-manager.ts`
- `packages/core/src/metadata.ts`
- `packages/core/src/utils/session-from-metadata.ts`
- `packages/web/src/lib/serialize.ts`
- `packages/web/src/lib/types.ts`

## Stage 1 Goals

1. Define one canonical lifecycle model for sessions that separates session truth from PR truth.
2. Introduce persisted structured state so the system stops depending on a single overloaded `status` string plus ad hoc metadata keys.
3. Make it explicit which fields are authoritative facts and which are derived projections for the UI, notifications, and reactions.
4. Preserve backward compatibility long enough to migrate existing metadata files safely.
5. Keep Stage 1 limited to foundation work only, so later stages can build on stable persisted semantics.

## Stage 1 Non-Goals

1. Do not redesign the dashboard UX or kanban layout.
2. Do not implement new CI polling behavior, review automation, or notifier routing changes.
3. Do not add restore/recovery orchestration beyond the persisted fields required to support it later.
4. Do not replace the flat-file storage mechanism in Stage 1.
5. Do not change the meaning of every existing UI label yet; Stage 1 should provide a compatibility layer first.

## Current Problems To Fix First

1. `Session.status` currently mixes workflow state, PR state, and terminal/runtime outcomes into one enum.
2. `Session.activity` is partially authoritative but is not persisted as part of a structured lifecycle record.
3. Metadata persistence is an untyped key-value bag, so new state can be added without a stable contract.
4. `lifecycle-manager.ts` infers status by probing runtime, agent activity, and PR state, then writes a single `status` back to metadata, which loses the reason for the transition.
5. The web layer computes attention and display semantics from a mix of `status`, `activity`, and live PR enrichment, which makes later redesign work risky unless the core truth model is stabilized first.

## Canonical Model To Introduce In Stage 1

Stage 1 should persist three first-class truth domains for every session:

1. `session`: what the agent session is doing as a workflow record.
2. `pr`: the state of the associated pull request, if one exists.
3. `runtime`: what is known about process/runtime liveness.

Each domain must persist both a coarse state and an explicit reason.

### 1. Session Domain

Persisted fields:

- `session.kind`: `orchestrator | worker`
- `session.state`: `not_started | working | idle | needs_input | stuck | detecting | done | terminated`
- `session.reason`: string enum, initially constrained to known reasons
- `session.startedAt`: ISO timestamp or null
- `session.completedAt`: ISO timestamp or null
- `session.terminatedAt`: ISO timestamp or null
- `session.lastTransitionAt`: ISO timestamp

Initial reason set for Stage 1:

- `spawn_requested`
- `agent_acknowledged`
- `task_in_progress`
- `pr_created`
- `fixing_ci`
- `resolving_review_comments`
- `awaiting_user_input`
- `awaiting_external_review`
- `research_complete`
- `merged_waiting_decision`
- `manually_killed`
- `runtime_lost`
- `agent_process_exited`
- `probe_failure`
- `error_in_process`

Notes:

- Worker sessions are workflow records, not just processes. A merged PR must not force `session.state = terminated`.
- Orchestrator sessions use the same shape but may enforce different allowed transitions later. Stage 1 only persists the distinction.

### 2. PR Domain

Persisted fields:

- `pr.state`: `none | open | merged | closed`
- `pr.reason`: `not_created | in_progress | ci_failing | review_pending | changes_requested | approved | merge_ready | merged | closed_unmerged`
- `pr.number`: number or null
- `pr.url`: string or null
- `pr.lastObservedAt`: ISO timestamp or null

Notes:

- `pr.state` must represent PR truth only.
- Existing lifecycle values such as `pr_open`, `ci_failed`, `review_pending`, `changes_requested`, `approved`, and `mergeable` move under `pr.reason`, not `session.state`.

### 3. Runtime Domain

Persisted fields:

- `runtime.state`: `unknown | alive | exited | missing | probe_failed`
- `runtime.reason`: `spawn_incomplete | process_running | process_missing | tmux_missing | manual_kill_requested | probe_error`
- `runtime.lastObservedAt`: ISO timestamp or null
- `runtime.handle`: existing runtime handle payload
- `runtime.tmuxName`: existing tmux name if applicable

Notes:

- Stage 1 does not finish the full recovery policy.
- Stage 1 does persist enough runtime truth to support the redesign brief's `detecting` state later without inventing it in the UI.

## What Remains Derived In Stage 1

The following should remain derived projections, not canonical persisted truth:

1. Dashboard attention zones such as `merge`, `respond`, `review`, `pending`, `working`, `done`.
2. Notification priority.
3. Whether a session should be shown as “actionable”.
4. Aggregate dashboard stats.
5. Temporary PR enrichment such as CI checks, review comment lists, and mergeability details.

## Persistence Design

Stage 1 should keep flat files, but move from loose keys to a versioned structured payload inside metadata.

### File Format Approach

Keep the existing key-value metadata file as the storage envelope for compatibility, but add a new canonical JSON field:

- `stateVersion=2`
- `statePayload=<json>`

`statePayload` should be a compact JSON object containing the three truth domains and key timestamps.

This is preferable to scattering dozens of new top-level keys because:

1. Stage 1 needs schema versioning.
2. The lifecycle record is hierarchical by nature.
3. Backward compatibility can be maintained by dual-writing selected legacy keys during migration.

### Proposed `statePayload` Shape

```json
{
  "version": 2,
  "session": {
    "kind": "worker",
    "state": "working",
    "reason": "fixing_ci",
    "startedAt": "2026-04-15T12:00:00.000Z",
    "completedAt": null,
    "terminatedAt": null,
    "lastTransitionAt": "2026-04-15T12:34:56.000Z"
  },
  "pr": {
    "state": "open",
    "reason": "ci_failing",
    "number": 123,
    "url": "https://github.com/org/repo/pull/123",
    "lastObservedAt": "2026-04-15T12:34:30.000Z"
  },
  "runtime": {
    "state": "alive",
    "reason": "process_running",
    "lastObservedAt": "2026-04-15T12:34:20.000Z",
    "handle": {},
    "tmuxName": "abc123-app-4"
  }
}
```

### Legacy Keys To Keep During Migration

Stage 1 should continue to write these top-level metadata keys for compatibility:

- `status`
- `pr`
- `branch`
- `issue`
- `project`
- `agent`
- `createdAt`
- `runtimeHandle`
- `tmuxName`
- `role`

`status` becomes a compatibility projection only. It should be derived from `statePayload`, never treated as the primary truth once Stage 1 lands.

## Core Type Changes Planned In Stage 1

### `packages/core/src/types.ts`

Add new types:

- `CanonicalSessionState`
- `CanonicalSessionReason`
- `CanonicalPRState`
- `CanonicalPRReason`
- `CanonicalRuntimeState`
- `CanonicalRuntimeReason`
- `SessionStateRecord`
- `PRStateRecord`
- `RuntimeStateRecord`
- `CanonicalSessionLifecycle`

Adjust `Session` to include:

- `lifecycle: CanonicalSessionLifecycle`

Keep the existing `status` and `activity` fields for compatibility in Stage 1, but document them as derived/legacy-facing.

### `packages/core/src/utils/validation.ts`

Replace the current `validateStatus()`-only approach with:

1. validation for `stateVersion`
2. parsing for `statePayload`
3. fallback synthesis from legacy metadata if `statePayload` is absent

### `packages/core/src/utils/session-from-metadata.ts`

Refactor session reconstruction so:

1. canonical lifecycle is parsed first
2. legacy `status` is only synthesized when needed
3. `activity` is not confused with canonical workflow state

## Metadata Read/Write Plan

### `packages/core/src/metadata.ts`

Stage 1 changes:

1. Add helpers to read and write `statePayload`.
2. Add a migration-safe update helper for lifecycle subtrees, so callers do not hand-edit raw JSON strings.
3. Continue exposing raw metadata functions for compatibility, but shift new code to typed helpers.

New helper candidates:

- `readCanonicalLifecycle(dataDir, sessionId)`
- `writeCanonicalLifecycle(dataDir, sessionId, lifecycle)`
- `updateCanonicalLifecycle(dataDir, sessionId, updater)`
- `deriveLegacyStatus(lifecycle)`

## Session Manager Work In Stage 1

### Spawn Paths

Update both worker and orchestrator spawn flows in `packages/core/src/session-manager.ts` so newly created sessions persist canonical lifecycle from the first write.

Worker spawn should initialize as:

- `session.kind = worker`
- `session.state = not_started`
- `session.reason = spawn_requested`
- `pr.state = none`
- `pr.reason = not_created`
- `runtime.state = unknown`
- `runtime.reason = spawn_incomplete`

Orchestrator spawn should initialize the same shape with `session.kind = orchestrator`.

### Session Reconstruction

`list()`, `get()`, `restore()`, `kill()`, and `claimPR()` must all read and mutate canonical lifecycle first, then project legacy keys.

### PR Claim / Attachment

When a PR is attached or detected:

1. update `pr.state` and `pr.reason`
2. do not overwrite `session.state` unless the workflow truth actually changed
3. stop using `status=pr_open` as the authoritative record

### Kill / Restore Semantics

Stage 1 should make these writes explicit:

1. manual kill updates `session.state = terminated`, `session.reason = manually_killed`
2. merged PR does not automatically terminate the session
3. restore eligibility should be evaluated from canonical runtime/session truth, not only legacy `status`

## Lifecycle Manager Work In Stage 1

### Determine Truth, Then Project

Refactor `determineStatus()` into a canonical evaluation flow:

1. observe runtime evidence
2. observe agent activity evidence
3. observe PR evidence
4. compute canonical `runtime`
5. compute canonical `pr`
6. compute canonical `session`
7. derive legacy `status` for compatibility

This keeps policy readable and prevents PR truth from overwriting workflow truth.

### Canonical Transition Rules For Stage 1

Initial rules:

1. runtime dead plus explicit manual kill signal => `session.terminated / manually_killed`
2. runtime dead without clear cause => `session.detecting / runtime_lost`
3. agent waiting for input => `session.needs_input / awaiting_user_input`
4. agent blocked or stale beyond threshold => `session.stuck / error_in_process` or `session.stuck / probe_failure` based on evidence
5. PR open with CI failure while agent is working => `session.working / fixing_ci`, `pr.open / ci_failing`
6. PR open with review comments while agent is working => `session.working / resolving_review_comments`, `pr.open / changes_requested`
7. PR merged while runtime alive => `session.idle / merged_waiting_decision`, `pr.merged / merged`

Stage 1 should encode these rules in code and tests, but avoid introducing later-stage automation decisions tied to them.

### Transition Evidence

Each canonical transition should persist:

- previous state
- new state
- reason
- observedAt

Stage 1 does not need a full append-only event log, but it should at minimum make the latest transition timestamp and reason durable.

## Web/API Compatibility Plan

Stage 1 should avoid breaking the current dashboard contract while shifting the source of truth.

### `packages/web/src/lib/serialize.ts`

1. Serialize the new canonical lifecycle alongside existing fields.
2. Continue populating `status` and `activity` for current UI consumers.
3. Prefer deriving `status` from canonical lifecycle rather than directly from old metadata.

### `packages/web/src/lib/types.ts`

Add optional fields for the new lifecycle record to `DashboardSession`, but do not require the UI to consume them yet.

Proposed additions:

- `lifecycle.sessionState`
- `lifecycle.sessionReason`
- `lifecycle.prState`
- `lifecycle.prReason`
- `lifecycle.runtimeState`
- `lifecycle.runtimeReason`

This lets Stage 2 update UI components without another API shape migration.

## Migration Plan

### Read Path

1. If `statePayload` exists and validates, use it.
2. If not, synthesize canonical lifecycle from legacy metadata plus live runtime enrichment.
3. If synthesis succeeds, dual-write back `statePayload` lazily on the next safe update.

### Write Path

For all state mutations during Stage 1:

1. write canonical lifecycle
2. derive and write legacy `status`
3. keep existing top-level keys synchronized during the migration window

### Archive Compatibility

Archived session files must preserve `statePayload` unchanged. Restore logic must be able to read either v1-only metadata or v2 metadata with `statePayload`.

## Test Plan For Stage 1

### Core Unit Tests

Add or update tests for:

1. canonical lifecycle parsing from fresh v2 metadata
2. fallback synthesis from legacy metadata
3. legacy status derivation from canonical lifecycle
4. worker spawn initialization
5. orchestrator spawn initialization
6. PR attach and PR detect flows
7. merged-PR-but-runtime-alive behavior
8. manual kill behavior
9. restore eligibility derived from canonical lifecycle
10. archive read/write compatibility

### Lifecycle Manager Tests

Cover at least these cases:

1. runtime alive, no PR, active agent => `working / task_in_progress`
2. waiting input => `needs_input / awaiting_user_input`
3. idle too long without PR => `stuck`
4. PR open + CI failing => `pr.open / ci_failing`, session remains workflow-based
5. PR merged + runtime alive => session does not become terminated
6. runtime probes fail => `detecting` rather than a misleading terminal label

### Web Serialization Tests

Add tests proving:

1. existing dashboard consumers still receive `status` and `activity`
2. canonical lifecycle fields are serialized consistently
3. attention calculations still work during Stage 1 compatibility mode

## Implementation Sequence

1. Add canonical lifecycle types and metadata helpers in `core`.
2. Add lifecycle parsing and legacy synthesis helpers.
3. Update session spawn paths to write canonical lifecycle from creation time.
4. Update session reconstruction paths to consume canonical lifecycle.
5. Refactor lifecycle-manager evaluation to compute canonical session/pr/runtime truth before deriving legacy status.
6. Update serialization and dashboard session types to expose canonical lifecycle without changing the UI behavior yet.
7. Add migration tests and compatibility tests.

## Risks And Mitigations

1. Risk: dual-writing legacy `status` and canonical lifecycle can drift.
   Mitigation: centralize all lifecycle writes behind typed helpers and ban direct raw `status` mutations outside compatibility helpers.

2. Risk: merged sessions regress restore/kill behavior.
   Mitigation: explicitly test merged PR with runtime alive, merged PR with runtime dead, and manual kill after merge.

3. Risk: orchestrator sessions accidentally inherit worker-only PR semantics.
   Mitigation: persist `session.kind` from day one and gate PR-derived transitions on it.

4. Risk: old archived sessions become unreadable.
   Mitigation: keep lazy migration on read and never require `statePayload` for restore.

## Explicit Deferrals To Later Stages

These are out of scope for Stage 1:

1. agent-driven explicit acknowledgement commands such as `ao acknowledge`
2. new user notifications and UX flows for merged-but-still-running sessions
3. CI polling cadence redesign
4. review-comment file persistence and handoff automation
5. auto-recovery and resume orchestration
6. dashboard redesign for disagreement/detecting visualization
7. learning pipelines for closed PRs

## Definition Of Done For Stage 1

Stage 1 is complete when:

1. every new session persists canonical `session`, `pr`, and `runtime` truth from creation onward
2. existing sessions can still be read through legacy metadata without breakage
3. lifecycle-manager transitions write canonical reasoned state, not only a flat `status`
4. merged PRs no longer imply session termination at the canonical model layer
5. the web/API layer can expose canonical lifecycle data without breaking current consumers
6. all foundation work is covered by tests and no UI redesign or later-stage automation work has started
