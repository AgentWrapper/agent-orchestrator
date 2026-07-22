# Pipelines

Pipelines let a project define a repeatable multi-stage review/build workflow
that runs against a session's workspace. A pipeline definition is a DAG of
stages (an agent review, a shell command, or a builtin router/compose step)
triggered by git events or run manually. A run drives the DAG to completion,
looping through multiple rounds of feedback until a typed exit predicate
resolves the run to `done` or `stalled`. Definitions are first-class,
CRUD-authored YAML, validated server-side and stored in SQLite; each run
snapshots the definition it was triggered from.

## Enabling the feature

Pipelines are off by default and experimental. There are two ways to turn them
on; a persisted setting for normal use, and an env override for dev/CI.

**Settings toggle (recommended).** In the desktop app open Global settings and
flip **Pipelines → Enabled**, then Save. The choice persists in the daemon's own
store (a `pipelines.enabled` row in the `app_settings` table under `~/.ao`), so
it survives restarts and applies no matter who launches the daemon (the Electron
supervisor or a headless `ao start`). Saving restarts the daemon so the change
takes effect immediately, and the sidebar's Pipelines entry appears once the
daemon is back.

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
- No per-project pipeline engines start, and the CDC trigger bridge does not
  subscribe to PR events.

The settings endpoint itself (`/api/v1/settings/pipelines`) is never gated by
the flag, so the toggle is always reachable.

```bash
# dev/CI override; forces pipelines on regardless of the persisted setting
AO_PIPELINES=on ao start
```

> Note: a headless `ao start` daemon the desktop app merely attached to (rather
> than spawned) is not restarted by the Settings toggle. The setting is still
> persisted and applies the next time that daemon boots.

## Authoring a definition

A definition is a single YAML document: one pipeline per document (there is
no map-of-pipelines file format). `id` is never part of the authored YAML;
the store assigns it on save. `scope` defaults to `worker` and is the only
scope v1 accepts (`orchestrator` and `workstream` are reserved for a later
phase).

```yaml
name: pr-review
stages:
  - name: review
    trigger:
      on: [pr.opened, pr.updated]
    executor:
      kind: agent
      plugin: claude-code
      mode: review
    task:
      prompt: Review the diff for correctness and style issues.
    policy:
      stallWindow: 2

  - name: gate
    trigger:
      on: [manual]
    dependsOn: [review]
    routes:
      when:
        kind: no_open_findings
        stage: review
    executor:
      kind: builtin
      name: compose

exitPredicates:
  done:
    kind: and
    predicates:
      - kind: all_pass
        stages: [review, gate]
      - kind: finding_count_below
        stage: review
        severity: error
        max: 1
  stalled:
    kind: or
    predicates:
      - kind: loop_rounds_at_least
        n: 5
      - kind: not
        predicate:
          kind: stage_verdict
          stage: gate
          verdict: pass
```

Key fields, by section:

- **Stage**: `name`, `trigger.on`, `executor`, `task` (`prompt` /
  `outputSchema` / `inputs`), `policy` (`blocksMerge`, `stallWindow`),
  `budget` (`maxUsd`, `maxDurationMs`), `timeoutMs`, `retries`,
  `maxLoopRounds`, `dependsOn`, `routes.when`, `workspace`
  (`shared-ro` or `isolated-rw`).
- **Executor kinds**: `agent` (requires `plugin` and `mode`, `mode` is one of
  `review`/`code`/`answer`), `command` (requires `command`, plus optional
  `args`/`env`/`cwd`), `builtin` (requires `name`, one of `router`/
  `compose`). Fields from another kind are rejected, not silently dropped.
- **Pipeline-level**: `maxConcurrentStages` (defaults to 1, i.e. serial),
  `allowForkPRs` (defaults to false; gates every stage, agent, command, and
  builtin alike, on fork PRs; see Fork-PR gate below),
  `exitPredicates.{done,stalled,blocksMerge}`.

