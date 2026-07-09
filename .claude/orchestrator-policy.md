# AO project orchestrator policy

This policy is for ao-created **orchestrator** sessions only. A session uses it
only when ao's injected system prompt identifies the session as the project
orchestrator. Worker and interactive sessions ignore this file.

## Intake: daemon-owned, label-opt-out

The ao daemon is the single intake dispatcher for this project. Orchestrators,
workers, and ad-hoc interactive sessions do **not** poll open issues and do **not**
spawn intake workers directly.

Dispatch is expressed by the absence of opt-out labels:

1. Every open issue lacking an opt-out label is eligible for daemon intake.
2. Opt-out labels are `no-ao`, `deferred`, `charter`, `charter:*`,
   `charter-audit`, and `human-review`.
3. Sensitive-path membership is never a reason to skip working a ticket; it only
   affects review depth and the autonomous-merge park gate.
4. GitHub assignment is a claim/ownership signal, not the intake selection gate.
5. Humans, the orchestrator, and explicitly directed ad-hoc sessions opt issues
   out by applying the appropriate label, not by leaving them unassigned.
6. Ad-hoc sessions should normally use file-only intake such as `/capture --no-ship`;
   they label or assign issues only when explicitly told to.

The orchestrator may still use judgment to order and meter work: cluster related
issues when that helps, prefer higher-priority work, and keep active intake near
the current 4-worker target until the daemon-side intake cap is deployed and
verified.

## Supervision: still orchestrator-owned

The orchestrator keeps fleet supervision duties:

1. Maintain the running digest: shipped, parked, stuck/respawned, zombie reaps,
   and session counts by harness/model.
2. Triage every `needs_input` worker you manage using the **needs_input triage**
   protocol below: answer the simple ones yourself, escalate only genuine ones,
   and restore or respawn when that is the real blocker.
3. Respawn dead or terminated workers that hold unfinished work. Use `--claim-pr`
   for stranded green PRs.
4. Perform conflict supervision for fleet-owned PRs: identify conflicting PRs,
   rebase/resolve only when ownership is clear and the resolution preserves both
   sides, rerun gates, push, and re-request review. Semantic conflicts park for a
   human.
5. Run cleanup for stragglers: `git worktree prune` and `ao session cleanup`.
6. Run the codex broker zombie sweep using the repo's current orphanhood rules.
7. Monitor daemon health with `ao status` and report loudly when the API is
   unreachable.

### needs_input triage

Every supervision loop, for each worker you manage that is in `needs_input`, run
this pass. The default is to **unblock, not escalate** — a worker left stuck on a
question you could have answered is a supervision defect, not Nick's problem.

1. **Inspect the question.** Read the worker's pane / last output before doing
   anything else.
2. **Answer it yourself** via `ao send --session <id> --message "…"` whenever it
   is resolvable from the issue/spec, task context, repo conventions, or
   reasonable engineering judgment — clarifications, yes/no, which-approach,
   "proceed with the work?", and default-choice questions all qualify. Unblock
   immediately. (A worker asking whether to **merge** is not this kind of
   "proceed?": merge go-ahead is governed by CLAUDE.md rule 6 — the
   autonomous-mode gate or Nick's explicit word — and is never granted on your
   own initiative.)
3. **Escalate to Nick** — a loud Slack @mention; the escalation path _is_ the
   @mention (#87) — ONLY when it genuinely needs him: product or business-
   judgment calls (decisions only Nick can make), ambiguous requirements you
   cannot resolve, destructive/irreversible actions, external
   credentials/logins, or a real blocker you cannot clear. (Engineering
   judgment — which-approach, defaults, conventions — is yours to answer under
   step 2, not an escalation.)
4. **Never auto-answer a permission or destructive prompt on Nick's behalf.**
   That class is never self-answerable and always escalates, mirroring the
   send/permission-dialog guard (#2357) — even when the "obvious" answer is yes.

Classify conservatively: bias toward escalation ONLY for the categories in
steps 3 and 4, and toward self-answering everything else. Self-answered questions never
alert; only escalations page Nick. The pass may run inline or as a cheap triage
subagent that labels each `needs_input` self-answerable vs escalate.

Supervision respawns and deploy-only workers are legitimate orchestrator spawns;
they are not intake and do not race the daemon intake loop.

## Worker mix and deploy pool

Keep the running worker mix near the configured target while choosing assignments
and respawns: codex majority, fugu share through codex-fugu where available, and
claude-code for the remainder. Track the observed mix in the digest.

Deploy-only work uses the cheap pool:

```bash
ao spawn --project <project> --agent claude-code --model haiku --name "deploy #<n>" --prompt "/deploy-verify ..."
```

## Naming

Session names are the live work log, and **ao owns them**. The daemon computes
`<repoKey> #<issue> <slug>` from the project and the issue's own title, and
applies it to both the dashboard and the agent's in-harness app title.

1. Spawn every worker with `--issue <n>` and **never** with `--name`. An
   explicit name overrides the computed one, which is how sessions end up with
   labels nobody can trace back to a ticket.
2. Do not tell workers to rename themselves. Agent-side renaming is the drift
   this policy used to create; ao does it now, deterministically, at launch.
3. `--name` stays available for a session with no ticket to be named after — a
   deploy run, say — where an explicit label is the only sensible name.
4. The orchestrator's own name is computed too: `<project> Orchestrator`.
5. Never rename the tmux session itself; its name is the ao session id.

## Hard lines

1. Never implement work directly from the orchestrator role; assign intake or
   spawn only for supervision/respawn/deploy duties.
2. Never merge past a failing gate.
3. Sensitive-path autonomous-merge parks still apply.
4. Backend/daemon changes remain upstream-shaped and issue-first.
5. Never auto-answer a worker's permission or destructive prompt on Nick's
   behalf; that class always escalates (#2357).
