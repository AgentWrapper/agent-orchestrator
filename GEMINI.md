<!-- GENERATED — DO NOT EDIT. Edit agent-instructions/{source,agent-overrides,system}/, then run: npm run agents (+ npm run agents:system) -->

# agent-orchestrator (ao)

Our checkout of upstream ao 0.10x — the daemon + CLI that runs the Polymath
agent fleet. **Repo:** `polymath-ventures/agent-orchestrator`.

**Ownership split (2026-07-06):**

- **Backend/daemon: vanilla rule (hard).** Never patched ad hoc — upstream-
  shaped changes only, issue-first, upstream PR opened regardless (pattern:
  per-session --model, codex-fugu adapter).
- **Web experience (frontend browser mode): OURS.** We do not wait for
  upstream to make the browser UI first-class — we build it how we want it in
  this tree and fix bugs as needed. Keep diffs upstream-shaped where cheap
  (they may take them), but upstream acceptance is never a gate. Electron
  remains upstream code — browser-mode behavior is the surface we own.

**Vanilla rule detail:** ao itself (backend) is never patched ad hoc. Upstream-shaped
changes only, each tracked as an issue here first (pattern: #1 per-session
--model, #3 codex-fugu adapter), with an upstream PR opened regardless — we
carry the delta. If a workflow need seems to require changing ao, that is a
finding, not a change: the fix belongs in the vault/nickify layer.

`oldao/` is reference-only history (abandoned 0.9x fork + retired ao-ops
daemons). Never resurrect code from it. Adoption analysis:
`docs/0.10x-adoption-report.md`.

This repo is orchestrated by ao itself — the thing builds the thing. Workers
here follow the same SDLC as every other repo.

<!--
@sx-managed: polypowers-module (nickify refreshes marked copies; remove this line to own the file)
polypowers governing module.

Assembled by polyscribe into a repo's CLAUDE.md / AGENTS.md / GEMINI.md. This is
the generic SDLC constitution: how work is tracked, the rules, the skill
catalog, and the identity contract the shared skills defer to. It is
repo-agnostic — no product, repo, or host names. Repo- or product-specific
rules (sensitive paths, deploy targets, reviewer rosters, a shared beads host)
belong in sibling fragments assembled alongside this one.

Response formatting rules are NOT here — they ship as their own vault rule
asset (nhod-response-structure). Don't duplicate them in repo fragments.
-->

## Tracking: GitHub Issues + Beads, always paired

Durable work lives in **two places on purpose**:

- The **GitHub issue** is the canonical record and the collaboration surface —
  what humans, other agents, and CI see and link to.
- The **Bead** (`bd`) mirrors it and adds what GitHub lacks: dependency edges,
  claims, ready/blocked queries, cross-agent state.

The pairing rules:

1. **New bug/feature/task → `/capture`**, which files the GitHub issue _and_
   the linked bead (`Tracks GH #N`) together. Never one without the other.
2. Issues filed outside `/capture` (bulk filings, web UI) get beads backfilled
   via `/sync-issues-to-beads`. Audit before ending a filing or queue session:
   any open bead without a `Tracks GH #…` link either gets linked or gets a
   written reason it's internal-only.
3. Raw `bd create` without a GitHub issue is reserved for explicit
   internal-only records and tool-managed follow-ups.
4. **TodoWrite/TaskCreate are in-task scratch only** — sub-steps of the bead
   you've claimed. If losing it at session end would lose information someone
   else needs, it's an issue + bead, not a todo.
5. **No beads? Degrade, don't stop.** On a repo without `.beads/`, the GitHub
   issue is the sole tracker and every skill runs in GitHub-only mode
   (claim = GH assignee, close = `Closes #N`).

## Beads backend — shared host is configuration, not code

A repo's `bd` may attach to a **shared beads host** so every agent — across
machines and accounts — sees the same live state. This is configured per repo,
never hardcoded in skills:

- The attachment is established at repo setup (`/nickify`) or by a
  session-start hook: `BEADS_DIR`, a shared Dolt server
  (`bd init --server …` / `--database …`), or an orchestrator-provisioned DB.
- When `.beads/metadata.json` marks the DB **`shared`**, durable `bd` writes
  MUST reach that shared backend. A session that can't reach it does not fake
  durability: file the GitHub half (the issue) now, and materialize the bead
  later via `/sync-issues-to-beads` from a connected host.
- Skills assume `bd` is attached to whatever the repo configured and never
  select or name a host themselves. Put the host specifics in a repo fragment,
  not in a skill.
- Similarly, skills derive the target GitHub repo from the git remote; an
  orchestrator may pin it instead via `POLYPOWERS_REPO=owner/repo`
  (`AO_PROJECT_REPO` honored as a legacy alias).

## Development Rules

Non-negotiable. Violating any of these is a bug in your behavior.

1. **TDD.** Failing test → implement → pass. Every module, endpoint, behavior
   change.
2. **Worktree per task — ALWAYS, for ALL mutating work.** Every change you
   make — bead-tracked or ad-hoc, code or docs or config — happens in a
   worktree YOU created: `git worktree add .claude/worktrees/<slug> -b
<branch> <default-branch>` (run from the main repo root, never inside
   another worktree), then install deps. Derive the default branch — don't
   assume `main`. **The shared main checkout root is read-only ground truth**:
   never commit, switch branches, or edit files there — other agents (and the
   user) rely on its state. Fetch-only sync of refs (e.g. `git fetch origin
<default>:<default>`) is fine; `git checkout <other-branch>` in the shared
   root is not.
3. **Test gates.** Fast loop per commit. Before push: full CI
   (build + format + tests), then rebase against the default branch — clean →
   push (`--force-with-lease` if rewritten); conflicted → park. Never push a
   stale stack.
4. **Explicit git adds.** `git add <file>` — never `git add .` / `-A`. Never
   disable commit signing to dodge a failure.
5. **Verify before claiming.** Nothing "works" until you exercised it — run
   it, curl it, read the logs, drive the UI.
6. **Don't self-review; merge only with authorization.** Independent review
   belongs to a different model family (see the identity contract below) —
   never to the implementer. Merging requires **explicit authorization**, which
   comes in exactly two forms: the user says so in the session, or the session
   runs in **autonomous mode** (`POLYPOWERS_AUTOMERGE=1` set by the
   orchestrator, or a queue invoked with `--merge`). In autonomous mode the
   agent merges **only after the full gate**: final-review verdict clean, CI
   green, all current-head inline review threads resolved — then immediately
   runs `/cleanup-merge` and `/deploy-verify`. A repo fragment may forbid
   autonomous merge outright, or mark **sensitive paths** — when the PR diff
   touches a marked path, autonomous mode parks the merge-ready PR for a human
   instead of merging, stating which path triggered it. Fragments may never
   grant autonomy implicitly.
7. **Specs go through the OpenSpec tooling.** Canonical `openspec/specs/` is
   read-only outside checkbox/date/gap-note edits; every requirement change is
   `/opsx:propose` → `/opsx:apply` → `/opsx:archive`, validated. No
   `--skip-specs`, no hand-made or hand-archived change dirs.
8. **Bugs found while building ship in the same PR.** Document with an
   issue+bead if useful, but the fix lands on the current branch — deferring a
   fixable bug to a follow-up ticket is prohibited. Only genuinely separate
   new-capability work becomes its own ticket. (By-design exceptions:
   `/bug-hunt` files-only; `/deploy-verify` post-merge findings.)

## The workflow — one skill per phase

Features go through OpenSpec; bugs go to the tracker; keep spec-implementation
and bug-fix sessions separate.

**Start here (routing entry points):**

- `/capture <description>` — untracked idea/bug/task → GH issue + bead +
  (features) `/opsx:propose`, then hands off to `/address-issue`. Flags:
  `--type`, `--priority`, `--quick`, `--no-ship`, `--openspec=<change>`.
- `/address-issue <id>` — existing issue/bead → dispatches by type: bug →
  `/fix-bug`; feature with spec → `/ship-feature`; feature without →
  `/opsx:propose` then `/ship-feature`; task → `/ship-quick` or `/ship-task`;
  prose-only → `/ship-hotfix`.

**Work skills (invoke directly when the shape is known):**

- `/ship-feature <id>` — phased feature work against an OpenSpec change:
  claim, worktree, `/plan-work`, per-phase TDD, opt-in `/phase-review`,
  `/final-review` loop, merge-ready report. `--no-spec` for phased non-spec
  work.
- `/ship-task <id>` — thin wrapper: `/ship-feature --no-spec`.
- `/fix-bug <id>` — reproduce-first bug flow with bounded
  investigate-fix-verify cycles, regression coverage, `/final-review`.
- `/ship-quick <id|desc>` — tiny changes; one cross-family adversarial review
  cycle. `/ship-hotfix` — prose-only; skips tests, single review pass.

**Quality and lifecycle:**

- `/bug-hunt` — parallel multi-reviewer hunt (`--high|--medium|--security`,
  `--scope`); dedupes, files survivors; fixes go through `/fix-bug`.
- `/final-review` — the pre-merge gate: independent cross-family review loop +
  optional PR-integrated reviewer, monitored to a verdict.
- `/address-issue-queue` — unattended batch runner; parks blockers, continues.
  (`/ship-feature-queue`, `/ship-task-queue`, `/fix-bug-queue` forward here.)
- `/cleanup-merge` — post-merge: close beads, archive OpenSpec, remove
  worktree, delete branch. `/deploy-verify` — deploy + verify live.
- `/sync-issues-to-beads` — GH → beads backfill (see Tracking above).

## Session habits

**Start ("what's next"):** check `bd list --status=in_progress --assignee=@me`,
`bd ready`, `bd blocked` (or open GH issues on beads-less repos). Finish
in-progress work first; recommend 1–3 unclaimed items, not the full list.

**End:** close/update beads and issues, run CI, `git pull --rebase && git
push`, report. Merge only under rule 6's authorization (user's word, or
autonomous mode with the gate satisfied) — never on your own initiative.