### Predicates

`routes.when` and `exitPredicates.*` share one typed predicate DSL:
`all_pass` / `any_pass` / `majority_pass` (each takes `stages: [...]`),
`no_open_findings` (optional `stage`), `finding_count_below` (`max`,
optional `stage`/`severity`), `loop_rounds_at_least` (`n`), the
`stage_retried_at_least` (`stage`, `n`), `stage_verdict` (`stage`,
`verdict`), and the composites `and` / `or` (`predicates: [...]`) and `not`
(`predicate: ...`). Every referenced stage name must exist in the same
definition; unknown kinds and cross-kind fields fail validation with a
path-scoped issue (e.g. `stages[1].routes.when: field "max" is not valid
for predicate kind "all_pass"`).

## Authoring in the visual editor

YAML and the CRUD API stay first-class: everything the visual editor saves
goes through the same create/update endpoints as a hand-written document,
and the daemon's `/validate` route remains the single source of semantic
truth. The visual editor is an additive front end over that same document,
for authors who would rather draw the DAG than write it by hand.

**View toggle.** The definition editor opens with a Canvas / Split / YAML
segmented control. Canvas shows only the node graph, YAML shows only the raw
document, and Split shows both side by side. All three edit the same
in-memory draft: an edit made on the canvas reserializes into the YAML buffer
immediately, and a YAML edit reparses into the draft after a short debounce.
The YAML buffer is the bridge back to the canonical document, so switching
views never loses information a mode does not itself display.

**The canvas.** Each stage renders as one node, styled distinctly by
executor kind (agent, command, builtin) so the shape of the pipeline is
readable at a glance. Edges are `dependsOn`: drawing an edge between two
nodes adds the dependency, deleting an edge removes it. A dependency cycle
is blocked before it lands in the draft and the offending edges are
highlighted in place so the author can see exactly what would have looped.
An auto-layout pass keeps the graph readable as stages and dependencies are
added, rather than requiring authors to place nodes by hand.

**The stage inspector.** Selecting a node opens an inspector for that
stage: name, trigger events, the executor's kind-specific fields (agent's
`plugin`/`mode`, command's `command`/`args`/`env`/`cwd`, builtin's `name`),
the task prompt, depends-on, the run condition (`routes.when`), workspace
mode, and an advanced-knobs group for retries, timeout, max loop rounds, and
budget (max USD, max duration).

**The predicate builder.** `routes.when` and each of the three exit
conditions (`done`, `stalled`, `blocksMerge`) are authored through the same
predicate builder: nested ALL/ANY groups, one row per predicate kind with
its kind-specific fields, a not-wrap toggle for negating a predicate or
group, and a live readout of the compiled predicate DSL so the author can
confirm what will actually be saved.

**Pipeline settings.** A settings modal covers the pipeline-level fields
that do not belong to any one stage: name, max concurrent stages, allow
fork PRs, and the three exit conditions (each edited with the same
predicate builder described above).

**Live validation.** As the draft changes, the editor debounces a call to
`POST /api/v1/pipelines/validate` and surfaces the result two ways: a
problems panel listing every issue with a Reveal action that selects the
offending stage, and a badge on the affected node in the canvas. Save stays
disabled while any problem, a YAML parse error or a validation issue, is
outstanding.

**The New pipeline modal.** Creating a definition starts with a choice of
three paths: Blank canvas (an empty draft, canvas view), From template (one
of three built-in starting points: PR review loop, 8 stages; Nightly triage
sweep, 4 stages; Release gate, 5 stages, each opened in canvas view), or
Paste YAML (import an existing document verbatim, opened in YAML view). All
three land in the same editor described above.

## Triggers

A stage fires on `manual` or on PR lifecycle events delivered through the
CDC event bus: `pr.opened`, `pr.updated`, `pr.merge_ready`, `pr.merged`.

