# Pipelines v2 — Design Spec

Status: design locked, unimplemented
Scope: a redo in place of `backend/internal/pipeline`. Not a new package.

---

## 1. Intent

Pipelines v1 exists on `pipelines-upstream`, works, and has never shipped. It was built to
someone else's spec, and the person holding the release keys does not understand it well
enough to own, maintain, or extend it. v2 keeps the entire feature surface and the entire
UI, and rebuilds the internals around the two things that actually hurt: **stage-to-stage
information transfer** and **spawned-session lifecycle**.

Success is not fewer lines. Success is that the release owner can read the whole thing,
predict what a pipeline will do before running it, and add a new trigger or action without
touching the core.

The mechanism is deliberately boring and modeled on GitHub Actions, with four deliberate
divergences documented in §14.

### The five load-bearing ideas

1. **The engine owns the index; agents own the detail.** Agents write files. Only the
   engine writes `Context.md`, and only after verifying the file exists. Pointers in the
   prompt, content on disk.
2. **A run is a snapshot.** The definition is frozen into the run folder at run start.
   Editing a definition cannot affect an in-flight run.
3. **The workspace is derived from the subject, not from the machine.** GitHub's `runs-on`
   picks a host; ours picks a tree. Keeping this as `subject → tree` is what makes hosted
   runners a later addition rather than a rewrite.
4. **Agents produce; the engine performs.** Anything requiring authority — pushing, posting,
   signing — is a command stage. Credentials never enter an agent's environment.
5. **Outcome is measured, not claimed.** An agent saying "done" is a claim. The declared
   artifact existing is evidence. Both are recorded, and the difference is visible in the UI.

---

## 2. Scope

### In

- **Triggers**: PR (`created`, `updated`, `merge-ready`, `merged`), session (`idle`,
  `exited`, `blocked`). Triggers start whole runs only, never individual stages.
- **Executors**: `agent` and `command`.
- **DAG**: fan-out via list-valued `on_success`, joins via `needs`, failure routing via
  `on_failure`.
- **Workspace model**: six values, subject-derived default, per-stage override.
- **Outcome model**: seven outcomes, cascading skip, one bounded nudge.
- **Credential tiers**: engine-held credentials, schema-forbidden on agent stages.
- **Ambient identity injection**: no declaration required.
- **Concurrency**: subject-derived scope plus a named group, cancel-in-progress toggle,
  queue depth 1.
- **Sessionless runs**: first-class. The subject may be a project or someone else's PR.
- **Session lifecycle**: per-stage `kill-on` keyed to outcome, plus a bounded reaper.
- **Pipeline-level defaults**: `deadline` and `on_failure`.
- **All existing UI**: graph/canvas editor, Kanban run board, definitions page, run detail,
  settings modal. Nothing is cut.

### Out — wanted, deliberately later

- Cron and scheduled triggers.
- Push-to-branch triggers.
- Graph cycles (see §9.1 — rejected at validation, not merely unimplemented).
- Compensating actions / rollback after a point of no return (§13.3).
- Matrix expansion.
- Reusable / composable pipeline fragments.
- Hosted runner execution (§15).

### Out — rejected, not deferred

- A parallel `pipeline2/` package.
- Cutting any part of the v1 UI. Smallness was never the goal; comprehensibility was.
- An expression language (§12.3).
- Pasting agent output into the next stage's prompt.
- Letting agents write `Context.md`.
- Per-pipeline shared context across runs.
- Explicit per-stage environment declaration.
- A `continue-on-error` equivalent (§14.2).
- Job-outputs-as-strings (§14.3).

---

## 3. Run lifecycle

```
trigger fires
  → resolve subject           (session | PR | project)
  → check concurrency group   (queue, cancel, or drop)
  → allocate run id
  → create run folder
  → freeze definition into run folder
  → compute plan              (walk graph, validate, enumerate reachable stages)
  → provision workspaces      (as each is first needed)
  → execute from entry stage
  → settle
  → teardown owned workspaces
```

**Freeze.** The definition is copied to `<run>/definition.yaml` at run start and the run
executes that copy. Editing a definition cannot corrupt an in-flight run, and run detail
shows what actually ran rather than what the definition says today.

