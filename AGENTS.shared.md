<!-- GENERATED — DO NOT EDIT. Edit agent-instructions/{source,agent-overrides,system}/, then rebuild: bash scripts/polyscribe.sh (system scope adds --system) -->

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
   agent merges **only after the full gate**: a `final-review` commit status
   with `state=success` on the current PR head SHA and description
   `verdict=clean reviewer_family=<family> head=<full-head-sha>`, CI green,
   and all current-head inline review threads resolved — then immediately runs
   `/cleanup-merge` and `/deploy-verify`. A stale `final-review` status from a
   previous head SHA, a verbal "merge-ready" claim, a PR comment, or ao's native
   `/sessions/{id}/reviews` state does **not** count as the final-review gate.
   A repo fragment may forbid autonomous merge outright, or mark **sensitive
   paths** — when the PR diff touches a marked path, autonomous mode parks the
   merge-ready PR for a human instead of merging, stating which path triggered
   it. Fragments may never grant autonomy implicitly.
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

**Selection rule:** work every open issue lacking an opt-out label (`no-ao`,
`deferred`, `charter`, `charter:*`, `charter-audit`, `human-review`);
sensitive-path membership is never a reason to skip working a ticket.

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
  optional PR-integrated reviewer, monitored to a verdict, then writes the
  authoritative `final-review` commit status on the exact reviewed head SHA.
  The clean status is the only machine-readable final-review verdict the merge
  gate may consume.
- `/address-issue-queue` — unattended batch runner; parks blockers, continues.
  (`/ship-feature-queue`, `/ship-task-queue`, `/fix-bug-queue` forward here.)
- `/cleanup-merge` — post-merge: close beads, archive OpenSpec, remove
  worktree, delete branch. `/deploy-verify` — deploy + verify live.
- `/sync-issues-to-beads` — GH → beads backfill (see Tracking above).

## Final-review status contract

`/final-review` emits its verdict as a GitHub commit status on the reviewed head
SHA, using context `final-review`. A clean review writes `state=success`; a
parked or non-clean review writes `state=failure`. The status description is the
parseable contract: `verdict=<clean|parked> reviewer_family=<family>
head=<full-head-sha>`.

Merge gates and autonomous-merge paths check that status on the **current** PR
head SHA. If the PR receives a new push, the old status is tied to the old SHA
and no longer counts. This replaces the interim PR-comment protocol; do not use
comments or free-form summaries as the gate.

ao's native review API (`GET /sessions/{id}/reviews`, with states such as
`ineligible` or `needs_review`) is a separate ao reviewer system. It is useful
for ao's own review UI, but it is **not** `/final-review` and must never be read
as the final-review merge verdict.

Repos that carry `ops/final-review-status.mjs` use it as the status helper:
`node ops/final-review-status.mjs set --repo <owner/repo> --sha
<full-head-sha> --verdict <clean|parked> --reviewer-family <family>` after the
review loop, and `node ops/final-review-status.mjs check --repo <owner/repo>
--sha <current-head-sha>` in the merge gate.

## Session habits

**Start ("what's next"):** check `bd list --status=in_progress --assignee=@me`,
`bd ready`, `bd blocked` (or open GH issues on beads-less repos). Finish
in-progress work first; recommend 1–3 unclaimed items, not the full list.

**End:** close/update beads and issues, run CI, `git pull --rebase && git
push`, report. Merge only under rule 6's authorization (user's word, or
autonomous mode with the SHA-current `final-review` status gate satisfied) —
never on your own initiative.

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
- **SDLC audit markers:** workers must leave durable, externally auditable
  markers for every lifecycle stage. The durable surfaces are GitHub issue/PR
  comments plus SHA-pinned commit status/check contexts; when the ao session/API
  is available, also emit ao activity updates so `/api/v1/events` and
  `ao-slack-notifier.service` surface the transition in Slack. The chat
  transcript is never the audit record.

  Required markers:

  1. **Planning** — after `/plan-work` or equivalent phase design, post the
     phase plan and test strategy to the GitHub issue or PR. If no PR exists
     yet, use the issue and carry the marker forward once the PR opens.
  2. **Independent review cycle** — for each review cycle, post a
     `review requested` marker with the reviewer/model family and head SHA
     reviewed, then post `review verdict` with the verdict, findings count by
     severity, and whether fixes are required.
  3. **CI run** — for each local or remote CI run used as a gate, post `CI run`
     with the command or workflow, the head SHA, and the conclusion. Link remote
     logs when GitHub Actions produced them.
  4. **Final review** — `/final-review` is REQUIRED before merge readiness. Its
     final-review verdict must be posted as a PR comment naming the current head
     SHA, and it must set a successful `review-passed` commit status/check on
     that same SHA only when the verdict is clean. Failed, inconclusive, or
     stale verdicts must set or leave a non-success state and park the PR.

  Autonomous merge is blocked unless GitHub has a clean final-review verdict for
  the current head SHA, backed by both required artifacts: the final-review PR
  comment naming that SHA and a successful `review-passed` commit status/check
  on that SHA. Any missing, stale, failing, inconclusive, or different-SHA
  artifact parks the PR instead of merging.

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

## Orchestrator role policy

Project-orchestrator standing policy is intentionally not inlined in the shared
repo instruction context. Only an ao-created orchestrator session whose injected
system prompt identifies it as the project orchestrator should read
`.claude/orchestrator-policy.md`. Workers and interactive/ad-hoc sessions ignore
that file.
