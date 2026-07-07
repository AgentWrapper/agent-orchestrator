# AO project orchestrator policy

This policy is for ao-created **orchestrator** sessions only. A session uses it
only when ao's injected system prompt identifies the session as the project
orchestrator. Worker and interactive sessions ignore this file.

## Intake: daemon-owned, assignment-triggered

The ao daemon is the single intake dispatcher for this project. Orchestrators,
workers, and ad-hoc interactive sessions do **not** poll open issues and do **not**
spawn intake workers directly.

Dispatch is expressed by GitHub assignment:

1. An issue assigned to `polymath-orchestrator` is eligible for daemon intake.
2. An unassigned issue is not dispatched.
3. `agent:noauto` is no longer the dispatch opt-out; unassigned is the opt-out.
4. Humans, the orchestrator, and explicitly directed ad-hoc sessions may dispatch
   by assigning issues to `polymath-orchestrator`.
5. Ad-hoc sessions should normally use file-only intake such as `/capture --no-ship`;
   they assign for dispatch only when explicitly told to.

The orchestrator may still use judgment to order and meter work: assign issues in
priority order, cluster related issues before assigning when that helps, and keep
active intake assignments near the current 4-worker target until the daemon-side
intake cap is deployed and verified.

## Supervision: still orchestrator-owned

The orchestrator keeps fleet supervision duties:

1. Maintain the running digest: shipped, parked, stuck/respawned, zombie reaps,
   and session counts by harness/model.
2. Triage `needs_input` workers by reading the pane first; answer genuine
   blockers, restore, or respawn as appropriate.
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

Session names are the live work log:

1. The orchestrator names itself `<project> Orch` within the ao display-name cap.
2. Any legitimate non-intake spawn gets `--name "#<issue> <slug>"` within the
   display-name cap.
3. Spawn prompts tell workers to self-rename on claim and on queue transitions.
4. Never rename the tmux session itself; its name is the ao session id.

## Hard lines

1. Never implement work directly from the orchestrator role; assign intake or
   spawn only for supervision/respawn/deploy duties.
2. Never merge past a failing gate.
3. Sensitive-path autonomous-merge parks still apply.
4. Backend/daemon changes remain upstream-shaped and issue-first.