**Plan-at-start.** Execution is transition-driven — each stage starts when its predecessor
settles — but the definition is static, so the engine enumerates every reachable stage
before anything runs. Three payoffs: the Kanban board renders all cards immediately as
`pending`, cycle detection is a free side effect of the same walk, and workspace validity
(§5.3) fails the run before any stage executes rather than halfway through.

**Entry stage** is the first stage in document order. There is no `entry:` key.

### Run folder

```
~/.ao/pipelines/<project-id>/<run-id>/
  definition.yaml            frozen copy — what actually ran
  run.json                   state: stage outcomes, timings, attempt counts
  Context.md                 engine-written index
  agent-outputs/
    <stage>.md               declared artifacts
  stage-logs/
    <stage>.log              stdout+stderr, both executors, always captured
  workspace/                 if any stage uses `workspace: run`
  workspaces/<stage>/        if any stage uses `workspace: stage`
```

Run id keys the folder, so concurrent runs of the same pipeline cannot collide. Concurrency
is safe by construction, not by locking.

---

## 4. Triggers and subjects

A trigger names a **subject**. The subject determines the default workspace and which
ambient variables resolve.

| Trigger | Subject | Session? |
|---|---|---|
| `session: [idle, exited, blocked]` | that session | always |
| `pr: [created, updated, merge-ready, merged]` | that PR | if a local session tracks it |

A PR subject may or may not have a session. Both are normal. Sessionless is first-class —
a pipeline watching someone else's PR must work with no session anywhere in the picture.

Trigger and action registries are the two extension points. Adding a trigger means
registering an event source that resolves a subject; adding an action means registering an
executor. The core is a router between them and should not need editing for either.

---

## 5. Workspace

### 5.1 Values

| `workspace` | tree | owned by run? |
|---|---|---|
| `auto` *(default on success entry)* | resolved from subject | depends |
| `inherit` *(default on failure entry)* | the tree of the stage that routed here | no, ownership stays with the originating stage |
| `session` | the subject's session worktree | no |
| `run` | one worktree per run, created at first use from the subject's ref | yes |
| `stage` | a fresh worktree each time the stage is entered | yes |
| `checkout` | the primary local checkout | no |

`auto` resolves to `session` if the subject has one, otherwise `run`.

The key always means what it says. Only which value is the *default* varies by entry edge
(§5.4), so there are no hidden semantics to discover.

A project-subject run therefore gets a worktree, **not** the primary checkout. Mutating the
tree someone is actively coding in is opt-in via `checkout`, never a default.

Git worktrees share the object store, so provisioning costs a checkout, not a clone. That
is why `run` and `stage` are affordable enough to be defaults.

### 5.2 Choosing

- **`session`** — the work belongs in the user's tree and should be visible there.
- **`run`** — serial stages that mutate the tree and need to share the mutation. Trial
  merges, builds followed by signing, anything where a later stage needs an earlier stage's
  filesystem state.
- **`stage`** — concurrent stages. Three parallel `npm ci` in one tree is a corrupt
  `node_modules`; three worktrees is three clean builds. This is the case `stage` exists for.
- **`checkout`** — rare and explicit.

### 5.3 Validity

Exactly one combination is impossible: **`session` when the subject has no session.**

This cannot be rejected at edit time, because a `pr.*` trigger may or may not have a
session depending on the PR. So:

- Canvas editor shows a **warning** on `workspace: session` under a `pr.*` trigger.
- Plan time is a **hard failure**, before any stage runs, with the reason stated:
  `stage 'review' requires workspace 'session'; PR #412 has no local session`.

Fail the run. Never silently fall back.

### 5.4 `inherit` and failure edges

`inherit` resolves to the tree of the stage that routed here. It is the **default when a
stage is entered via `on_failure`**, and it is legal but must be explicit anywhere else.

Failure entry is the one case where inheritance is reliably what you want. A diagnostic
agent needs the failure state: the partial `dist/`, the `node_modules`, the merge conflict.
That is why `diagnose-build` in §11 declares no workspace.

Stages entered via `on_success` and declaring no `workspace` get `auto`.

`inherit` is **rejected at validation on any stage with more than one inbound success
edge**, where the tree it names would be genuinely ambiguous. Same ambiguity that leaves
`AO_PREV_*` unset at a join (§12.2), same resolution.