- `pr.opened` fires on PR creation, `pr.updated` on every subsequent PR
  update.
- `pr.merge_ready` is derived, not a raw webhook event: it fires on the
  transition into "merge ready" (PR open, CI not failing, review
  approved-or-none, and mergeable). A PR first observed already in that
  state counts as a transition and fires once; it does not re-fire on
  later updates while it stays merge-ready.
- `pr.merged` fires the same way: once, on the transition into merged
  (including a PR first observed already merged).
- A new head SHA on an already-triggered PR cancels the stale in-flight run
  (marked `outdated`) and rearms the loop for the new SHA, riding the same
  `pr.updated` event.

## CLI commands

```
ao pipeline list [--project ID] [--json]
ao pipeline runs [--project ID] [--pipeline NAME] [--status STATE] [--limit N] [--json]
ao pipeline show <runId> [--project ID] [--json]
ao pipeline run <pipeline-ref> [--project ID] [--session ID] [--head-sha SHA] [--json]
ao pipeline cancel <runId> [--project ID]
ao pipeline resume <runId> [--project ID]
```

`--project` falls back to `AO_PROJECT_ID`, then the CLI's usual
cwd/session-based project resolution. `--status` filters `runs` by loop
state (`running`, `awaiting_context`, `done`, `stalled`, `terminated`).
`pipeline run` accepts either a pipeline id or its name.

```bash
ao pipeline runs --pipeline pr-review --status stalled
ao pipeline run pr-review --head-sha abc1234
ao pipeline resume run_01hz...
```

## Where findings land

A stage (agent or command) is expected to write findings to
`.ao/pipeline-findings.jsonl` inside its workspace, one JSON object per
line, using the write-to-temp-then-rename convention (`pipeline-findings.jsonl.tmp`
renamed onto the final path) so the executor never observes a torn write.
For an agent stage the executor polls until the session goes idle AND the
file exists, then harvests it and kills the session; for a command stage
the harvest runs once the process exits with a completed outcome (see
Command result modes below). Harvesting streams the file up to a 5MB cap
(`findingsFileSizeCapBytes`): a torn, unterminated final line is tolerated
and dropped, a malformed complete line fails the whole harvest, and file
existence (not contents) is the completion signal, so an empty renamed
file means "no findings." Exceeding the cap does not fail the stage; it
sets a `pipeline.findings.truncated` observation (stage name, path, cap,
bytes read) and a matching stage note, and stops reading at the cap.

Each JSONL line is one of three kinds:

```json
{
	"kind": "finding",
	"filePath": "backend/internal/foo.go",
	"startLine": 12,
	"endLine": 18,
	"title": "Unchecked error",
	"description": "err is discarded",
	"category": "correctness",
	"severity": "warning",
	"confidence": 0.8
}
```

- **`{kind:"finding"}`**: `filePath`, `startLine`, `endLine`, `title`,
  `description`, `category` (free-form, e.g.
  `security`/`correctness`/`style`/`general`), `severity`
  (`error`/`warning`/`info`), and `confidence` (a float in `[0, 1]`) are all
  required; `anchorSignature` is optional and keeps the finding's
  fingerprint stable across rounds. A missing required field or an
  out-of-range confidence fails that record (and the harvest).
- **`{kind:"status", fingerprint, status}`**: a stage's request to flip an
  existing finding's lifecycle status by its stable fingerprint (e.g. a
  verify stage resolving what an earlier review stage found). `status` must
  be `open`, `resolved`, or `dismissed` (`sent_to_agent` is engine-internal
  and never authored here). Both fields are required; a bad status fails
  the harvest. A fingerprint that matches no finding in the run is
  _tolerated_, not rejected: it emits a `pipeline.status.unknown_fingerprint`
  observation and a stage note rather than failing the stage. Status
  changes are applied before the run's exit decision, so a verify stage
  resolving a finding can flip `no_open_findings` in the same round.
