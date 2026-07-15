# Design: worker-death-recovery

## Context

Post-#320, worker death ends at a `worker_died_unfinished` notification (terminal reason from #318) and a manual restart. The removed #210/#231/#243 subsystem retried blindly and amplified failures. GH #321 (operator direction, 2026-07-14) requires a full recovery loop — sense → diagnose → fix → verify-by-respawn — that never blind-respawns, never abandons, escalates through the fleet hierarchy (worker → Orc → prime), parks to the operator only for operator-authority causes, and leaves a durable trail at every stage. Landing gates (#303/#314 intake, SHA-pinned final-review + merge-park, config guard) are frozen invariants. Relevant existing seams: terminal-reason provenance + termination intents (lifecycle, #318), the terminal-death escalation in the tracker-intake observer (#320), the single attention projection (#319), daemon-owned Orc/prime supervision with wake machinery (#175/#229/#288), and pause (#212/#312).

## Goals / Non-Goals

**Goals:**

- Automatic, evidence-first diagnosis on every unfinished-work death; durable root cause before any fix.
- Cause-classed fix routing; verified respawn as the only respawn; repeat death re-enters diagnosis with history.
- Rule-driven escalation ladder using workers, the Orc, and prime; operator park only for operator-authority causes.
- Full observability via issue markers + the attention projection + Slack; spend transparency without hard caps.

**Non-Goals:**

- No change to merge authority, config-mutation guard, assignment-only intake, or the worker cap semantics.
- No general retry/circuit-breaker platform; no revival of retry counters, adoption machinery, or default-on anything.
- No autonomous mutation of operator-owned config/credentials as "remediation".
- No cross-repo scope: this recovers AO-dispatched workers in AO-managed projects.

## Decisions

1. **The daemon senses and orchestrates state; agents investigate and fix.** The recovery _state machine_ (incident record, rung, fingerprint history, cleanup deferral, respawn authorization) lives in the daemon — it is the only component that reliably outlives every session and already owns death detection, session records, and the attention projection. The _investigation and fixing_ are agent work dispatched per rung (a diagnosis session at rung 1; Orc-coordinated parallel investigation at rung 2; prime at rung 3). Alternative considered: making the Orc own the whole loop via its wake cycle — rejected because the Orc is itself a session that can die, pause interactions are subtle (#312), and incident state must survive daemon restarts anyway (so it must be persisted daemon-side regardless).
2. **Recovery incidents are first-class persisted records** (sqlite): work item, project, corpse sessions, fingerprints (cause class + failure point + terminal reason), rung, fixes tried (PR/commit refs), verification results, park state + ask. The attention projection derives recovery items from these records — no new classification paths outside the daemon (preserves #319's single-truth architecture).
3. **Evidence preservation = cleanup deferral flag on the session record.** A death with unfinished work marks the session's workspace/pane history as held-for-diagnosis; cleanup (manual `ao session cleanup` included) refuses while held unless forced. The diagnosis session gets read access to the preserved worktree and transcript. Hold releases when the incident records a root cause (or the operator forces it). Alternative — copying evidence aside — rejected: heavier, and worktrees are already on disk.
4. **Diagnosis and recovery dispatch reuse the existing spawn machinery with a distinct session kind** (`recovery`), so tmux/runtime/cgroup handling, harness selection, and audit markers come free. Recovery sessions are prompted with the incident record (issue, corpse evidence paths, prior fixes) — the exact `/address-issue`-style single-pointer dispatch discipline applies: context lives in the incident + issue, not the prompt.
5. **Fingerprint = (cause class, failure point, normalized terminal reason).** Same fingerprint after a fix ⇒ the fix failed ⇒ promote one rung. Different fingerprint ⇒ new cause ⇒ new diagnosis at the current rung (no demotion). "Unknown" cause ⇒ promote one rung immediately. Promotions and their triggers are recorded on the incident and the issue.
6. **Respawn authorization is a daemon-enforced invariant, not agent discipline:** the daemon refuses to start a replacement worker for a work item with an open incident unless the incident carries a new fix reference recorded since the last death. This makes blind respawn structurally impossible rather than policy-forbidden.
7. **Verification = the daemon watches the respawned worker past the recorded failure point** (activity progressing beyond the failure's phase/timestamp analog, plus a bounded observation window) and stamps the incident verified; a same-fingerprint death inside the window marks the fix failed and promotes. The observation is daemon-side (cheap, uses existing activity state) — no verifier agent needed for the common case.
8. **Capacity: one reserved recovery slot per project, above the normal cap but visible in fleet status.** Rationale: recovery must not starve intake (spec) and must not be starved _by_ intake (P0); a reserved single slot bounds concurrent recovery cost while guaranteeing progress. Rung-2/3 parallel investigations run within that slot budget sequentially or borrow idle normal slots when free. Alternative — recovery competes for normal slots — rejected: a saturated fleet would deadlock its own recovery.
9. **Operator visibility rides existing rails:** incident transitions emit notifications typed into the projection (recovery_started, root_cause, fix_landed, respawn_verified, rung_promoted, parked_operator_authority) — Slack and web consume the projection per #319. Pause halts recovery dispatch like any dispatch (prime exemption per #312 unaffected).

## Risks / Trade-offs

- **Diagnosis quality bounds everything.** A wrong root cause burns a cycle; mitigated by the promote-on-repeat rule (failed fixes escalate resources) and cross-family investigation at rung 2+.
- **Evidence holds consume disk** and can accumulate if diagnosis stalls; mitigated by hold-release-on-root-cause and operator force-release; watch item for long-parked incidents.
- **A reserved recovery slot is real spend** the operator sees but doesn't pre-approve per incident; accepted deliberately per #321 (transparency over caps) — the trail + pause are the brakes.
- **Systemic causes (rung 3) may require pausing intake**, trading throughput for containment; prime records the pause rationale on the incident.
- **Daemon-side verification is heuristic** ("past the failure point") for phase-less deaths; the fallback is conservative: unverifiable ⇒ treated as not-verified ⇒ next death still counts as fix-failed and promotes.