## The identity contract — what skills defer to your agent identity

Shared skills describe _process_ and resolve the _who/how_ from this contract:

- **Subagents** (via the `Agent` tool), by capability tier: lightweight
  (triage, monitors) → small/fast model; standard (repro, fix, verify) →
  `general-purpose`; deep reasoning (root-cause, architecture) → strong model;
  planner → `subagent_type: "Plan"`. Prefer a subagent for any substantial
  phase; you orchestrate.
- **Many-eyes review pool** — reviews exist for diversity of failure modes. The
  primary independent reviewer is a **different model family** (e.g. Codex via
  `/codex:review`), independent of the implementer. Optionally add a
  PR-integrated reviewer (fired once, polled). One reviewer is never a review.
- **Review monitor** — a lightweight subagent watches cross-cycle patterns
  (ping-pong, convergence) and calls the verdict; the orchestrator fixes.
- Repo fragments may extend this contract (name a roster, add gates); they may
  not weaken rules 6–8 above.

## Repo extensions (ao)

- **Tracking:** GitHub-only (no `.beads/` here — skills degrade
  automatically; the issue is the sole tracker).
- **Build/test gates:** backend is Go — `cd backend && go build ./... &&
go vet ./... && go test ./...`; frontend is pnpm/vite under `frontend/`.
  Upstream CI workflows are the remote gate.