Multiple inbound *failure* edges are fine, which is why `diagnose-build` in §11 is legal
with three. §9.3 makes failure entry first-arrival-wins, so exactly one stage routes in per
run and the tree resolves unambiguously at runtime. This is the same precedent as
`AO_FAILED_STAGE`, which is set on failure entry for exactly this reason.

### 5.5 Teardown

Owned workspaces (`run`, `stage`) are destroyed on success and **kept on failure**. Same
rule as sessions, for the same reason, and consistency between the two is worth more than
the disk.

---

## 6. Executors

### 6.1 `command`

```yaml
- id: publish
  executor: command
  run: |
    gh release create ...
  credentials: [github-release]
  deadline: 10m
```

Outcome is exit status. stdout and stderr are captured to
`<run>/stage-logs/<stage>.log` at settle time — without this, a failed command's reason is
gone by the time anyone opens run detail.

### 6.2 `agent`

```yaml
- id: review
  executor: agent
  agent: claude-code
  produces: review.md
  deadline: 20m
  session:
    kill-on: [succeeded, failed]
  prompt: |
    ...
```

There is **no agent taxonomy**. "Review agent" vs "answer agent" is not a property of the
agent, it is a property of the stage's contract, and the contract is one declarative key:

- **`produces:` present** — the agent must signal *and* the named artifact must exist
  non-empty. Verified.
- **`produces:` absent** — the signal is the whole contract. Settles as
  `succeeded (unverified)`.

`produces:` takes a bare filename and resolves to `<run>/agent-outputs/<filename>`. The
convention is enforced by the schema, not by author discipline. `$AO_OUTPUT` carries the
absolute path.

### 6.3 Signalling

Agents settle their own stage:

```
ao pipeline done
ao pipeline fail --reason "..."
```

The failure channel matters. An agent that concludes the task is impossible should route to
the failure edge, not hang until deadline. GitHub has no analogue because processes exit
nonzero; for agents this needs an explicit verb.

**How the CLI knows which stage it is settling.** It reads `AO_RUN_ID` and `AO_STAGE` from
its own environment (§12.2). If either is missing, `ao pipeline done|fail` **errors rather
than guessing**. An agent that shelled into another tree, or a nested session that did not
inherit the stage environment, gets a clear failure instead of silently settling the wrong
stage.

### 6.4 Unverifiable actions

"Summarize and post to Discord" cannot be verified because one stage does both. Split it:
the agent produces `summary.md`, a command stage POSTs it, and the command's exit code is a
real measurement.

Every unverifiable agent action has this shape. It is the same split as the credential tier
(§8), and it is why `credentials:` is schema-forbidden on agent stages — the two rules
enforce each other.

---

## 7. Outcomes

| Outcome | Meaning |
|---|---|
| `succeeded` | signaled/exit 0, and declared artifact exists non-empty |
| `succeeded (unverified)` | signaled, no `produces:` declared |
| `failed` | `ao pipeline fail`, or non-zero exit |
| `no_output` | signaled, but artifact missing or empty |
| `no_signal` | session exited or went idle without signalling |
| `timed_out` | deadline hit |
| `cancelled` | superseded by concurrency, or killed |
| `skipped` | a predecessor did not succeed |

**Skipped is not failed, and it cascades.** When B does not run because A died, B did not
fail. Conflating them makes the run board unreadable at exactly the moment someone is
debugging.

**`succeeded (unverified)` is deliberately visible.** It is honest, it costs one flag, and
across a corpus of runs it tells you which stages want a `produces:` contract.

**`no_output` has no GitHub analogue** — commands don't exit 0 having accomplished nothing.
Engine-verifies-the-file is a strictly better success gate than exit code, and it earns its
own outcome rather than being folded into failure.

### 7.1 Nudge

`no_output` and `no_signal`-by-idle get **one** nudge. It is not a graph cycle; it never
leaves the stage. It works because the session is still alive with its context — the engine
is continuing, not restarting.

```
You signaled done but agent-outputs/review.md does not exist or is empty.
Overwrite it now, then signal again.
```

Bounds:

