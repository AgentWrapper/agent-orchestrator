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

1. **New bug/feature/task → `/capture`**, which files the GitHub issue *and*
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
3. **Test gates.** Fast loop per commit. Before push: full CI (build + format
   + tests), then rebase against the default branch — clean → push
   (`--force-with-lease` if rewritten); conflicted → park. Never push a stale
   stack.
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

Shared skills describe *process* and resolve the *who/how* from this contract:

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

Hard cap: **4 concurrent workers per project** (check `ao session ls` before
every spawn; queue the rest). Every spawn gets `--name "#<issue> <slug>"` so
the dashboard reads like a work log.

### Always-running supervision

Each loop:
1. `ao session ls` — a `needs_input` worker: read its pane first (a
   background CI watch reads as needs_input — leave those alone); genuinely
   stuck → answer, restore (`ao session restore`), or respawn and reassign.
2. Dead/terminated workers holding unfinished items → respawn (`--claim-pr`
   for a stranded green PR).
3. `git worktree prune` + `ao session cleanup` for stragglers.
4. **Zombie sweep (codex brokers — they accumulate FAST):** find long-lived
   sleeping `app-server-broker.mjs serve` processes (and their
   codex/MainThread children). For EACH, double-check it is truly orphaned —
   ALL THREE must hold before killing:
   (a) its `/tmp/cxc-*` socket dir no longer exists,
   (b) its cwd/worktree has been deleted,
   (c) no live tmux session or `ao session ls` entry references it and
       `lsof -p <pid>` shows no live socket peers.
   Any doubt → leave it and note it. Never kill a broker whose socket dir
   exists or whose parent session is alive.
5. Daemon health: `ao status`; the systemd user unit restarts it, but if the
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
