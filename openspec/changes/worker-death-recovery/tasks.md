# Tasks: worker-death-recovery

## 1. Incident foundation (daemon state machine)

- [ ] 1.1 Persisted recovery-incident record (sqlite migration + store): work item, project, corpse sessions, fingerprint history, rung, fixes tried, verification results, park state/ask
- [ ] 1.2 Death-with-unfinished-work detector wired to the lifecycle/termination path (#318 seams): opens or updates an incident, computes the death fingerprint
- [ ] 1.3 Evidence hold: held-for-diagnosis flag on the session; cleanup paths (auto + `ao session cleanup`) refuse while held unless forced; release on recorded root cause
- [ ] 1.4 Incident-derived notification types + attention projection integration (recovery_started, root_cause, fix_landed, respawn_verified, rung_promoted, parked_operator_authority) riding the #319 single projection

## 2. Diagnosis dispatch (rung 1)

- [ ] 2.1 `recovery` session kind reusing spawn machinery; reserved one-per-project recovery slot with fleet-status visibility
- [ ] 2.2 Diagnosis prompt/contract: incident pointer + preserved-evidence paths; output = root-cause report (cause class, evidence, fix direction) posted to the issue and recorded on the incident
- [ ] 2.3 Cause-class routing: code → standard gated fix flow; config/env within agent authority → scoped remediation; operator-authority → park with specific ask; unknown → promote
- [ ] 2.4 Pause integration: recovery dispatch halts under project pause (prime exemption per #312 untouched)

## 3. Respawn authorization + verification

- [ ] 3.1 Daemon-enforced invariant: no replacement worker for a work item with an open incident unless a new fix reference exists since the last death
- [ ] 3.2 Verified respawn: observe the respawned worker past the recorded failure point within a bounded window; stamp verified or mark fix-failed on same-fingerprint death
- [ ] 3.3 Repeat-death re-entry: fix-failed promotes one rung and re-enters diagnosis carrying full history; different fingerprint opens a fresh diagnosis at the current rung

## 4. Escalation ladder (rungs 2–3)

- [ ] 4.1 Rule-driven promotion engine on the incident (fix-failed +1, unknown +1, systemic → prime) with durable trigger records
- [ ] 4.2 Rung 2: Orc-coordinated multi-angle investigation contract (parallel hypotheses, ≥1 cross-family investigator) via orchestrator policy + wake machinery
- [ ] 4.3 Rung 3: prime engagement contract for systemic causes (cross-item fingerprint correlation, authority to pause affected intake, rationale recorded)
- [ ] 4.4 Operator-authority park: shielding affected work items from re-dispatch while parked; unpark on operator action

## 5. Observability + operator surfaces

- [ ] 5.1 Issue audit markers for every stage transition (marker-anchored, reconstructable from the issue alone)
- [ ] 5.2 Per-incident spend/attempt trail (attempts, rungs, sessions, fixes) visible from the issue and `ao` CLI; active incidents in the attention projection
- [ ] 5.3 Slack rendering of recovery states via the existing notifier/projection path (no new classification)

## 6. Hardening + docs

- [ ] 6.1 E2E: injected worker death → diagnosis → fix (stub cause) → verified respawn → incident closed, all markers present
- [ ] 6.2 E2E: fix-failed path → rung promotion → no same-fix respawn (daemon refuses), history carried
- [ ] 6.3 Invariant tests: landing gates, intake, cap, config guard untouched by recovery paths
- [ ] 6.4 Update orchestrator-policy.md / prime-orchestrator-policy.md + agent-instructions for the recovery responsibilities (drift + prettier gates)
- [ ] 6.5 Runbook: operator view of an incident, halt (pause), force-release evidence, unpark