- One nudge. Two attempts total. Not configurable. If a second nudge would help, the prompt
  is wrong.
- The nudge says **overwrite**, not write. This is the entire mitigation for partial files —
  there is no reliable way to detect a partial file after the fact, so the fix is
  prescriptive rather than detective.
- Never nudge an explicit `ao pipeline fail`. The agent decided; respect it.
- Never nudge an exited session. Nothing to nudge.
- Record attempt count in `run.json`. "Succeeded after 1 nudge" across runs is exactly the
  data that says which prompts to fix.

Idle-without-signal is where the nudge is most valuable: it is the disambiguator between
"finished and forgot to call the CLI" and "stuck waiting."

### 7.2 Session disposition

```yaml
session:
  kill-on: [succeeded, failed]
```

The default. `no_output`, `no_signal` and `timed_out` keep the session alive, because those
are precisely the cases where a human needs to see what the agent was actually doing.
`kill-on: []` never kills, which is correct for any stage running in a user's live session.

The taxonomy of outcomes is what made this decidable. With one `failed` bucket it was a
coin flip.

**`timed_out` interrupts the process but keeps the session.** The distinction matters:
`no_output` and `no_signal` are already idle, so there is nothing to interrupt, but a
timed-out agent may still be running. Keeping the tmux session and its scrollback is the
point; keeping a runaway agent burning tokens for a day is not.

### 7.3 Reaping kept-alive sessions

Kept-alive is the common case on agent failure, so without a bound it reproduces the exact
workspace-clobbering v2 exists to fix. Two bounds, neither of them reap-on-run-settle: the
run settles seconds after the stage does, so that would kill the session before anyone could
look at it.

- **Cap: 3 kept-alive sessions per pipeline, LRU eviction.** This is what actually prevents
  the fifty-session case.
- **TTL: 24h.** This handles the slow leak.

Kept sessions are marked **pipeline-orphaned** in the session list, carrying the run id, the
stage, the outcome that spared them, and a kill button. The bound stops the bleeding; the
visibility is what stops it recurring.

---

## 8. Credentials

Two tiers, split by who can read them.

**Stage env** — everything the agent's process can see. Identity only. Nothing that grants
authority.

**Engine-held credentials** — named in `credentials:`, injected into command stages only.
Never enter an agent's environment.

```yaml
credentials: [apple-signing]
```

`credentials:` on `executor: agent` is **rejected at validation time.** This makes the tier
a schema property rather than a convention: the canvas editor can render it, and nobody can
quietly regress it.

GitHub's fork-PR restrictions exist because PR contents are untrusted code. Ours is worse:
PR contents are untrusted *input to an LLM with shell access*. A prompt injection in a diff
plus a token in the environment is a direct exfiltration path.

**A PR from outside the org defaults to identity-only.** Retrofitting this means breaking
pipelines people have already written, so it ships in v1.

---

## 9. Graph

### 9.1 Edges

- `on_success:` — a stage id, or a **list** of stage ids. A list fans out; targets start
  concurrently. This is the only fan-out mechanism.
- `on_failure:` — a single stage id.
- Absent `on_success` on a settled-successful stage ends that branch. The run completes when
  no stage is running or pending.

**A stage with no `on_failure` inherits `defaults.on_failure`** (§9.4). Absent both, the
branch ends silently.

**Cycles are rejected at validation time.** The model is a state machine, not a DAG — each
stage names its successor, so `A --fail--> B --fail--> A` is expressible and is an infinite
loop. This is a five-line check at plan time and a nasty incident later. Retry lives inside
a stage (§7.1); it is not an edge.

### 9.2 Joins

**`needs:` is required on any stage with more than one inbound success edge**, and the
engine validates it matches the actual inbound set exactly.

It is redundant with the forward edges by construction. That is the point: redundancy the
engine checks is documentation that cannot drift. Without it, joins are invisible in the
YAML and legible only in the canvas.

A join whose predecessor is skipped or failed is itself skipped. Cascading skip does all the
work — there is no `if: always()` equivalent and none is wanted.

**Failure edges are never counted for `needs` and never require it.** A stage with one
inbound success edge and six inbound failure edges does not need a `needs:` key.

### 9.3 Failure edges never join

