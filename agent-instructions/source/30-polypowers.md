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
   it, curl it, read the logs, drive the UI. Reviewer and subagent reports are
   **evidence candidates, never facts** — the verification contract below binds
   every blocker claim you repeat.
6. **Don't self-review; merge only with authorization.** Independent review
   belongs to a different model family (see the identity contract below) —
   never to the implementer. Merging requires **explicit authorization**, which
   comes in exactly two forms: the user says so in the session, or the session
   runs in **autonomous mode** (the project's `autonomousMerge` config is on,
   which AO reflects into worker runtime env for compatibility, or a queue
   invoked with `--merge`). In autonomous mode the
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

## The verification contract — reviewer claims are evidence, never facts

A reviewer's or subagent's assertion about the environment — "the tests cannot
run", "the toolchain is missing", "that dependency is unavailable" — is a
**claim**, not a finding. The primary agent owns every claim it repeats, and a
claim it did not verify is its own defect, not the subagent's. Before a
tool/dependency/test blocker may enter a final report, a filed issue, a review
verdict, or a merge-readiness statement, the primary MUST do all of the
following **itself**:

1. **Read the repo's own declarations** — the manifests, the lockfiles, and the
   declared scripts for the package in question. The lockfile decides which
   package manager a project uses; a settings or workspace file belonging to a
   different manager decides nothing.
2. **Check the executable actually named** — is that binary on `PATH`? Is the
   repo-declared alternative (a different package manager, a vendored binary, a
   container) present and usable?
3. **Attempt the repo-declared safe install path** — including any install
   overrides the repo documents — before declaring anything unavailable.
4. **Record the exact failing command and its exact error output.** A blocker
   with no recorded command and no recorded error is not a blocker; it is an
   untested assumption.

"Dependencies are not preinstalled" must **never be reported as** "dependencies
are unavailable." Not-preinstalled is a step you have not taken yet.

### Omitted tests: three distinct states, each signed off

Final reports, PR bodies, and filed issues state, per suite, which of these three
applies. They are never collapsed into a vague "tests not run":

1. **FAILED** — the suite ran and actually failed. Give the suite, the command,
   and the failures.
2. **NOT RUN (evidenced blocker)** — the suite did not run because a blocker
   survived all four checks above. Give the exact command attempted and its exact
   error.
3. **NOT PREINSTALLED** — dependencies or tooling were merely absent from a
   fresh checkout and the declared install path was not attempted or not
   completed. This is a gap in your verification, not a property of the repo,
   and it is never evidence of a blocker.

The primary agent **signs off** on every omission explicitly: for each suite it
did not run, it names the state, the reason, and the evidence, in its own voice.
Silence about an unrun suite is a defect in the report.

## The workflow — one skill per phase

Features go through OpenSpec; bugs go to the tracker; keep spec-implementation
and bug-fix sessions separate.

**Selection rule:** assignment is the sole admission signal. Work assigned open
issues; leave unassigned issues inert, and park work by unassigning it. Status,
charter, and routing labels are informational or choose a harness only — they
never grant or veto admission. Sensitive-path membership is never a reason to
skip working an assigned ticket.

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
non-clean, inconclusive, or timed-out review writes `state=failure`. The status
description is the parseable contract: `verdict=<clean|parked>
reviewer_family=<family> head=<full-head-sha>`. A clean review that is parked
only because repo policy requires a human merge still writes
`final-review=success`; the human gate is recorded separately as a current-head
`merge-park` status with `reason=human-required`.

Human merge gates check the `final-review` status on the **current** PR head
SHA. Autonomous-merge paths check the same clean review status and additionally
refuse to merge when a current-head `merge-park` signal exists. If the PR
receives a new push, the old statuses are tied to the old SHA and no longer
count. This replaces the interim PR-comment protocol; do not use comments or
free-form summaries as the gate.

ao's native review API (`GET /sessions/{id}/reviews`, with states such as
`ineligible` or `needs_review`) is a separate ao reviewer system. It is useful
for ao's own review UI, but it is **not** `/final-review` and must never be read
as the final-review merge verdict.

Repos that carry `ops/final-review-status.mjs` use it as the status helper:
`node ops/final-review-status.mjs set --repo <owner/repo> --sha
<full-head-sha> --verdict <clean|parked> --reviewer-family <family>` after the
review loop; add `--human-merge-required` when a clean review must park for
human merge authority. Use `node ops/final-review-status.mjs check --repo
<owner/repo> --sha <current-head-sha>` for a human-authorized merge gate, and
add `--mode autonomous` for autonomous merge eligibility.

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
