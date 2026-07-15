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

## Claim vs author contract

Trackers carry identity in two different ways, and skills must not mix them:

- **Author/creator fields are informational.** GitHub `author`, Beads `owner`,
  Beads `created_by`, and similar fields say who filed or created the record.
  They MUST NEVER block dispatch, routing, reservation, cleanup, or review.
- **Only assignee/claim fields gate ownership.** GitHub `assignees` and the
  Beads `assignee` set by `bd update <id> --claim` are the active claim. Every
  `EXPECTED_ASSIGNEE` check and cross-agent ownership gate keys only on those
  fields.
- **Unassigned work is claimable.** A linked issue or bead with no assignee is
  available to any agent identity, regardless of who authored or created it.
- **Starting work claims both trackers.** When an agent begins work, it claims
  the bead with `bd update <id> --claim` when Beads are present and mirrors the
  claim to GitHub with `gh issue edit <n> --add-assignee <gh-login>`.
- **Foreign assignee means park, not steal.** If another agent family is the
  current assignee, park or skip the item unless the user explicitly reassigns
  it. A different author/creator is never a foreign claim.

## Beads backend — shared host is configuration, not code

A repo's `bd` may attach to a **shared beads host** so every agent — across
machines and accounts — sees the same live state. This is configured per repo,
never hardcoded in skills:

- The attachment is established at repo setup (`/nickify`) or by a
  session-start hook: `BEADS_DIR`, a shared Dolt server
  (`bd init --server …` / `--database …`), or an orchestrator-provisioned DB.
- When `.beads/metadata.json` records canonical shared-server metadata —
  `dolt_mode = "server"` plus non-empty `dolt_server_host` and `dolt_database` — durable `bd` writes
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
   worktree YOU created under the repo-local agent worktree directory:

   ```bash
   DEFAULT_BRANCH_REF="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || echo refs/remotes/origin/main)"
   DEFAULT_BRANCH="${DEFAULT_BRANCH_REF#refs/remotes/origin/}"
   git fetch origin "$DEFAULT_BRANCH"
   git worktree add .claude/worktrees/<slug> -b <branch> "origin/$DEFAULT_BRANCH"
   ```

   Run this from the main repo root, never inside another worktree, then install
   deps. Fetch and branch from the remote ref even when the local default branch
   appears clean; a clean local branch can still be stale.
   `.claude/worktrees/` is the shared convention for Claude, Codex,
   Gemini, and other agents; the `.claude` path name is historical, not a
   Claude-only boundary. Do not place working copies under `.git/worktrees/` —
   that is Git's private metadata directory for linked worktrees. Derive the
   default branch — don't assume `main`. **The shared main checkout root is
   read-only ground truth**:
   never commit or switch branches there, and treat its files as read-only
   during ordinary task work — other agents (and the user) rely on its state.
   The `cleanup-merge` lifecycle is the one narrow exception: it may
   fast-forward the worktree that already owns the default branch only after
   confirming that checkout is clean, and it must never switch that checkout's
   branch. Fetch-only sync of refs is always fine. A Codex-supplied detached
   worktree may itself have been created
   from a stale local branch before session-start logic ran. Never reset or move
   a supplied worktree that may contain active work; use it only as launch
   context and create the required task worktree from the freshly fetched
   remote ref as above.

3. **Test gates.** Fast loop per commit. Before push: full CI (build + format + tests), then rebase against the default branch — clean → push
   (`--force-with-lease` if rewritten); conflicted → park. Never push a stale
   stack.
4. **Explicit git adds.** `git add <file>` — never `git add .` / `-A`. Never
   disable commit signing to dodge a failure.
5. **Verify before claiming.** Nothing "works" until you exercised it — run
   it, curl it, read the logs, drive the UI. Reviewer and subagent claims are
   leads, not facts: the primary agent verifies them and reports the exact
   command and exact error; "not installed" does not mean "unavailable."
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

- **Subagents**, by capability tier: lightweight for triage and monitoring;
  standard for reproduction, implementation, and verification; deep reasoning
  for root-cause analysis and architecture; planner for design-only work. Each
  agent identity maps these tiers to its available mechanics. Prefer a subagent
  for any substantial phase; you orchestrate.
- **Many-eyes review pool** — reviews exist for diversity of failure modes. The
  primary independent reviewer is a **different local reviewer agent**,
  preferably a different model family and independent of the implementer. The
  agent identity defines the available reviewer roster and invocation mechanics.
  One reviewer is never a review, and a single integrated reviewer is never
  enough.
- **Review monitor** — a lightweight subagent watches cross-cycle patterns
  (ping-pong, convergence) and calls the verdict; the orchestrator fixes.
- Repo fragments may extend this contract (name a roster, add gates); they may
  not weaken rules 6–8 above.