A stage entered via `on_failure` runs on first arrival. Later arrivals are dropped. The run
is already failing; three notifications from three dead builds is noise.

### 9.4 Pipeline-level failure default

```yaml
defaults:
  on_failure: notify-failure
```

Any stage without an explicit `on_failure` routes there. Silence on failure should never be
the accidental outcome, and without this it always is: every stage the author forgot to wire
fails into nothing.

The side effect is that the stages routing somewhere *interesting* stop being buried in
boilerplate. In §11, once the default is declared, the only surviving explicit `on_failure`
keys are `diagnose-build` and `notify-partial`, which are exactly the two worth noticing.

**The default target does not inherit the default.** `notify-failure` routing to itself
would be a self-edge, rejected as a cycle by §9.1. Its own failure ends the branch. This
carve-out is narrow and applies only to the stage named in `defaults.on_failure`.

The validator **warns** when a pipeline declares neither `defaults.on_failure` nor an
`on_failure` on every stage. Not an error, because a single-stage pipeline does not need one.

---

## 10. Concurrency

```yaml
concurrency:
  scope: pr          # pr | session | project
  group: review      # literal, defaults to the pipeline name
  cancel-in-progress: true
```

Two keys, because one was doing two jobs. `scope` decides **which runs collide**; `group`
decides **which pipelines share a bucket**. The effective concurrency key is
`(resolved scope identity, group)`.

- `scope: pr` means per-PR-number, so two different PRs never collide.
- `scope` defaults to the subject's natural scope: `pr.*` triggers default to `pr`,
  `session.*` to `session`.
- Runs sharing an effective key serialize.
- `cancel-in-progress: true` — a new run cancels the in-flight one.
- Queue depth is **1**. A third arrival evicts the queued run rather than stacking.

Nothing is interpolated and §12.3 stays intact. A single overloaded `group: pr` string would
have put every PR in the project into one bucket, so two PRs updated at once would cancel
each other.

**For `pr.updated`, `cancel-in-progress: true` is the recommended default.** The head moved;
the in-flight run is operating on stale code, and letting it finish produces a review of a
commit nobody is looking at.

**For release-shaped pipelines, `false`.** Nothing is worse than killing a run mid-notarization.

The release pipeline in §11 must declare `scope: project` explicitly, because its trigger is
`pr.merged` (which would default to `pr` scope) while the thing being serialized is
project-wide. That is a useful forcing function: it makes the author state what is actually
being protected.

---

## 11. Worked example

A release pipeline with fan-out, two joins, signing credentials, and a diagnostic agent on
the failure path.

```
prepare
 ├─→ build-macos   ─┐
 ├─→ build-windows ─┼─→ verify-digests ─→ sign-macos ─┐
 ├─→ build-linux   ─┘                                 ├─→ publish-github ─┬─→ update-tap  ─┐
 └─→ release-notes ───────────────────────────────────┘                   └─→ update-feed ─┴─→ announce
```