- **`{kind:"json", data:{...}}`**: a free-form artifact carrying an object
  `data`; used by `answer`-mode stages. Not mirrored into `run.findings`
  (only `finding`-kind artifacts are).

## Command stage result modes

A `command` stage's exit is interpreted one of two ways, chosen by what the
process wrote to stdout:

- **Envelope mode.** If trimmed stdout parses as a JSON object with an
  `outcome` field, it is treated as the historical command-task envelope:
  `{"outcome": "succeeded"|"failed"|"neutral"|"skipped", "verdict"?:
"pass"|"fail"|"neutral", "artifacts"?: [...], "reason"?: "..."}`. A nonzero
  exit code still fails the stage even in envelope mode (the shim crashed
  before or after writing valid JSON). `outcome: "failed"` fails the stage,
  using `reason` as the error message when present. Otherwise the stage
  completes; `verdict` is used if set, else defaulted from `outcome`
  (`succeeded` -> `pass`, `neutral`/`skipped` -> `neutral`). `outcome:
"skipped"` also adds a `command_stage_self_skipped` observation.
- **Exit-code fallback.** If stdout is not that envelope (empty, plain text,
  a JSON array, or an object without `outcome`), the raw process exit code
  is the verdict: exit 0 completes with `verdict: pass`; nonzero fails with
  a reason built from the exit code plus a stderr tail. Either way a
  `command_stage_exit_mode` observation is attached (`mode: "exit-code"`,
  the exit code), so the run detail always shows which mode decided the
  outcome.

In both modes: a stage timeout or a kill-by-signal fails the stage before
either mode is even considered; the combined stdout+stderr tail (last 64
KiB) is captured onto the stage's `output` field on every terminal outcome;
and, when the process completed, a `.ao/pipeline-findings.jsonl` drop is
harvested exactly as described above (a malformed file flips an otherwise
completed outcome to failed).

## Upstream findings in agent prompts

An agent stage whose `dependsOn` names earlier stages receives their
materialized findings as an "## Upstream findings" section injected into
its spawn prompt (built by `buildStagePrompt`), one line per finding:
severity, fingerprint, originating stage, `file:startLine-endLine`, title,
and current status. The section is capped at 100 findings with an overflow
count past the cap. This is how a `summarize`/`verify`-style downstream
stage can reference a specific finding by fingerprint and emit a
`{kind:"status"}` record to resolve or dismiss it. The prompt also always
carries a "## Reporting Findings" block explaining the JSONL contract
(write-to-temp, rename, the finding/status record shapes for the stage's
mode) and, when the run has a PR, a "## Pull request" block (see below).

## PR context available to stages

When a run is backed by a PR, its identity flows to every stage:

- **Agent stages** spawn on the PR's source branch (`Branch:
in.Context.SourceBranch` in the spawn request), so a review/code session
  sees the PR diff and can push directly to it; a collision with an
  already-checked-out branch falls back to a stage-run-id-suffixed branch
  name. The prompt's "## Pull request" block renders whichever of these
  fields the run context carries: `Number: #<n>`, `URL: <url>`, `Branch:
