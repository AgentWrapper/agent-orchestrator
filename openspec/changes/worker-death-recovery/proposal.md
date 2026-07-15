# Proposal: worker-death-recovery

## Why

A dead worker is the failure of AO's fundamental unit of work — the product exists to run workers to completion, so an unrecovered death halts everything that matters (P0 by definition, GH #321). Today AO senses a death and records a truthful terminal reason (#318) but stops at a notification and a manual restart (post-#320 state); the removed pre-#320 alternative (#210/#231/#243) blind-respawned without diagnosis, fix, or verification and amplified failures instead of curing them. Neither is acceptable: the operator directed on 2026-07-14 that recovery through verification is core product — autonomy in diagnose/fix/verify was never the July runaway's defect; unbounded autonomy in landing (merge/config/dispatch) was, and those gates stay.

## What Changes

- New recovery loop triggered by any worker death with unfinished work: **sense → diagnose → fix → verify-by-respawn**, with durable operator-visible markers at every stage.
- Diagnosis runs against the corpse **before** workspace/session cleanup destroys evidence; root cause posts to the work item's issue, the attention projection, and Slack.
- Fixes route by cause class: code causes go through the normal worktree/TDD/PR flow (all existing merge gates unchanged); config/environment causes get scoped remediation or park with a specific operator ask naming the authority needed — never a shrug.
- Respawn is authorized **only** by a new fix; the respawned worker is observed past the original failure point and that verification is recorded. There is never a respawn without a new fix.
- A repeat death is treated as new evidence and re-enters diagnosis carrying the failed-fix history; recovery never abandons the problem. Unresolved cycles escalate within the fleet with increasing investigative intensity: worker-level diagnosis → Orc-coordinated multi-angle investigation → prime-level engagement for systemic causes.
- The operator is the escalation target only for causes that structurally require operator authority (credentials, billing/caps, operator-owned config), and can halt the loop at any time via the existing pause control.
- **BREAKING** (policy, not API): supersedes the #313 harmony plan's "require an explicit operator restart" line, per operator direction recorded on #321.

## Capabilities

### New Capabilities

- `worker-death-recovery`: the end-to-end recovery loop — death sensing hook-in, evidence preservation, diagnosis pass, cause-classed fix routing, verified respawn, repeat-death re-entry, and the no-respawn-without-new-fix invariant.
- `recovery-escalation`: the fleet-hierarchy escalation ladder (worker → Orc → prime), its promotion triggers, the operator-authority park conditions, and spend/attempt transparency.

### Modified Capabilities

<!-- none: openspec/specs/ is currently empty; no canonical spec requirements exist to modify -->

## Impact

- Backend daemon: lifecycle/termination path (consumes #318 terminal reasons and the termination-intent machinery), session manager (respawn authorization), tracker-intake observer (the terminal-death escalation from #320 becomes the loop's entry point), notification/attention projection (new recovery-stage subjects ride the existing single projection from #319).
- Orc and prime policy surfaces: `.claude/orchestrator-policy.md` / `.claude/prime-orchestrator-policy.md` and the daemon wake machinery gain recovery responsibilities per the escalation ladder.
- Workspace cleanup: unexplained deaths defer cleanup for evidence preservation (interacts with `ao session cleanup` and workspace teardown).
- Invariants that must NOT change: assignment-only intake, worker cap, zero blind retries, merge authority gates (SHA-pinned final-review + merge-park), config-mutation guard (#318). Recovery capacity accounting is a design decision (reserved lane vs normal slots).
- Tracking: GH #321 is the canonical issue; open decisions listed there resolve in design.md.