```yaml
name: release
on:
  pr: [merged]

concurrency:
  scope: project
  group: release
  cancel-in-progress: false

defaults:
  on_failure: notify-failure

stages:
  - id: prepare
    executor: command
    workspace: run
    run: |
      test "$(git rev-parse --abbrev-ref HEAD)" = "main"
      mkdir -p "$AO_RUN_DIR"/{artifacts,digests}
      ao release resolve-version > "$AO_RUN_DIR/version"
    on_success: [build-macos, build-windows, build-linux, release-notes]

  - id: build-macos
    executor: command
    workspace: stage
    deadline: 40m
    run: |
      npm ci
      npm run build:mac -- --version "$(cat "$AO_RUN_DIR/version")"
      sha256sum dist/*.dmg > "$AO_RUN_DIR/digests/macos.txt"
      cp dist/*.dmg "$AO_RUN_DIR/artifacts/"
    on_success: verify-digests
    on_failure: diagnose-build

  - id: build-windows
    executor: command
    workspace: stage
    deadline: 40m
    run: |
      npm ci
      npm run build:win -- --version "$(cat "$AO_RUN_DIR/version")"
      sha256sum dist/*.exe > "$AO_RUN_DIR/digests/windows.txt"
      cp dist/*.exe "$AO_RUN_DIR/artifacts/"
    on_success: verify-digests
    on_failure: diagnose-build

  - id: build-linux
    executor: command
    workspace: stage
    deadline: 40m
    run: |
      npm ci
      npm run build:linux -- --version "$(cat "$AO_RUN_DIR/version")"
      sha256sum dist/*.AppImage > "$AO_RUN_DIR/digests/linux.txt"
      cp dist/*.AppImage "$AO_RUN_DIR/artifacts/"
    on_success: verify-digests
    on_failure: diagnose-build

  - id: release-notes
    executor: agent
    agent: claude-code
    workspace: stage
    produces: release-notes.md
    deadline: 15m
    session:
      kill-on: [succeeded, failed]
    prompt: |
      Write release notes for version $(cat "$AO_RUN_DIR/version").
      Use `git log` since the previous tag. Group by user-visible change,
      not by commit. Omit internal refactors.
      Write to $AO_OUTPUT, then `ao pipeline done`.
      If there are no user-visible changes, `ao pipeline fail --reason "..."`.
    on_success: publish-github

  - id: verify-digests
    executor: command
    needs: [build-macos, build-windows, build-linux]
    workspace: run
    run: ao release verify-digests "$AO_RUN_DIR/digests" "$AO_RUN_DIR/artifacts"
    on_success: sign-macos

  - id: sign-macos
    executor: command
    workspace: run
    credentials: [apple-signing]
    deadline: 45m
    run: |
      ao release sign-dmg   "$AO_RUN_DIR/artifacts/"*.dmg
      ao release notarize --wait --timeout 40m "$AO_RUN_DIR/artifacts/"*.dmg
      ao release verify-notarization "$AO_RUN_DIR/artifacts/"*.dmg
    on_success: publish-github

  - id: publish-github
    executor: command
    needs: [sign-macos, release-notes]
    workspace: run
    credentials: [github-release]
    run: |
      gh release create "v$(cat "$AO_RUN_DIR/version")" \
        "$AO_RUN_DIR/artifacts/"* \
        --notes-file "$AO_RUN_DIR/agent-outputs/release-notes.md"
    on_success: [update-tap, update-feed]

  - id: update-tap
    executor: command
    workspace: run
    credentials: [homebrew-tap]
    run: ao release bump-cask --version "$(cat "$AO_RUN_DIR/version")"
    on_success: announce
    on_failure: notify-partial

  - id: update-feed
    executor: command
    workspace: run
    credentials: [github-release]
    run: ao release publish-feed --version "$(cat "$AO_RUN_DIR/version")"
    on_success: announce
    on_failure: notify-partial

  - id: announce
    executor: command
    needs: [update-tap, update-feed]
    workspace: run
    credentials: [discord]
    run: |
      ao discord post --file "$AO_RUN_DIR/agent-outputs/release-notes.md" \
        --title "v$(cat "$AO_RUN_DIR/version")"

  - id: diagnose-build
    executor: agent
    agent: claude-code
    produces: diagnosis.md
    deadline: 15m
    session:
      kill-on: []
    prompt: |
      Build stage `$AO_FAILED_STAGE` failed. Its log is at
      $AO_RUN_DIR/stage-logs/$AO_FAILED_STAGE.log and you are in its
      working tree with the failure state intact.
      Diagnose the root cause, write to $AO_OUTPUT, then `ao pipeline done`.
    on_success: notify-failure

  - id: notify-failure
    executor: command
    workspace: run
    credentials: [discord]
    run: |
      ao discord post --title "release failed at $AO_FAILED_STAGE" \
        --body "outcome: $AO_FAILED_OUTCOME"

  - id: notify-partial
    executor: command
    workspace: run
    credentials: [discord]
    run: |
      ao discord post --urgent --title "PARTIAL RELEASE" \
        --body "GitHub release for v$(cat "$AO_RUN_DIR/version") is live but \
$AO_FAILED_STAGE failed. Manual reconciliation required."
```

Notes on the example:

- `workspace: stage` on the fan-out is load-bearing. Three concurrent `npm ci` in one tree
  is a corrupt `node_modules`.
- `workspace: run` on every serial stage after `verify-digests` means one worktree, created
  once at `prepare`. No repeated checkout cost.