<source> -> <target>`, `Head SHA: <sha>`. A manual run with no PR omits
  the block entirely.
- **Command stages** get the same facts as environment variables
  (`pipelineEnv`), always alongside `AO_PIPELINE_RUN_ID` and
  `AO_PIPELINE_STAGE`:

  | Variable             | Set when           |
  | -------------------- | ------------------ |
  | `AO_PIPELINE_RUN_ID` | always             |
  | `AO_PIPELINE_STAGE`  | always             |
  | `AO_PR_NUMBER`       | `PRNumber > 0`     |
  | `AO_PR_URL`          | `PRURL` set        |
  | `AO_PR_BRANCH`       | `SourceBranch` set |
  | `AO_PR_BASE_BRANCH`  | `TargetBranch` set |
  | `AO_PR_HEAD_SHA`     | `HeadSHA` set      |

  Unset PR fields are omitted entirely rather than passed as empty strings.
  A stage's own `executor.env` is applied last and wins on any key
  collision.

This context (`RunContext`) is populated once at trigger time, from the CDC
trigger bridge's `PRFacts` lookup for a PR-driven run, or from the session
and head SHA a manual run supplies, and is persisted as part of the run so
every stage attempt sees the same facts.

## Per-PR loop identity and same-SHA dedup

Each pipeline "loop" (the persistent per-session, per-pipeline run
sequence) is keyed by `LoopKeyFor`, not just session+pipeline name:

- a PR-backed run keys as `sessionID:pipelineName:prURL`, so sibling PRs
  driven off the same session and pipeline never collide, a new SHA on
  PR-B cannot cancel or continue PR-A's in-flight run;
- a manual run scoped to a session keys as `sessionID:pipelineName` (the
  pre-PR-context shape, which older persisted runs also degrade to);
- a manual run with no session keys as `run:<runID>` so unscoped manual
  runs never share a global key and no-op each other.

Within one PR's loop, the reducer also dedups by exact head SHA: a
non-manual trigger (`pr.opened`/`pr.updated`/`pr.merge_ready`/`pr.merged`)
whose SHA already produced a _settled_ run (`done` or `stalled`; not
`outdated`/`cancelled`/`config_change`) is a no-op, emitting a
`pipeline.run.trigger_deduped` observation instead of spawning a duplicate.
This absorbs CI flapping and fact-only `pr.updated` churn on an unchanged
SHA. A manual trigger always fires, even at an already-run SHA, since a
human explicitly asked. Only settled runs count toward `loop_rounds_at_least`;
a run cut short by outdated/cancel/config-change is not a round.

## Deadlines, retries, honest exits

- **Stage timeout.** `Stage.TimeoutMs` is a per-stage deadline; when unset
  (or non-positive) the engine falls back to `DefaultStageTimeout`, which is
  **30 minutes** (`pipeline.DefaultStageTimeout`, in `reducer.go`). The
  deadline is stamped at `STAGE_STARTED` (`StartedAt + timeout`) and cleared
  on retry/re-pend; a periodic `Tick` event fails any running stage whose
  deadline has passed, so a wedged executor cannot leave a run running
  forever.
- **Retries.** `Stage.Retries` (default nil, meaning no automatic retry) is
  a budget of _additional_ attempts: `retries: 2` allows up to 3 attempts
  total. A failed stage within budget is silently re-pended with a fresh
  `stageRunId` and `attempt+1` and re-enters the scheduler; a
  `pipeline.stage.retried` observation is emitted either way. Retries apply
  uniformly to timeouts, non-zero exits, and executor errors.
- **`maxLoopRounds`.** `Stage.MaxLoopRounds` caps how many _loop rounds_ (not
  attempts) a stage may run for across a PR's whole loop; once the run's
  `loopRounds` exceeds the cap the stage is skipped instead of started, with
  a `pipeline.stage.skipped_max_rounds` observation. It is per-stage, not
  pipeline-global.
- **Honest exits.** Once every stage in a run reaches a terminal status, the
  run's exit is decided by `decideRunExit`: with no `exitPredicates`
  configured, any failed stage means `stalled`/`stage_failure`, otherwise
  `done`/`completed` (the v0 default). With `exitPredicates.done` configured,
  the run is _never_ reported `done`/`completed` unless that predicate is
  actually true. If `done` is configured but evaluates false (and `stalled`,
  if any, does not fire), the run terminates as `stalled` with the distinct
  reason `done_predicate_unmet` (`pipeline.TerminationDonePredicateUnmet`) so
  a stage that finished without satisfying its own success condition (e.g.
  open findings remain) is never dishonestly reported as completed.
  Stall-window convergence (`policy.stallWindow`, the same fingerprint set
  repeating across the window) is checked before exit predicates and, when
  it fires, terminates as `stalled`/`converged` instead.

## Merge blocking and dismissing findings

- **`blocksMerge` end to end.** At a run's terminal transition (any of
  `done`, `stalled`, or `terminated` that isn't outdated/manually-cancelled/
  config-changed), `runBlocksMerge` sets `RunState.BlocksMerge`: true when
  any finally-failed stage's `policy.blocksMerge` is true, else when
  `exitPredicates.blocksMerge` (if configured) evaluates true against the
  run's findings/history. Runs superseded as `outdated`, cancelled by hand,
  or ended by a config change never block, since they were replaced rather
  than judged. A true result emits a `pipeline.run.blocks_merge` observation.
  The lifecycle merge-readiness check (`Service.PRBlocksMerge`, backing the
  SCM integration's merge gate) looks up the most recent _settled_ run for
  the PR's URL and only honors its `BlocksMerge` when that run's `HeadSHA`
  still matches the PR's current head; a stale-SHA or absent run is treated
  as no opinion (`false`), so pipelines never fabricate a stale block.
- **Dismiss flow.** `POST /api/v1/pipelines/runs/{runId}/artifacts/{artifactId}/status`
  (`?project=<id>` required) takes `{"status": "open"|"resolved"|"dismissed"}`
  and drives the same lifecycle a `{kind:"status"}` JSONL record would,
  dispatched as an `ArtifactStatusChanged` event with `actor: "user"`. The
  reducer updates the finding's status in `run.Findings`, persists an
  `UpdateArtifactStatus` effect, and emits a `pipeline.artifact.status_changed`
  observation; the call is synchronous on the engine actor, so the response
  reflects the new status immediately. `sent_to_agent` is not a settable
  target from this route (or from a findings-file status record); it is
  engine-internal.

## Fork-PR trust gate and per-stage diagnostics

`allowForkPRs` (pipeline-level, default false) gates **every** executor
kind uniformly, agent, command, and builtin alike, through one shared
helper (`forkGateDecision` / `forkFromContext` in
`backend/internal/pipeline/executors/forkgate.go`). Fork status is resolved
from `RunContext.IsFromFork` (the tri-state the trigger bridge populates
from `PRFacts`): known-true blocks unless `allowForkPRs` is set,
known-false always runs, and _unknown_ (the SCM plugin could not classify
it) is fail-safe: blocked by default, same as a known fork. A gated stage
never starts a subprocess or spawns a session; it completes immediately as
`neutral` with a `pipeline.stage.skipped_fork_pr` observation explaining
why.

Every stage's runtime state also now carries a `sessionId` (the AO session
it ran in, for agent stages; empty for command/builtin, which own no
session) and a capped list of human-readable `notes` (fork-PR skip reason,
findings-file truncation, command exit-mode fallback, an unknown status
fingerprint, and similar one-line annotations), both surfaced per stage in
the run detail response so a human can see what happened without digging
through raw observations.

## UI overview

The Pipelines section (hidden entirely when pipelines are off, see Enabling the
feature) has two tabs:

- **Definitions**: a table of the project's stored pipelines plus a
  definition editor that offers a visual canvas alongside the raw
  CodeMirror YAML editor for create/update (see Authoring in the visual
  editor below). Validation happens server-side; the editor surfaces every
  returned issue inline rather than stopping at the first one.
- **Runs**: a 5-column Kanban workbench (Running, Awaiting context, Done,
  Stalled, Terminated) grouped by loop state, filterable by pipeline name,
  spanning every project. Runs update live over the existing CDC-backed
  event stream, the same transport the rest of the app uses for
  query invalidation, no separate SSE endpoint.

A run detail view is read-only: pipeline, session, loop state, rounds, head
SHA, whether the run blocks merge, per-stage status/verdict/attempt/output/
session id/notes/artifacts, and the run's findings (each dismissible via the
artifact-status route described in Merge blocking and dismissing findings).
