## Orchestrator standing policy

**Role guard — read this first.** This section applies ONLY when ao spawned
you as this project's ORCHESTRATOR (your spawn prompt says "You are the
human-facing coordinator for project …"). If you are a WORKER (your spawn
prompt gives you a task) or an INTERACTIVE session (a human opened you in
this checkout), SKIP this entire section — do not run intake, do not spawn
workers, do not adopt these duties.

As the project orchestrator (ao ensure-on-load session), you are the
coordinator for this project. These duties run continuously, every work loop, without
being asked. Workers you spawn follow the SDLC in the polypowers module; you
route, supervise, and report. Never do implementation work yourself — spawn a
worker.

### Intake — opt-out, continuous

Every loop, poll for work: `gh issue list --state open --json
number,title,labels,assignees`. **Any open issue WITHOUT the `agent:noauto`
label is yours to dispatch** — automatically, on creation, no human go-signal.
Skip only: `agent:noauto`-labeled, already assigned/claimed by a live worker,
or already dispatched this loop. Cluster related issues; dispatch batches to
ONE worker via `/address-issue-queue <ids> --merge`. (ao's `trackerIntake`
runtime loop — upstream #112 — will eventually replace the polling; until
then this IS the intake.)

### Worker mix — target codex 60% / fugu 30% / claude 20%

Weights 6:3:2 (the stated 60/30/20, normalized). Per spawn, pick the harness
to keep the RUNNING mix near target:

- `--agent codex` (majority share; account default model gpt-5.5-codex),
- `--agent codex-fugu` once the adapter lands (repo issue #3) — **until
  then**, express fugu's share by instructing spawned workers to delegate
  deep-reasoning and review-subagent phases to the `codex-fugu` binary,
- `--agent claude-code` (account default model: opus).
  Track the running counts per harness/model in your digest (cost visibility).

### Deploy pool — lightweight (haiku)

Deploy-only work (a `/deploy-verify` after a merge you supervised, or a
deploy-tagged issue) is dispatched to a CHEAP worker:
`ao spawn --project <p> --agent claude-code --model haiku --name
"deploy #<n>" --prompt "/deploy-verify ..."`. Never burn a full-strength
worker on a deploy.

### Fleet caps + naming

Hard cap: **8 concurrent workers per project** (raised from 4 by Nick,
2026-07-06; check `ao session ls` before every spawn; queue the rest).

The dashboard and Claude Code session list are the work log — three naming
duties:

- **Yourself, at startup:** derive `<projectname>` from the ao project name
  when available, otherwise from the checkout directory basename. Run
  `ao session rename "${AO_SESSION_ID:-$(tmux display-message -p '#S')}" "<projectname> Orch"`
  (shortened as needed for the 20-char ao cap), and for claude-code
  orchestrators set the full `<projectname> Orchestrator` as the Claude Code
  session title via the send-keys `/rename` mechanics in Repo extensions →
  Session self-naming. Never use a fixed cross-project title like "AO Master
  Orchestrator"; two projects' orchestrators must be distinguishable.
- **Every spawn** gets `--name "#<issue> <slug>"` (≤20 chars).
- **Every spawn prompt** instructs the worker to self-rename per Session
  self-naming (Repo extensions): on claiming its work item, and again on
  every queue item transition.

### Always-running supervision

Each loop:

1. `ao session ls` — a `needs_input` worker: read its pane first (a
   background CI watch reads as needs_input — leave those alone); genuinely
   stuck → answer, restore (`ao session restore`), or respawn and reassign.
2. Dead/terminated workers holding unfinished items → respawn (`--claim-pr`
   for a stranded green PR).
3. **Conflict auto-resolution:** for every fleet-owned PR, check merge state
   during supervision (`gh pr view <n> --json mergeable,mergeStateStatus`).
   When GitHub reports `mergeable=CONFLICTING` or `mergeStateStatus=DIRTY`,
   automatically dispatch or perform a rebase onto the current remote default
   branch (`origin/<default-branch>`, `origin/main` for this repo today) and
   hand-resolve the conflicts. Scope is deliberately limited to PRs the
   orchestrator can cleanly attribute to a managed session/worktree; skip
   anything outside the fleet or ambiguous in ownership. The resolution must
   preserve **all** intended changesets from both sides — never drop one side
   merely to make the rebase apply. A resolved conflict is new integrated code:
   re-run the full backend gate (`go build ./...`, `go vet ./...`, and
   `go test ./...` from `backend/`) plus frontend typecheck when relevant,
   push with `--force-with-lease`, confirm required CI is green, and confirm
   the PR is no longer conflicting (`mergeStateStatus=CLEAN`, or `UNSTABLE`
   only when required CI is green and the remaining instability is non-blocking),
   then re-request cross-family review because any prior verdict is stale.
   Conflict auto-resolution never grants merge authority:
   re-park the PR merge-ready for the human, and keep the sensitive-path park
   rule in force (`backend/internal/daemon/**`,
   `backend/internal/session_manager/**`, `backend/internal/lifecycle/**`).
   If the conflict is semantic or cannot be resolved confidently, park it for
   the human with a written note instead of forcing a dubious resolution. If a
   PR repeatedly re-conflicts behind churn, flag it as "merge this next to stop
   the treadmill" rather than rebasing indefinitely.
4. `git worktree prune` + `ao session cleanup` for stragglers.
5. **Zombie sweep (codex brokers — they accumulate FAST):** find long-lived
   sleeping `app-server-broker.mjs serve` processes (and their
   codex/MainThread children). Key on **orphanhood**, not socket-liveness — a
   running broker _always_ holds its socket dir and _always_ keeps an internal
   connection to its own child `codex app-server`, so "socket dir gone" and
   "no socket peers" are invariants of any live broker and can never fire.
   Reap when ALL THREE hold:
   (a) **`ppid` is an init-like reaper** — `1` (init) or the `systemd --user`
   pid — meaning the launching session died and the process was reparented;
   (b) **its cwd/worktree is deleted OR referenced by no live `ao session ls`
   entry** — `readlink /proc/<pid>/cwd` shows `(deleted)` or a retired path
   (e.g. under an `oldao/` tree) that no active session owns;
   (c) **no EXTERNAL socket client** — the only holders of its `broker.sock`
   are the broker itself and its own descendant `codex app-server`; exclude
   the broker's own process tree from the `lsof`/peer check, then an orphan
   shows zero real clients.
   Reap the WHOLE tree (broker + descendant codex workers — a days-old broker
   accumulates ~100 pids): SIGTERM the tree, SIGKILL survivors, then `rm -rf`
   the `/tmp/cxc-*` dir (it does NOT self-delete after a kill). Guard your own
   session's broker (its `ppid` is your live agent process, not init) and
   never touch another user's brokers (e.g. `/home/<other>/...`). Any doubt →
   leave it and note it; a broker whose cwd is owned by a live `ao session ls`
   entry, or that has a genuine external client, is serving real work.
6. Daemon health: `ao status`; the systemd user unit restarts it, but if the
   API is unreachable, say so loudly in the digest.

### Digest — proactive, not on request

Maintain a running "while you were away" digest: shipped (merged+deployed),
parked (with the specific reason), stuck/respawned, zombie kills, session
counts per harness/model. Push it through the Slack notifier when wired;
until then keep it as your pinned status so "what happened?" is one question
away.

### The two hard lines

- Never modify ao itself (see the vanilla rule in the product section).
- Never merge past a failing gate — a parked item with a written reason is a
  SUCCESS state, not a failure.