- `diagnose-build` declares no workspace, so it defaults to `inherit` and gets the failed
  build's tree, with `node_modules` and the partial `dist/` intact. That is the difference
  between an agent that can reproduce a failure and one reading a log.
- `release-notes` is the only agent in the success path and has no `credentials:` because it
  cannot. It produces; `publish-github` and `announce` perform.
- `defaults.on_failure` carries every stage that declares nothing, including `announce`,
  which would otherwise fail silently after the release is already live. The only explicit
  `on_failure` keys left are `diagnose-build` and `notify-partial`.
- `scope: project` is explicit because the trigger is `pr.merged`, which would otherwise
  default to per-PR scope and let two merges release concurrently.
- `notify-partial` exists because the DAG has a point of no return (§13.3).
- No matrix, deliberately. Three near-identical stages is more YAML than a matrix and every
  one is greppable and independently editable. A matrix pays off at twenty legs.

---

## 12. Information transfer

### 12.1 Context.md

Written by the **engine only**, after it verifies the stage's declared artifact exists
non-empty. Contains **pointer lines**, not content:

```
stage `review` finished, its output is at agent-outputs/review.md
```

`Context.md` is pasted verbatim into the next agent's prompt via `$AO_CONTEXT`. Agent output
files are never pasted. A downstream agent reads them off disk if it wants detail.

Index in the prompt, detail on disk. This keeps prompt size bounded regardless of output
size — which matters because a large fraction of real pipelines are Claude invoked repeatedly.

### 12.2 Ambient variables

Injected wherever resolvable. No declaration required.

| Variable | Available |
|---|---|
| `AO_PROJECT` | always |
| `AO_RUN_ID` | always |
| `AO_RUN_DIR` | always |
| `AO_STAGE` | always (the current stage id) |
| `AO_ATTEMPT` | always (`1`, or `2` after a nudge) |
| `AO_CONTEXT` | always (path to `Context.md`) |
| `AO_WORKSPACE` | always |
| `AO_SESSION_ID` | when the subject has a session |
| `AO_PR_NUMBER`, `AO_PR_REPO`, `AO_PR_HEAD` | PR subjects |
| `AO_OUTPUT` | agent stages with `produces:` |
| `AO_PREV_STAGE`, `AO_PREV_OUTCOME` | stages with exactly one predecessor |
| `AO_FAILED_STAGE`, `AO_FAILED_OUTCOME` | stages entered via `on_failure` |

`AO_PREV_*` is **unset at a join**, where it would be ambiguous. Per-stage outcomes are
readable from `run.json` if a stage genuinely needs them.

`AO_RUN_ID` and `AO_STAGE` are what `ao pipeline done|fail` resolves itself from (§6.3), so
they are the two that must never be absent. `AO_ATTEMPT` lets an agent tell that it is being
nudged, and a prompt can branch on it.

Exact names beyond the identity set are still open (§16).

### 12.3 No expression language

Everything in a `run:` or a `prompt:` is shell-interpolated environment variables. There is
no `${{ }}`.

GitHub needs an expression language because its expressions evaluate before the shell exists
and across a network boundary. Ours don't. Not building an evaluator is worth more to the
comprehensibility goal than any other single simplification — it is the difference between a
config format and a language with its own semantics someone has to learn.

---

## 13. Validation

Rejected at **edit/save time**:

- Unknown stage id in `on_success`, `on_failure`, `needs`, or `defaults.on_failure`.
- A graph cycle.
- `needs:` missing on a stage with >1 inbound **success** edge.
- `needs:` not matching the actual inbound **success** edge set. Failure edges are never
  counted and never require it (§9.2).
- `workspace: inherit` on a stage with >1 inbound success edge (§5.4).
- `credentials:` on an `executor: agent` stage.
- `produces:` containing a path separator.
- Unknown credential name.
- Unknown `concurrency.scope` value (must be `pr`, `session`, or `project`).

Warned at edit time only:

- A pipeline with neither `defaults.on_failure` nor an `on_failure` on every stage (§9.4).
  Not an error: a single-stage pipeline does not need one.

Warned at edit time, failed at **plan time**:

- `workspace: session` under a `pr.*` trigger.

Failed at **plan time**:

