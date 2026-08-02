# Pipelines

A pipeline is a set of **stages** wired together by success and failure edges,
started by a **trigger** (a PR event, a session event, or a human) and run
against a **subject** (a pull request, a session, or the project). Each stage
either spawns an agent session or runs a shell command; when it settles, the
engine follows that stage's `on_success` or `on_failure` edge to whatever comes
next. There is no loop construct, no retry budget and no expression language.

The mechanism is modeled on GitHub Actions closely enough that most of what you
know transfers, and diverges in the four places where agents are not processes.
Those divergences are collected in [Where this differs from GitHub
Actions](#where-this-differs-from-github-actions).

Definitions are single YAML documents, validated server side and stored in
SQLite. A run **freezes** the definition it was triggered from into its own run
folder and executes that copy, so editing a definition can never affect a run
already in flight.

The design spec is [`docs/plans/2026-07-26-pipelines-v2.md`](plans/2026-07-26-pipelines-v2.md).
Where this doc and the spec disagree, this doc describes the code that actually
runs; [Known gaps and divergences](#known-gaps-and-divergences) lists every
place the two differ on purpose.

## Enabling the feature

Pipelines are off by default and experimental. There are two ways to turn them
on: a persisted setting for normal use, and an env override for dev/CI.

**Settings toggle (recommended).** In the desktop app open Global settings, turn
**Developer Mode** on to reveal the **Pipelines** card, flip **Pipelines** to
enabled, then Save. The choice persists in the daemon's
own store (a `pipelines.enabled` row in the `app_settings` table under `~/.ao`),
so it survives restarts and applies no matter who launches the daemon (the
Electron supervisor or a headless `ao start`). Saving restarts the daemon so the
change takes effect immediately, and the sidebar's Pipelines entry appears once
the daemon is back.

**`AO_PIPELINES` env override (dev/CI).** Set `AO_PIPELINES` in the daemon's
environment before it boots, following the same on/off convention as AO's other
`AO_*` toggles: `on`/`true`/`1`/`yes` enable it, `off`/`false`/`0`/`no` disable
it.

**Precedence.** When `AO_PIPELINES` is set (to on OR off) it wins and the
persisted setting is ignored: it is a hard override. When `AO_PIPELINES` is
unset, the persisted `pipelines.enabled` setting decides. With neither set,
pipelines stay off.

When pipelines are off (whichever source resolved it):

- The Pipelines entry is hidden from the sidebar nav.
- Every `/api/v1/pipelines/*` route returns 501.
- No per-project pipeline engines start, and the CDC trigger bridges do not
  subscribe to PR or session events.

The settings endpoint itself (`/api/v1/settings/pipelines`) is never gated by
the flag, so the toggle is always reachable.

**Developer Mode is a visibility gate, nothing more.** Developer Mode lives in
the renderer's `localStorage` (`ao.developerMode`) and a headless daemon has no
renderer, so it never decides whether engines start: `AO_PIPELINES`, then the
persisted `pipelines.enabled` setting, remain the only sources of truth. Turning
Developer Mode off with pipelines already enabled therefore changes nothing on
the daemon: the engines keep running, the routes keep serving, and the sidebar's
Pipelines entry stays. To avoid stranding that choice behind a hidden toggle,
the Pipelines card stays visible while pipelines are enabled even with Developer
Mode off, so it can always be turned back off (the same escape `UpdatesSection`
keeps for a persisted feature-build pin).

```bash
# dev/CI override; forces pipelines on regardless of the persisted setting
AO_PIPELINES=on ao start
```

> Note: a headless `ao start` daemon the desktop app merely attached to (rather
> than spawned) is not restarted by the Settings toggle. The setting is still
> persisted and applies the next time that daemon boots.

## The model

```
trigger fires
  -> resolve subject          (PR | session | project)
  -> check concurrency group  (start, queue, cancel, or drop)
  -> allocate run id, create run folder, freeze the definition
  -> compute the plan         (walk the graph, resolve every workspace)
  -> run the entry stage
  -> follow edges until nothing is running or pending
  -> destroy owned workspaces if the run succeeded, keep them if it did not
```

**The entry stage is the first stage in document order.** There is no `entry:`
key.

**Edges, not dependencies.** Each stage names what comes after it:

- `on_success:` takes one stage id or a list. A list fans out and the targets
  start concurrently. This is the only fan-out mechanism.
- `on_failure:` takes exactly one stage id. A stage that declares none inherits
  `defaults.on_failure`; with neither, its failure ends that branch silently.
- A settled-successful stage with no `on_success` ends its branch. The run
  completes when nothing is running or pending.

**Joins are declared.** A stage with more than one inbound success edge must
declare `needs:` naming exactly that set, and the validator checks the two
match. The redundancy is the point: it is documentation the engine will not let
drift. Failure edges never count toward `needs` and never require it.

**Cycles are rejected at validation time.** Because each stage names its
successor, `a --fail--> b --fail--> a` is expressible and is an infinite loop.
Retrying lives inside a stage (see [the nudge](#produces-and-the-single-nudge)),
never as an edge.

**Skips cascade.** If a stage does not succeed, everything downstream of it on
the success path settles as `skipped`, which is a distinct outcome from
`failed`. There is no `if: always()` equivalent.

**Plan at start.** Before the first stage runs, the engine walks the graph and
resolves every reachable stage's deadline and workspace. Three payoffs: the run
detail can render every stage immediately as pending, cycle detection falls out
of the same walk, and the one impossible workspace combination fails the run up
front instead of half way through.

## Executors

There are exactly two, and no agent taxonomy. Whether a stage is a "review
agent" or an "answer agent" is a property of its contract, not of the executor.

### `executor: command`

```yaml
- id: publish
  executor: command
  workspace: run
  credentials: [github-release]
  deadline: 10m
  run: |
    gh release create "v$(cat "$AO_RUN_DIR/version")" "$AO_RUN_DIR/artifacts/"*
```

The exit status is the outcome: zero is `succeeded`, non-zero is `failed`.
`run:` is a shell script executed with `sh`, in the stage's workspace, with the
ambient environment plus any credentials the stage declared. stdout and stderr
are streamed to `stage-logs/<stage>.log` in the run folder, so a failed
command's reason is still there when someone opens run detail an hour later.

`produces:` is rejected on a command stage: it settles on its exit status.

### `executor: agent`

```yaml
- id: review
  executor: agent
  agent: claude-code
  produces: review.md
  deadline: 20m
  session:
    kill-on: [succeeded, failed]
  prompt: |
    Review the diff, write it to $AO_OUTPUT, then run `ao pipeline done`.
```

The stage spawns a real AO session running `agent:` (the harness name, for
example `claude-code`) in the stage's workspace, with the stage's `prompt:` in
front of an engine-written preamble. The preamble names the stage, pastes
`Context.md` verbatim, names `$AO_OUTPUT` when the stage declares one, and
states the settlement contract.

The session **settles itself**, and the two things that decide how are the
signal and the artifact. Everything about that is in the next two sections.

`credentials:` is rejected on an agent stage at validation time. See
[Credentials](#credentials).

## Outcomes

A stage that has not settled is `pending` or `running`. A settled stage lands on
exactly one of these eight:

| Outcome | What actually happened |
| --- | --- |
| `succeeded` | Signalled done (or exited 0), and the declared artifact exists and is non-empty |
| `succeeded_unverified` | Signalled done, and the stage declared no `produces:`, so there was nothing to check |
| `failed` | `ao pipeline fail --reason "..."`, or a non-zero exit |
| `no_output` | Signalled done, but the declared artifact is missing or empty |
| `no_signal` | The session exited or went idle without ever signalling |
| `timed_out` | The stage deadline was hit |
| `cancelled` | The run was torn down: superseded by concurrency, or cancelled by hand |
| `skipped` | A predecessor did not succeed |

Both `succeeded` and `succeeded_unverified` take the `on_success` edge. Only
`failed`, `no_output`, `no_signal` and `timed_out` take the `on_failure` edge:
`cancelled` is a teardown rather than a routing decision, and `skipped`
propagates its own skip instead.

### Why the taxonomy is this wide

Eight outcomes is more than a success/failure boolean, and each extra one buys
something concrete.

**`succeeded` versus `succeeded_unverified`** is the difference between a claim
and evidence. A stage with `produces:` has told the engine what its work looks
like on disk, so the engine can check: the file exists and is non-empty, or the
stage did not do what it said. A stage without `produces:` has only its own word
that it finished, and the engine has no way to disagree. Both are successes and
both take the same edge. They are separate outcomes because collapsing them
would hide, at a glance, which half of your pipeline is actually measured. Over
a corpus of runs, `succeeded_unverified` is the list of stages that want a
`produces:` contract and do not have one yet.

**`no_output` versus `no_signal` versus `timed_out`** are three different
failures that a single `failed` bucket would make indistinguishable, and each
one calls for a different fix.

- `no_output` means the agent claimed to be done and was wrong. It ran, it
  decided it had finished, and the file it promised is not there. The fix is
  almost always the prompt: it did not make the artifact the point.
- `no_signal` means the agent went quiet without claiming anything. It either
  finished and forgot to call the CLI, or it is stuck. The fix is usually to
  make the settlement contract louder, or to notice that the task was
  underspecified enough to stall on.
- `timed_out` means it was still going when the deadline hit. Nothing is wrong
  with the contract; the bound was wrong, or the work is genuinely too big for
  one stage.

Command stages can only ever produce `failed` or `timed_out` here, because a
process that exits has said something unambiguous. The other two exist because
agent completion is not an exit code.

The taxonomy is also what makes session disposition decidable. With one `failed`
bucket, "kill the session or keep it" is a coin flip. With these, it is obvious:
`no_output`, `no_signal` and `timed_out` are exactly the cases where a human
needs to open the pane and see what the agent was doing.

**`skipped` is not `failed`.** When B never ran because A died, B did not fail.
Conflating the two makes the run board unreadable at the exact moment somebody
is debugging it.

### Run status

The run-level rollup shown on the runs list is narrower: `cancelled` if the run
was cancelled, else `failed` if any stage settled in `{failed, no_output,
no_signal, timed_out}`, else `succeeded`.

## The signal contract

An agent stage settles itself from inside its own session:

```bash
ao pipeline done
ao pipeline fail --reason "the migration cannot be written without the staging schema"
```

Nothing else settles an agent stage. Going idle does not, finishing the prompt
does not, closing the pane does not.

The failure channel is not optional politeness. An agent that concludes the task
is impossible should route to the failure edge immediately rather than hang
until its deadline, and `--reason` is required because that string is what the
run detail shows and what `$AO_FAILED_OUTCOME`'s stage sees. GitHub has no
analogue for this verb because processes exit non-zero; agents need to be told.

**How the CLI knows which stage it is settling.** It reads `AO_RUN_ID` and
`AO_STAGE` out of its own environment. If either is missing it **errors by name
rather than guessing**, so an agent that shelled into another tree, or a nested
session that did not inherit the stage environment, gets a clear failure instead
of quietly settling somebody else's stage.

The same signal is reachable over HTTP at
`POST /api/v1/pipelines/runs/{runId}/stages/{stageId}/signal`, which is what the
CLI calls. It answers 202: the signal is recorded, and the engine decides the
outcome on its next poll.

## `produces` and the single nudge

`produces:` takes a **bare filename** (a path separator is a validation error)
and resolves to `<run>/agent-outputs/<filename>`. The absolute path is in
`$AO_OUTPUT`. The stage's own prompt preamble names it.

That one key is the whole contract:

- **`produces:` present.** The agent must signal *and* the named file must exist
  non-empty. Verified, and the outcome is `succeeded`.
- **`produces:` absent.** The signal is the entire contract, and the outcome is
  `succeeded_unverified`.

### The nudge

When an agent signals done but its artifact is missing or empty, or when its
session goes idle without ever signalling, the engine does not settle the stage
straight away. It sends **one** message into the still-running session:

```
You signaled done but agent-outputs/review.md does not exist or is empty.
Overwrite it now, then signal again.
```

or, when what is missing is the signal rather than the file:

```
You appear to be finished but have not signalled.
Run 'ao pipeline done' or 'ao pipeline fail --reason ...' now.
```

The bounds are fixed and not configurable:

- **One nudge. Two attempts total.** If a second nudge would have helped, the
  prompt is wrong. Arriving at the same dead end again settles the stage as
  `no_output` or `no_signal`.
- The nudge says **overwrite**, not write. There is no reliable way to detect a
  half-written file after the fact, so the mitigation is prescriptive.
- **An explicit `ao pipeline fail` is never nudged.** The agent decided; that is
  respected.
- **An exited session is never nudged.** There is nothing to nudge.
- The stage is never relaunched. The nudge works precisely because the session
  is still alive with its context: the engine is continuing it, not restarting
  it.

The attempt count is recorded in `run.json` and rendered on run detail, so
"succeeded after one nudge", across many runs, is exactly the data that says
which prompts to fix.

> `AO_ATTEMPT` in the session's environment stays `1` even on the nudged
> attempt. See [Known gaps and divergences](#known-gaps-and-divergences).

### Session disposition

```yaml
session:
  kill-on: [succeeded, failed]
```

That pair is the default when no `session:` block or no `kill-on:` key is
present. `succeeded` also covers `succeeded_unverified`: the two differ by
whether there was an artifact to verify, not by whether the agent finished.

Every other outcome keeps the session alive, because `no_output`, `no_signal`
and `timed_out` are precisely the cases somebody needs to look at.
`kill-on: []` never kills, which is what you want for a stage running inside a
user's own live session.

`timed_out` interrupts the agent's work but keeps the session and its
scrollback. Keeping the pane is the point; keeping a runaway agent burning
tokens for a day is not.

**Kept sessions are bounded.** A kept session is marked *pipeline-orphaned* in
the session list, carrying its run id, stage, the outcome that spared it, and a
kill button. Two fixed bounds stop the leak: at most **3** kept sessions per
pipeline (least recently kept evicted) and a **24 hour** TTL swept in the
background. Neither is configurable.

## Workspaces

`workspace:` names the tree a stage runs in. It is derived from the subject, not
from the machine.

| Value | The tree it names | Owned by the run? |
| --- | --- | --- |
| `auto` | `session` if the subject has a session, otherwise `run` | depends |
| `session` | the subject session's existing worktree | no |
| `run` | one worktree per run, created at first use | yes |
| `stage` | a fresh worktree each time the stage is entered | yes |
| `checkout` | the project's primary local checkout | no |
| `inherit` | the tree of the stage that routed here | no, ownership stays with the originating stage |

**Defaults depend only on the entry edge.** A stage entered via `on_success`
(and the entry stage itself) defaults to `auto`. A stage entered via
`on_failure` defaults to `inherit`, because failure entry is the one case where
inheritance is reliably what you want: a diagnostic agent needs the failure
state, the partial `dist/`, the `node_modules`, the merge conflict. The key
always means what it says; only which value is the default varies.

Agent stages run in the resolved tree too: the session manager adopts it rather
than creating one of its own, and session teardown never destroys a
run-owned tree.

**Choosing one:**

- **`session`** when the work belongs in the user's tree and should be visible
  there.
- **`run`** for serial stages that mutate the tree and need to share the
  mutation: a trial merge, a build followed by signing, anything where a later
  stage needs an earlier stage's filesystem state.
- **`stage`** for concurrent stages. Three parallel `npm ci` in one tree is a
  corrupt `node_modules`; three worktrees is three clean builds. This is the
  case `stage` exists for.
- **`checkout`** rarely, and always explicitly. A project-subject run gets a
  worktree by default, not the tree you are coding in.

Worktrees share the git object store, so provisioning costs a checkout rather
than a clone, which is what makes `run` and `stage` cheap enough to be defaults.

**The one impossible combination** is `workspace: session` when the subject has
no session. It cannot be rejected at edit time, because a `pr.*` trigger may or
may not have a session depending on the PR, so:

- the editor **warns** on `workspace: session` under a `pr.*` trigger;
- plan time is a **hard failure**, before any stage runs, naming the reason:
  `stage 'review' requires workspace 'session'; PR #412 has no local session`.

The run fails. There is no silent fallback.

`inherit` is rejected at validation on any stage with more than one inbound
success edge, where the tree it names would be genuinely ambiguous. Multiple
inbound *failure* edges are fine: failure entry is first-arrival-wins, so
exactly one stage routes in per run and the tree resolves unambiguously.

**Teardown: destroy on success, keep on failure.** Owned trees (`run`, `stage`)
are destroyed when the run settles `succeeded` and kept otherwise, which is the
same rule sessions follow and for the same reason. One carve-out: a tree a
spared session is still living in is kept regardless, because a kept session in
a destroyed workspace is a pane with no working directory.

## The run folder

Every run gets a directory keyed by run id, so concurrent runs of the same
pipeline cannot collide. Safety by construction rather than by locking.

```
<AO_DATA_DIR>/pipelines/<project-id>/<run-id>/
  definition.yaml          the frozen definition: what actually ran
  run.json                 stage outcomes, timings, attempt counts, reasons
  Context.md               the engine-written index
  agent-outputs/
    <produces>             each stage's declared artifact, by its own filename
  stage-logs/
    <stage>.log            stdout and stderr, command stages
  workspace/               present if any stage uses `workspace: run`
  workspaces/<stage>/      present if any stage uses `workspace: stage`
```

`AO_DATA_DIR` defaults to `~/.ao/data`, so the default root is
`~/.ao/data/pipelines/`. Nothing here ever lands in an OS-default
application-data location.

- **`definition.yaml`** is a byte-identical copy taken at run start. Run detail
  renders this, not the definition as it stands today.
- **`run.json`** is a projection for humans and debugging. SQLite is the store
  of record; this file is rewritten in full on every persist.
- **`Context.md`** is written by the **engine only**, never by an agent, and
  only after the engine has verified a stage's declared artifact exists
  non-empty. It holds pointer lines, not content:

  ```
  stage `review` finished, its output is at agent-outputs/review.md
  ```

  It is pasted verbatim into the next agent's prompt via `$AO_CONTEXT`. Agent
  output files are never pasted: a downstream agent reads them off disk if it
  wants the detail. Index in the prompt, detail on disk, so prompt size stays
  bounded no matter how large the outputs get. A run in which nothing declares
  `produces:` never gets a `Context.md` at all, and the agent preamble says so
  ("It is empty: nothing ran before you").
- **`agent-outputs/`** is keyed by the `produces:` filename, not by stage id.
  Two stages declaring the same filename would overwrite each other.
- **`stage-logs/`** holds command-stage output. Agent stages write no log file;
  their record is the session's own scrollback, and run detail renders the
  absence as "No log was captured for this stage."

Run folders are **never garbage collected**. See [Known gaps and
divergences](#known-gaps-and-divergences).

## Triggers and subjects

A trigger names a **subject**, and the subject decides the default workspace,
which ambient variables resolve, and the default concurrency scope.

| Trigger | Subject | Session? |
| --- | --- | --- |
| `pr: [created, updated, merge-ready, merged]` | that pull request | when a local session tracks it |
| `session: [idle, exited, blocked]` | that session | always |
| manual (`ao pipeline run`, or the UI) | whatever the caller names | `--session`, `--pr`, or neither |

Declaring no `on:` block at all is legal and means a manual-only pipeline.

```yaml
on:
  pr: [created, updated]
```

**PR events.** `created` and `updated` come straight off the CDC event stream.
`merge-ready` and `merged` are derived and fire on the *transition into* their
state, so a PR that sits in that state does not re-fire on every poll. A PR
first observed already in the state counts as a transition and fires once, so a
pipeline armed after the fact still runs. "Merge ready" means: open, not draft,
CI not failing, review approved or absent, and mergeable.

There is no new-SHA cancel-and-rearm in the trigger bridge. In v2 that is
`concurrency.cancel-in-progress` on the `updated` trigger, decided by the
concurrency table.

**Session events.** `idle`, `exited` and `blocked` fire on a state
*transition*, so a session holding at idle fires once. Two consequences worth
knowing:

- **A first sighting never fires.** The bridge has to have observed the session
  in some earlier state to call the current one a transition. After a daemon
  restart, a session that is already idle waits for its next real change before
  it can trigger anything.
- **Pipeline-spawned sessions are ignored.** Without that guard, a pipeline's
  own agent going idle would fire the session pipelines, whose agents go idle,
  forever. If the guard cannot be answered, the session is skipped: no run is
  the fail-safe answer.

`waiting_input` deliberately has no trigger, so an agent parked at an empty
prompt does not start pipelines behind your back.

**Manual runs** name their own subject, which means a manual run can be about a
PR or a session that the `on:` block never mentions:

```bash
ao pipeline run pr-review --pr 42        # PR subject
ao pipeline run nightly --session ao-17  # session subject
ao pipeline run nightly                  # project subject
```

## Concurrency

```yaml
concurrency:
  scope: pr          # pr | session | project
  group: review      # a literal name; defaults to the pipeline name
  cancel-in-progress: true
```

Two keys, because one was doing two jobs. **`scope`** decides which runs
collide; **`group`** decides which pipelines share a bucket. The effective key
is the pair.

- `scope: pr` means per PR number, so two different PRs never collide.
- `scope` defaults to the subject's natural scope: `pr` for a PR subject,
  `session` for a session subject.
- Runs sharing an effective key serialize.
- `cancel-in-progress: true` makes a new run cancel the in-flight one.
- **Queue depth is 1.** A third arrival evicts the queued run rather than
  stacking behind it.
- A subject with no identity at the requested scope (a project run under
  `scope: pr`, for example) serializes against nothing.

**For `pr.updated`, `cancel-in-progress: true` is the right default.** The head
moved; the in-flight run is reviewing code nobody is looking at any more.

**For release-shaped pipelines, `false`.** Nothing is worse than killing a run
mid-notarization. A release pipeline triggered on `pr: [merged]` should also set
`scope: project` explicitly, because the trigger would otherwise default it to
per-PR scope and let two merges release concurrently.

## Credentials

Two tiers, split by who can read them.

**Stage env** is everything a stage's process can see: identity only, nothing
that grants authority. Agents get this and only this.

**Engine-held credentials** are named in `credentials:` and injected into a
**command stage's** process environment at exec time. They live in the daemon
and are never echoed back to a user, a log line or an agent.

```yaml
- id: post-review
  executor: command
  credentials: [github-review]
  run: gh pr comment "$AO_PR_NUMBER" --body-file "$AO_RUN_DIR/agent-outputs/review.md"
```

```bash
ao pipeline credential set github-review GH_TOKEN=ghp_...
ao pipeline credential ls
ao pipeline credential rm github-review
```

`set` replaces the credential's whole environment, so dropping a `KEY=VALUE`
removes that variable. `ls` answers with names. Nothing prints a value back.
Values passed on the command line land in your shell history, so prefer a
script or a history-skipping shell.

**`credentials:` on an `executor: agent` stage is a validation error.** That
makes the tier separation a schema property rather than a convention: the canvas
editor can render it, and nobody can quietly regress it. GitHub restricts fork
PRs because PR contents are untrusted code; here PR contents are untrusted
*input to an LLM with shell access*, and a prompt injection in a diff plus a
token in the environment is a direct exfiltration path.

Two consequences follow:

- **A fork PR runs identity-only.** If any reachable stage declares
  `credentials:` and the subject is a fork PR, the run **fails at plan time**
  with the reason stated, rather than running the stage without its credentials.
  Unknown provenance counts as a fork: fail-safe when nobody can establish where
  the head lives.
- **An unverifiable agent action must be split.** "Summarize and post to
  Discord" cannot be verified because one stage does both. The agent produces
  `summary.md`; a command stage POSTs it, and the command's exit code is a real
  measurement. Agents produce; the engine performs.

A credential name the project does not define is rejected when the definition is
saved, naming the `ao pipeline credential set` command that fixes it.

## The ambient environment

Every stage gets these injected. Nothing is declared; there is no per-stage env
block.

| Variable | Available |
| --- | --- |
| `AO_PROJECT` | always |
| `AO_RUN_ID` | always |
| `AO_RUN_DIR` | always |
| `AO_STAGE` | always (this stage's id) |
| `AO_ATTEMPT` | always (**always `1`**, see below) |
| `AO_CONTEXT` | always (path to `Context.md`, which may not exist yet) |
| `AO_WORKSPACE` | always (the resolved tree) |
| `AO_SESSION_ID` | when the subject has a session |
| `AO_PR_NUMBER`, `AO_PR_REPO`, `AO_PR_HEAD` | PR subjects |
| `AO_OUTPUT` | agent stages declaring `produces:` |
| `AO_PREV_STAGE`, `AO_PREV_OUTCOME` | stages entered on a success edge with exactly one predecessor |
| `AO_FAILED_STAGE`, `AO_FAILED_OUTCOME` | stages entered via `on_failure` |

`AO_RUN_ID` and `AO_STAGE` are the two that must never be absent: they are what
`ao pipeline done|fail` resolves itself from.

`AO_PREV_*` is **unset at a join**, where it would be ambiguous. Per-stage
outcomes are readable from `run.json` if a stage genuinely needs them.

`AO_PR_HEAD` is set for every PR subject, including one whose head sha is not
recorded, in which case it is present but empty.

`AO_ATTEMPT` is **always `1`**, including on the nudged attempt. A nudge
deliberately does not relaunch the stage, and a running process's environment
cannot be rewritten, so the launch value stands. An agent learns it is on its
last attempt from the nudge message and from its prompt preamble ("attempt 1 of
2 at most"), not from this variable. Do not branch a prompt on it.

Everything in a `run:` or a `prompt:` is ordinary shell interpolation of these
variables. **There is no expression language**, no `${{ }}`, and none is wanted.
The definitions editor offers `$AO_*` autocomplete inside prompt and run fields,
with availability resolved from the draft you are actually writing.

## Worked example

A PR review pipeline with a fan-out, a join, a credentialed command stage, and a
diagnostic agent on the failure path.

```
review ─┬─→ post-review ─┐
        └─→ run-tests ───┴─→ summarize
                │
                └─fail─→ diagnose ─→ report-failure
```

<!-- validated -->

```yaml
name: pr-review
on:
  pr: [created, updated]

concurrency:
  scope: pr
  group: review
  cancel-in-progress: true

defaults:
  deadline: 20m
  on_failure: report-failure

stages:
  - id: review
    executor: agent
    agent: claude-code
    produces: review.md
    session:
      kill-on: [succeeded, failed]
    prompt: |
      Review the diff on PR #$AO_PR_NUMBER for correctness and security.
      Write the review to $AO_OUTPUT, then run `ao pipeline done`.
      If the diff cannot be reviewed, run `ao pipeline fail --reason "..."`.
    on_success: [post-review, run-tests]

  - id: post-review
    executor: command
    workspace: run
    credentials: [github-review]
    run: gh pr comment "$AO_PR_NUMBER" --body-file "$AO_RUN_DIR/agent-outputs/review.md"
    on_success: summarize

  - id: run-tests
    executor: command
    workspace: stage
    deadline: 30m
    run: |
      npm ci
      npm test
    on_success: summarize
    on_failure: diagnose

  - id: summarize
    executor: agent
    agent: claude-code
    needs: [post-review, run-tests]
    workspace: run
    produces: summary.md
    prompt: |
      $AO_CONTEXT indexes what the earlier stages produced. Read those files,
      write a two paragraph summary to $AO_OUTPUT, then run `ao pipeline done`.

  - id: diagnose
    executor: agent
    agent: claude-code
    produces: diagnosis.md
    deadline: 15m
    session:
      kill-on: []
    prompt: |
      Stage `$AO_FAILED_STAGE` settled $AO_FAILED_OUTCOME. Its log is at
      $AO_RUN_DIR/stage-logs/$AO_FAILED_STAGE.log and you are in its working
      tree with the failure state intact. Diagnose the root cause, write it to
      $AO_OUTPUT, then run `ao pipeline done`.
    on_success: report-failure

  - id: report-failure
    executor: command
    workspace: run
    run: echo "pr-review failed at $AO_FAILED_STAGE ($AO_FAILED_OUTCOME)"
```

What each choice is doing:

- **`review` declares no `workspace:`**, so it gets `auto`. Under a PR trigger
  with a local session that resolves to the session's own tree, which is where a
  reviewer should be looking anyway.
- **`run-tests` uses `workspace: stage`** because it runs concurrently with
  `post-review` and mutates the tree with `npm ci`. A shared tree would be a
  corrupt `node_modules`.
- **`summarize` is a join** and must declare `needs: [post-review, run-tests]`,
  matching its inbound success edges exactly. It cannot use
  `workspace: inherit`, because the tree that would name is ambiguous, so it
  names `run`. `$AO_PREV_STAGE` is unset here.
- **`diagnose` declares no workspace.** It is only ever entered via
  `on_failure`, so it defaults to `inherit` and lands in `run-tests`' tree with
  the failed `node_modules` and test output intact. That is the difference
  between an agent that can reproduce a failure and one reading a log.
  `kill-on: []` keeps its session so a human can pick up where it left off.
- **`defaults.on_failure: report-failure`** carries every stage that declares
  nothing, so the only explicit `on_failure` left in the document is the one
  worth noticing. The stage named by `defaults.on_failure` does not inherit the
  default (that would be a self-edge, rejected as a cycle), so its own failure
  ends the branch.
- **`post-review` is the only stage with credentials**, and it is a command
  stage, because it must be. `review` produces the text; `post-review`
  publishes it. Running this pipeline requires
  `ao pipeline credential set github-review GH_TOKEN=...` first, and a fork PR
  will fail the run at plan time rather than post without a token.
- **`defaults.deadline: 20m`** bounds everything; `run-tests` overrides it.

This document is not decorative: it is parsed by the real parser and checked by
the real validator in `backend/internal/pipeline/docs_example_test.go`, which
lifts every `<!-- validated -->` YAML block straight out of this file and
asserts it produces no errors and no warnings.

## Validation

Rejected when a definition is saved (and by the editor's live
`POST /api/v1/pipelines/validate`, which is the single source of semantic
truth):

- An unknown key anywhere (decoding is strict).
- A pipeline with no stages, or a duplicate stage id.
- An unknown stage id in `on_success`, `on_failure`, `needs`, or
  `defaults.on_failure`.
- A cycle in the routing graph.
- `needs:` missing on a stage with more than one inbound success edge, or
  `needs:` not matching the inbound success edge set exactly. Failure edges are
  never counted and never require it.
- `workspace: inherit` on a stage with more than one inbound success edge.
- `credentials:` on an `executor: agent` stage.
- `produces:` on an `executor: command` stage, or a `produces:` containing a
  path separator.
- An agent stage with no `agent:` or no `prompt:`; a command stage with no
  `run:`.
- An unknown `executor`, PR event, session event, `concurrency.scope`, or
  `session.kill-on` outcome.
- A credential name the project does not define (checked on the save path, where
  the credential store is in hand).

Warned, not rejected:

- A pipeline that declares neither `defaults.on_failure` nor an `on_failure` on
  every stage, because some failure could end its branch in silence. A
  single-stage pipeline legitimately does not need one.
- `workspace: session` under a `pr.*` trigger, which becomes a hard failure at
  plan time if that particular PR has no local session.

Every issue is collected in one pass and reported together, each pointing at its
location in the document (`stages[2].needs`), so an author fixes all of it at
once. The editor's problems panel lists them with a Reveal action and badges the
offending node on the canvas; Save stays disabled while any error is
outstanding.

### Deadlines

Every stage has one. There is no unbounded stage: an agent that hangs must
eventually settle as `timed_out`, or the run board grows entries nobody ever
closes.

The deadline is defaulted, not required: **30 minutes** out of the box,
overridable per pipeline via `defaults.deadline` and per stage via `deadline:`.
Requiring an explicit deadline everywhere was rejected as noise, and a number
typed under duress is a guess anyway. The actual goal was that the bound be
*visible*, which the editor handles by surfacing the effective deadline on every
stage, inherited or explicit.

## CLI

```
ao pipeline list [--project ID] [--json]
ao pipeline create -f FILE [--project ID] [--json]
ao pipeline get <pipeline-ref> [--project ID] [--json]
ao pipeline update <pipeline-ref> -f FILE [--project ID] [--json]
ao pipeline delete <pipeline-ref> [--yes] [--project ID] [--json]
ao pipeline validate -f FILE [--project ID] [--json]
ao pipeline schema
ao pipeline runs [--project ID] [--pipeline NAME] [--status STATUS] [--limit N] [--json]
ao pipeline show <runId> [--project ID] [--json]
ao pipeline run <pipeline-ref> [--project ID] [--session ID] [--pr N] [--json]
ao pipeline cancel <runId> [--project ID]
ao pipeline credential set <name> KEY=VALUE... [--project ID]
ao pipeline credential ls [--project ID]
ao pipeline credential rm <name> [--project ID]
ao pipeline done
ao pipeline fail --reason "..."
```

`ao pipelines` is an alias for `ao pipeline`, and the destructive-verb aliases
follow the usual shell shapes: `rm` for `delete`, `cat` for `get`.

`--project` falls back to `AO_PROJECT_ID`, then the CLI's usual cwd and
session-based project resolution. `--status` filters `runs` by run status
(`pending`, `running`, `succeeded`, `failed`, `cancelled`). `pipeline run`
accepts a pipeline id or its name and resolves the subject from `--session` or
`--pr` (the PR's head sha and fork provenance come from the daemon, so there is
no `--head-sha`); with neither, the subject is the project.

**Definition verbs.** `get`, `update` and `delete` take the same pipeline ref
`run` does: the definition's id or its name. `create`, `update` and `validate`
read the YAML document from `-f FILE`, and `-f -` reads stdin, so a document
pipes in the way you'd expect (`ao pipeline get review | ... | ao pipeline
update review -f -`). `get` prints the stored YAML exactly as authored.
`delete` asks for confirmation in an interactive session and requires `--yes`
in a non-interactive one; past runs and their run folders are kept either way.
`validate` prints the Errors and Warnings lists separately (warnings arrive
even for a valid document and do not block saving) and exits 1 when the
document is invalid, so it slots into CI. `schema` dumps the JSON schema the
visual editor consumes.

**There is no `resume`.** A settled run is final; re-running means triggering a
new one.

**Every run gets a number within its pipeline** the moment it is triggered, the
way GitHub Actions numbers workflow runs: `pr-review #1`, `#2`, `#3`. That is
the handle to use when talking about a run ("pr-review #3 failed"); the run id
is what `show` and `cancel` take. The counter is keyed by pipeline name, so a
definition deleted and recreated under the same name carries on from where it
stopped instead of reissuing numbers older runs already answer to. Numbers are
never reassigned.

```bash
ao pipeline runs --pipeline pr-review --status failed
ao pipeline run pr-review --pr 42
ao pipeline show run-3f77f931-27ee-4185-ad3d-891226c9f874
```

## HTTP API

Every route is under `/api/v1` and returns 501 while pipelines are disabled.

| Route | What it does |
| --- | --- |
| `GET /pipelines` | list a project's definitions |
| `POST /pipelines` | create a definition |
| `PUT /pipelines/{id}` | update a definition |
| `DELETE /pipelines/{id}` | delete a definition |
| `POST /pipelines/validate` | validate a document without saving it |
| `GET /pipelines/schema` | the JSON schema the editor consumes |
| `GET /pipelines/runs` | list runs, newest first |
| `POST /pipelines/runs` | trigger a run |
| `GET /pipelines/runs/{runId}` | run detail |
| `POST /pipelines/runs/{runId}/cancel` | cancel an in-flight run |
| `POST /pipelines/runs/{runId}/stages/{stageId}/signal` | what `ao pipeline done\|fail` calls |
| `GET /pipelines/runs/{runId}/stages/{stageId}/log` | a stage log tail |
| `GET /pipelines/runs/{runId}/outputs/{filename}` | one declared artifact |
| `GET`/`PUT`/`DELETE /pipelines/credentials[/{name}]` | credential names, never values |

The outputs route serves only filenames the run's frozen definition actually
declares in a `produces:`. The declared set is a closed allowlist matched by
exact string equality, so a filename that is not in it never becomes a path.

There is no resume route and there are no artifact or findings routes: v2's
replacement for v1's findings subsystem is the declared artifact.

## UI

The Pipelines section (hidden entirely when pipelines are off) has two tabs and
a project picker that pins the selected project into the URL.

**Definitions** lists the project's stored pipelines and opens an editor with
three view modes: a node-graph **canvas** with a stage inspector on selection, a
**split** canvas plus YAML with two-way sync, and the raw **YAML** editor. All
three edit the same draft. Validation is server side and debounced; the problems
panel and per-node badges show what came back. Creating a definition starts from
a blank canvas, one of three starter templates (`pr-review`,
`session-idle-triage`, `release-gate`), or pasted YAML.

> The starter templates live in TypeScript and are pinned byte-for-byte against
> Go fixtures in `backend/internal/pipeline/testdata/templates/`, which the real
> parser and validator run over in `templates_test.go`. Neither side can drift
> quietly.

**Runs** is shaped like GitHub Actions' workflow list: a rail of pipeline
definitions beside a dense reverse-chronological list of runs, filterable, live
over the existing CDC event transport rather than a separate stream.

**Run detail** is read-only and shaped like a GitHub Actions run page: a status
header with the run's one destructive action, a stage rail, a stage graph, and
per-stage detail carrying the outcome, whether the stage was nudged, which
failure routed into it, what it produced, its session, and its log tail.

## Where this differs from GitHub Actions

**No resume.** GitHub's "re-run failed jobs" works because job outputs are
persisted server side and jobs are nominally idempotent. It also produces a
whole category of confusion: stale artifacts from attempt 1 present in attempt
2, outputs from a reused job referencing a commit that has since moved. Failed
runs here are dead. Re-running means a new run.

**Failure routing subsumes `continue-on-error`.** GitHub needs a per-step escape
hatch because its only edge type is "succeeded". Here "this stage is allowed to
fail" is just routing failure to the same successor. One mechanism, not two.

**The filesystem subsumes artifacts.** GitHub has three data mechanisms
(`$GITHUB_OUTPUT`, job outputs, artifacts) purely because each job is a fresh
VM. Stages here share a run folder, so the tier collapses to one.

**No implicit `success()` wrapper.** GitHub silently ANDs any `if:` lacking a
status function with `success()`, so conditions mean something other than what
they say. There are no stage conditions here at all; cascading skip does that
work.

**And the part GitHub has nothing to offer on:** what "settled" means for an
agent. Exit codes are unambiguous, agent completion is not. The
signal-plus-verification model is this system's own design, not a port.

## Known gaps and divergences

Documented rather than hidden. Each of these is true of the shipped code today.

- **`AO_ATTEMPT` is always `1`**, including on the nudged attempt, because the
  nudge deliberately does not relaunch the stage and a running process's
  environment cannot be rewritten. Run detail shows the real attempt count; the
  environment does not. Do not branch a prompt on it.
- **Agent stages write no `stage-logs/<stage>.log`.** Their record is the
  session's scrollback, which outlives the stage on every outcome that keeps the
  session. Run detail renders the absence as "No log was captured for this
  stage." Command stages always write one.
- **Run folders are never garbage collected**, and a run that did not succeed
  keeps its owned worktrees forever. Disk grows linearly in runs and in kept
  workspaces. The retention policy is deliberately unanswered; until it is, the
  remedy for a heavy user is `rm -rf ~/.ao/data/pipelines/<project-id>`, which
  is safe because SQLite keeps the run rows.
- **A session pipeline only fires for a session the bridge has already observed
  in a different state.** A first sighting is a state, not a transition. After a
  daemon restart, an already-idle session waits for its next real change.
- **A harness with no activity hooks cannot settle `no_signal` early.** Idle is
  only meaningful once the platform has seen the session's first hook callback;
  without one, agent stages are bounded by their deadline instead. Give such
  stages an explicit short `deadline:`.
- **Sessionless PR subjects are supported by the engine but nothing produces one
  yet.** Every PR row AO records names the session that tracks it, so today every
  PR-triggered run carries a session. The path becomes reachable the moment PR
  discovery can record a PR nobody is working on.
- **Nothing on run detail says a run was identity-only** because its PR came
  from a fork. A run whose stages declare credentials fails at plan time with the
  reason stated; a run whose stages declare none simply runs.
- **Credential management is CLI-only.** The canvas renders a stage's declared
  credential names read-only. A settings surface for creating and rotating them
  is a later feature.
- **A restart settles a lost command stage but leaks its process.** Reconciliation
  marks the stage `failed` and routes it; the OS process it started keeps
  running with nothing tracking it.
- **A reconciled agent stage's reason line says "session exited without
  signalling"** even when the session is alive and marked pipeline-orphaned. The
  outcome is right; the string is shared with the genuine session-gone path.
- **The nudge for an idle-without-signal stage can say "You signaled done"**
  when the agent signalled nothing, because the message is chosen by whether the
  artifact is on disk rather than by which event triggered the nudge.
- **A harness trust prompt can burn a whole deadline.** An agent stage gets a
  fresh tree, and a harness that asks for directory trust the first time it sees
  a path will sit on that dialog until the stage times out, having never read
  the prompt.

Deliberately out of scope for now: cron and scheduled triggers, push-to-branch
triggers, compensating actions or rollback after a point of no return, matrix
expansion, reusable pipeline fragments, and hosted runner execution.

Rejected rather than deferred, and not to be revisited casually: graph cycles,
an expression language, pasting agent output into the next stage's prompt,
letting agents write `Context.md`, per-pipeline shared context across runs,
explicit per-stage environment declaration, a `continue-on-error` equivalent,
and job-outputs-as-strings.
