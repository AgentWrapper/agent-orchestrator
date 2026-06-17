# Feedback Routing and Follow-up Design (Formalized Pipeline v2)

## Status

This is a design formalization update after PR #403 discussion.

- PR #403 remains implementation-scoped to feedback contracts/validation/storage.
- This document defines the next-step architecture for report -> issue -> agent-session -> PR.
- This update is design-only (no new runtime behavior introduced by this document itself).

## Scope and Decisions

1. Feedback routing mode is exclusive: `local` OR `scm` (never both).
2. Privacy guardrails are intentionally deferred to a dedicated follow-up PR.
3. Side effects stay deterministic in orchestrator control code.
4. Optional subagent/skill can recommend decisions, but cannot execute SCM mutations.

## Formal Pipeline

1. **Report capture**: validate feedback tool payload and compute dedupe key.
2. **Issue resolution**: find existing issue by markers; create or comment/update.
3. **Follow-up planning**: decide issue-only vs issue+PR vs issue+fork from policy + context.
4. **Execution**:
   - direct SCM action path (issue/fork/PR metadata operations), or
   - agent-session path (spawn session to produce code changes).
5. **Linking and journal update**: persist outcome state and references.

## 1) Trigger Conditions

The pipeline is triggered when all of the following are true:

1. A valid `bug_report` or `improvement_suggestion` is captured.
2. Routing mode is `scm` for the active project.
3. Confidence threshold is met for that report type.
4. Governance policy allows target/fork mutation for this actor/project.

Decision triggers for follow-up action:

1. `self_blocking_now = false` -> issue-only.
2. `self_blocking_now = true` + ready branch/commits -> issue + PR link/create path.
3. `self_blocking_now = true` + no writable upstream path -> issue + fork path.
4. `self_blocking_now = true` + no code yet -> spawn agent-session path.

## 2) Session Spawning Contract

When follow-up requires code (not just metadata operations), orchestrator spawns a worker session.

### Inputs

1. `reportId`, `dedupeKey`, `issueUrl` (resolved in prior stage).
2. `targetRepo` and `targetBranchPolicy`.
3. `followUpIntent` (`fix_now`, `draft_solution`, etc.).
4. Optional `forkContext` (fork owner/repo/branch if fork path selected).

### Preconditions

1. Issue is already resolved/created and has stable URL.
2. Spawn policy permits automatic coding session for this project.
3. Repo target has been selected (upstream or fork).

### Required outputs

1. Session ID.
2. Branch reference used by the session.
3. Optional PR URL if created by orchestrator or agent flow.
4. Terminal state recorded in publish journal (`done`, `failed`, `cancelled`).

## 3) Target Selection (Upstream vs Fork)

Target selection is deterministic and policy-driven:

1. If upstream write is allowed and policy is `upstream`, target upstream.
2. If upstream write is blocked and policy allows fork, target fork.
3. If fork exists and policy says reuse, reuse existing fork.
4. If fork missing and policy allows creation, create fork and continue.
5. If neither upstream nor fork is allowed, downgrade to issue-only and mark follow-up blocked.

Example policy knobs:

```yaml
feedback:
  mode: scm
  scm:
    provider: github
    targetRepo: auto # auto | upstream | fork
    forkStrategy: upstream # upstream | fork | skip
```

## Consent Gates (Default Policy)

For projects other than AO dogfooding, these are hard defaults:

1. Explicit human consent is required before creating a fork.
2. Explicit human consent is required before creating a PR.
3. Explicit human consent is required before switching execution target between upstream and fork.
4. No silent infrastructure flip is allowed by default.

Override model:

1. Project-level override is optional and must be explicitly enabled by project owner.
2. Overrides are scoped per operation (`createFork`, `createPR`, `switchTarget`) and must be auditable.
3. Without explicit owner override, consent gate defaults remain enforced.

## 4) PR Creation/Linking Requirements

For any PR action, orchestrator enforces:

1. Issue URL exists and is referenced in PR body.
2. Dedupe marker is present in issue/PR metadata for traceability.
3. If PR already exists for dedupe key + branch, link existing PR rather than creating duplicate.
4. If fork path is used, PR must include fork repo/branch references.
5. Issue must be updated with final PR URL and state transitions.

Canonical markers in issue/PR body:

1. `<!-- ao:feedback-tool:<tool> -->`
2. `<!-- ao:dedupe-key:<dedupeKey> -->`
3. `<!-- ao:session:<sessionId> -->` (if session spawned)

## 5) Idempotency and Retry Semantics

Idempotency keys:

1. `dedupeKey` for issue-level identity.
2. `operationKey` for each side effect (create issue, create fork, create PR, add comment).

Retry semantics:

1. Retry only retryable transport/server failures.
2. Exponential backoff with bounded attempts.
3. Non-retryable errors transition to terminal failure with actionable reason.

At-least-once safety:

1. Replays must first check existing issue/fork/PR using markers before creating anything.
2. Side effects must be written as "find-or-create" operations.

Journal semantics:

1. Minimal journal record per report in `scm` mode:
   - `dedupeKey`, `stage`, `status`, `issueUrl`, `prUrl`, `targetRepo`, `lastError`.
2. Journal drives recovery and prevents duplicate creation on restart.

Plain-language journal behavior:

1. Think of the journal as a progress log for each report.
2. Before each mutation attempt, orchestrator writes what it is about to do.
3. After attempt completion, orchestrator updates the same record with success/failure and links.
4. On retry, orchestrator keeps the same identity keys and increments attempt metadata instead of creating a parallel track.
5. Consent decisions (approved/denied) are written so operators can audit why a path was or was not taken.

Minimal journal schema example:

```json
{
  "reportId": "fr_01HT2H2F3H4A5",
  "dedupeKey": "f4d7dbe5b0f8...",
  "mode": "scm",
  "stage": "create_pr",
  "status": "failed",
  "attempt": 2,
  "operationKey": "create_pr:f4d7dbe5b0f8:upstream",
  "targetRepo": "ComposioHQ/agent-orchestrator",
  "issueUrl": "https://github.com/ComposioHQ/agent-orchestrator/issues/399",
  "prUrl": null,
  "consent": {
    "createFork": "approved",
    "createPR": "approved",
    "switchTarget": "not-needed"
  },
  "lastError": {
    "code": "FORBIDDEN",
    "message": "PR creation blocked by repository policy"
  },
  "updatedAt": "2026-03-10T15:45:00Z"
}
```

## 6) Governance Hooks Per Fork Owner Policy

Governance is evaluated before each mutating operation.

Policy hooks:

1. `canCreateIssue(project, actor, targetRepo)`
2. `canCreateFork(project, actor, forkOwner)`
3. `canCreatePR(project, actor, targetRepo, sourceRepo)`
4. `canSpawnSession(project, actor, followUpIntent)`

Per-fork-owner controls:

1. Allowed fork owner list / deny list.
2. Require human approval for fork creation under selected owners.
3. Optional restriction to pre-registered fork remotes.

If governance denies an operation:

1. Do not attempt mutation.
2. Downgrade path if possible (e.g., issue-only).
3. Record explicit denial reason in journal.

## Responsibilities: Orchestrator vs Subagent Skill

### Orchestrator (required)

1. Owns all SCM side effects.
2. Owns retries, idempotency checks, and journal updates.
3. Enforces governance hooks and policy fallbacks.

### Optional ephemeral subagent skill

1. Produces recommendation payload only:
   - `self_blocking_now`
   - `recommended_action`
   - `reason`
   - `confidence`
2. Must return strict JSON schema.
3. If invalid/low confidence, orchestrator falls back to deterministic rules.

## Proposed Components

1. `FeedbackRouter`: local vs scm dispatch.
2. `IssueResolver`: dedupe-aware issue create/update/comment.
3. `FollowUpPlanner`: issue-only vs issue+PR vs issue+fork decision.
4. `TargetResolver`: upstream/fork target determination.
5. `FollowUpExecutor`: direct SCM or agent-session execution path.
6. `FeedbackPublishJournal`: status, links, retries, recovery metadata.

## Config Proposal (Extended)

```yaml
feedback:
  mode: scm # local | scm
  scm:
    provider: github # github | gitlab
    targetRepo: auto # auto | upstream | fork
    forkStrategy: upstream # upstream | fork | skip
    prReference: if_present # required | if_present | never
    minConfidence:
      bug_report: 0.6
      improvement_suggestion: 0.75
  followUp:
    enableAgentSession: true
    requireIssueBeforeSession: true
  consent:
    defaultPolicy: require_human_for_major_mutations # hard default outside AO dogfooding
    requireFor:
      createFork: true
      createPR: true
      switchTarget: true
    projectOverride:
      enabled: false # must be explicitly enabled by project owner
  governance:
    allowedForkOwners: ["<org-or-user>"]
    requireApprovalForForkCreation: true
```

## Testing Strategy

### Unit tests

1. Trigger matrix and planner decision table.
2. Target resolver behavior for upstream/fork permutations.
3. Marker generation and dedupe matching.
4. Governance hook allow/deny behavior.
5. Retry classifier and idempotent replay logic.

### Integration tests

1. Issue create/update on GitHub and GitLab.
2. Fork ensure/reuse path under different policies.
3. PR create/link and issue back-link updates.
4. Agent-session contract handoff and journal transitions.

### End-to-end tests

1. report -> issue-only path.
2. report -> issue -> session -> PR path.
3. report -> issue -> fork -> session -> PR-from-fork path.

## Rollout

1. Ship with `mode: local` default and `scm` opt-in.
2. Enable on a small set of projects first.
3. Track duplicate suppression rate, retry outcomes, and failure classes.
4. Expand once deterministic behavior and governance policy outcomes are stable.

## Summary

The formal pipeline is now explicit: report -> issue -> (optional) agent-session -> PR, with fork-aware execution and governance hooks. Orchestrator remains the only executor of side effects; agentic skill remains advisory.