- `workspace: session` where the resolved subject has no session.

### 13.1 Deadlines

Every stage has a deadline. There is no unbounded stage: an agent that hangs must eventually
settle as `timed_out`, or the run board grows entries nobody ever closes.

The deadline is **defaulted, not required**. 30m out of the box, overridable per pipeline:

```yaml
defaults:
  deadline: 45m
```

Requiring an explicit `deadline` on every stage was rejected. It is noise on nearly every
stage, and a number typed under duress is a guess anyway. The actual goal was that the bound
be *visible*, so the canvas editor surfaces the **effective** deadline on every stage,
inherited or explicit. Visibility was the goal; mandatory typing was a bad proxy for it.

### 13.2 Cancellation

`cancelled` is distinct from `failed` and from `timed_out`. A cancelled stage does not route
to `on_failure`; the run is being torn down, not routed. Owned workspaces are kept, matching
§5.5.

### 13.3 Point of no return

Nothing in this model can undo a completed stage. In the example, everything after
`publish-github` is post-publication: the release is live and there is no rollback.

The v1 answer is a loud, distinct failure path (`notify-partial`) that names manual
reconciliation as the required action. Compensating actions are a v2 conversation. This is a
known gap, stated rather than hidden, and it is the thing most likely to bite on release
pipelines specifically.

`defaults.on_failure` (§9.4) closes the adjacent hole: post-publication stages that declare
no failure route, such as `announce`, used to fail in total silence *after* the release was
already live. The default now catches them. It does not undo anything, but it guarantees
someone is told.

---

## 14. Divergences from GitHub Actions

**14.1 No resume.** GitHub's "re-run failed jobs" works because job outputs are persisted
server-side and jobs are nominally idempotent. It also produces a whole category of
confusion: `GITHUB_RUN_ATTEMPT`, stale artifacts from attempt 1 present in attempt 2,
outputs from a reused job referencing a commit that has since moved. Failed runs are dead.
Re-running means a new run.

**14.2 Failure routing subsumes `continue-on-error`.** GitHub needs a per-step escape hatch
because its only edge type is "succeeded." We have an explicit failure edge, so "this stage
is allowed to fail" is just routing failure to the same successor. One mechanism, not two.

**14.3 The filesystem subsumes artifacts.** GitHub has three data mechanisms —
`$GITHUB_OUTPUT`, job outputs, artifacts — purely because each job is a fresh VM. Our stages
share a run folder, so the tier collapses to one. Importing job-outputs-as-strings would be
solving an isolation problem we don't have.

**14.4 No implicit `success()` wrapper.** GitHub silently ANDs any `if:` lacking a status
function with `success()`, so conditions mean something other than what they say. It is
their worst wart. If stage conditions are ever added, the status requirement must be
explicit and visible in the canvas editor.

Also not taken: matrix expansion, reusable-workflow composition, artifact retention policy.
All of it is scale machinery for a system running millions of heterogeneous jobs. None of it
earns its complexity at this stage count.

**What GitHub has nothing to offer on:** what "settled" means for an agent. Exit codes are
unambiguous; agent completion is not. The signal-plus-verification model (§6, §7) is our own
design, not a port.

---

## 15. Forward compatibility

The hosted product is runner-shaped, and this model should not have to be rewritten for it.

The one thing that must hold: **workspace resolution stays `subject → tree`, never "the tree
is on this machine."** When a stage can run on a hosted runner, `runs-on` becomes real and
the checkout becomes an explicit provisioning step — but only if locality was never baked
into the resolver.

Credentials are already engine-held rather than environment-injected, which is the right
shape for a runner that should never see them.

---

## 16. Open

- `Context.md` format if markdown proves awkward. YAML, JSON, plain text all acceptable.
- Exact ambient variable names beyond the identity set.
- Whether definitions stay in their current store or move to
  `~/.ao/pipelines/<project-id>/definitions`.
- Whether `run.json` is the state store or a projection of something else.
- Default `deadline` value (30m is a placeholder).
- Whether the kept-alive session cap (3, LRU) and TTL (24h) are configurable or fixed.
- Whether `stage` workspaces are provisioned lazily or all at fan-out.
- Log retention / run folder GC policy.