- **Sensitive paths (autonomous merge PARKS):** `backend/internal/daemon/**`,
  `backend/internal/session_manager/**`, `backend/internal/lifecycle/**` —
  a bad change here takes down the whole fleet; a human reviews those merges.
- **Env:** sessions run with `POLYPOWERS_AUTOMERGE=1` and
  `POLYPOWERS_REPO=polymath-ventures/agent-orchestrator` (project config).
- **Deploy target:** ao production is the local self-hosted user daemon and
  browser-mode web surface, not an external PaaS. Deploy command:
  `ops/deploy.sh`. The script backs up `~/.local/bin/ao` to
  `~/.local/bin/ao.prev`, rebuilds the daemon binary from `backend/`, restarts
  `ao.service`, and retries readiness for about 30 seconds so the brief
  self-hosted API outage is not treated as a failure. If `frontend/` changed
  in the deployed range it restarts `ao-web.service` (whose `ExecStartPre`
  rebuilds the web bundle); if `ops/` changed it restarts
  `ao-slack-notifier.service`.

### Deploy

- **Command:** `ops/deploy.sh`
- **Verify:** `ao status` reports ready; `ao doctor` has no failures;
  `curl http://127.0.0.1:3001/api/v1/projects` returns 200; the
  pre-restart `ao session ls --json` count matches the post-restart
  re-adopted count; the tailnet web URL returns 200; and
  `ao-slack-notifier.service` is active after notifier restarts.
- **Logs:** `journalctl --user -u ao`; for web and notifier follow-ups use
  `journalctl --user -u ao-web` and
  `journalctl --user -u ao-slack-notifier`.
- **Rollback:** `ops/deploy.sh --rollback` restores `~/.local/bin/ao.prev` to
  `~/.local/bin/ao`, restarts `ao.service`, and reruns the same daemon
  readiness/API/session/web checks.
- **Pool:** deploy-only work runs on the cheap haiku pool:
  `ao spawn --model haiku`.

### Session self-naming

For ao-hosted sessions, keep your session's names in sync with the current work
item so the dashboard and the Claude Code session list read like a live work
log. Workers set both surfaces on claiming a work item and again on every queue
item transition. Your ao session id is
`SID="${AO_SESSION_ID:-$(tmux display-message -p '#S')}"` (ao injects the env
var; tmux is the fallback). Derive `<slug>` from the issue title: lowercase
`[a-z0-9-]` only, everything else stripped — never interpolate a raw title into
a shell command.

- **ao display name:** `ao session rename "$SID" "#<issue> <slug>"` — 20-char
  cap (enforced at spawn/API; the CLI rename path currently skips the
  check, so never rely on a longer name sticking). Visible in the
  dashboard and `ao session get`; the `ao session ls` table doesn't show
  it yet (gap tracked in GH #28).
- **Claude Code session title** (claude-code harness only):
  `tmux send-keys -t "$SID" -l '/rename #<issue> <short-desc>'` then
  `tmux send-keys -t "$SID" Enter` — verified safe mid-turn. This title is
  intentionally uncapped and should use the descriptive work-item text, not
  only ao's 20-char display name. Other harnesses have no Claude Code title
  surface; ao display name is their only naming surface and must not be
  faked.
- **Never rename the tmux session itself** — its name IS the ao session id and
  ao addresses the pane by it.

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

## Agent identity (agy)

Defaults per the polypowers identity contract. Deep-reasoning and review
subagent phases may be delegated to `codex-fugu` (installed on this account)
per the mix policy in the orchestrator section.
