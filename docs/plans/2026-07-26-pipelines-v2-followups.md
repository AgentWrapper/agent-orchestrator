# Pipelines v2 followups

Written at the close of Task 26 (end-to-end dogfood). Everything here is either
deliberately deferred, a divergence between the shipped code and the spec, or
something a live drill turned up and this task did not fix. Two things the
drills turned up **were** fixed and are not listed as open: agent stages settling
`no_signal` seconds after spawn, and `kill-on: succeeded` not covering
`succeeded_unverified`. Both are in this PR with tests.

Spec is `docs/plans/2026-07-26-pipelines-v2.md`, plan is
`docs/plans/2026-07-26-pipelines-v2-implementation.md`.

---

## Deliberately deferred

### D9: run folder GC

v2 never deletes a run folder, and it keeps every owned workspace belonging to a
run that did not succeed (spec 5.5). Confirmed live: after ten drill runs the
data dir held four kept worktrees plus every run's logs and artifacts, and
nothing in the daemon will ever reclaim them.

Disk therefore grows without bound, linearly in runs and in kept workspaces. The
policy question, deliberately left open rather than answered under deadline:

- Is the retention unit the run folder, the workspace inside it, or both? A
  workspace is by far the larger of the two (a checkout each) and by far the
  shorter-lived in usefulness; logs and artifacts stay readable at a few KB.
- Is retention by age, by count per pipeline, or by total bytes? The kept-session
  reaper already answers the same question for sessions with a cap of 3 per
  pipeline plus a 24h TTL (D7), and consistency between the two is worth more
  than picking the theoretically better rule for each.
- Is a GC'd run folder deleted or tombstoned? SQLite is the store of record (D2),
  so the run stays on the board after its folder is gone. Run detail already
  distinguishes "the agent produced nothing" from "the file is no longer on
  disk", so a tombstone is renderable, but nothing says that in the UI yet.
- Does anything GC on a schedule, or only at run start / daemon boot?

Until this is answered, a heavy user's remedy is `rm -rf ~/.ao/pipelines/<project>`,
which is safe (SQLite keeps the run rows) and undocumented.

### Credentials UI

D13 ships credential management as CLI-only: `ao pipeline credential set|rm|ls`,
values held in the daemon and injected into command-stage process env at exec
time, never echoed back. The canvas renders a stage's declared credential names
read-only. A settings surface for creating and rotating them is a later feature.
The load-bearing half (the tier separation, `credentials:` schema-forbidden on
agent stages) ships now and is what a UI would have to respect anyway.

### Spec section 2, out of scope by design

Wanted, deliberately later: cron and scheduled triggers, push-to-branch
triggers, compensating actions / rollback after a point of no return (13.3),
matrix expansion, reusable or composable pipeline fragments, hosted runner
execution (15).

Rejected rather than deferred, and not to be revisited casually: a parallel
`pipeline2/` package, cutting any part of the v1 UI, an expression language
(12.3), pasting agent output into the next stage's prompt, letting agents write
`Context.md`, per-pipeline shared context across runs, explicit per-stage
environment declaration, a `continue-on-error` equivalent, job-outputs-as-strings.
Graph cycles are rejected at validation, not merely unimplemented (9.1).

### Phase 2 items from the v1 handoff

The v1 handoff document is not in this repo (it lived alongside the v1 branch and
its "open gaps" section was superseded before v2 started), so this is sourced
from what v1 actually shipped rather than from that document. Say so rather than
inventing a list. What v1 carried that v2 has not re-answered:

- **`docs/pipelines.md` still documents v1.** Predicates, findings, loop identity
  and same-SHA dedup, retries, merge blocking and dismissing findings: all
  deleted in v2, all still in the user-facing doc, which is now wrong from the
  "Authoring a definition" section onward. No v2 task owned it. This is the most
  user-visible piece of debt in the feature and should be the next thing written.
- **Fork-PR trust UX.** D17 repurposes the v1 fork gate as the identity-only
  rule. A run over a fork PR silently gets no credentials; nothing on the run
  detail says "this run was identity-only because the PR came from a fork".
- **Telemetry.** v1 emitted pipeline events; v2 has not re-litigated what a
  pipeline run should report.

---

## Divergences between the spec and the shipped code

Precedence is spec, then the plan's Part 1 decisions, then the boring option.
These are the places where the code does not match the spec text and shipped
anyway, each with what it would cost to close.

### Agent stages do not run in the resolved workspace

The biggest one. `SessionAdapter.Spawn` carries a `ponytail:` comment saying it:
`ports.SpawnConfig` has no way to adopt an existing tree, so the session manager
creates its own worktree per session and the agent runs there, while the
driver-provisioned tree (spec 5) governs only command stages, `inherit` and
teardown.

Confirmed live: for a `workspace: run` pipeline, `run.json` recorded
`workspacePath = <run>/workspace` for the agent stage while the session actually
ran in `~/.ao/data/worktrees/scratch/scratch-2`, and `$AO_WORKSPACE` in the
session's environment named the run tree the agent was not in.

Consequences: an agent stage cannot share filesystem state with a command stage
through `workspace: run`; `workspace: stage` and `inherit` mean nothing for agent
stages (so the `diagnose-build` shape in spec 11, an agent inheriting the failed
build's tree, does not work as written); and the run tree is destroyed on success
while the session's own worktree follows session lifecycle instead.

Closing it needs `ports.SpawnConfig.WorkspacePath` plus a session teardown that
never destroys a pipeline-owned tree. That is a session-lifecycle change, not an
engine one, which is why it is here and not in this PR.

### `AO_ATTEMPT` stays 1 on the nudged attempt

Spec 12.2 says `AO_ATTEMPT` is "1, or 2 after a nudge", and the plan's Task 26
asks to verify `AO_ATTEMPT=2` in the session env. It is 1. Confirmed live: on a
nudged stage the agent dumped its own environment and got `AO_ATTEMPT=1` while
run detail showed `attempt 2 (nudged)`.

This is not a small fix, because the nudge deliberately does not relaunch the
stage (spec 7.1: the nudge works precisely because the session is still alive
with its context), and a running process's environment cannot be rewritten. The
agent learns it is on its last attempt from the nudge message itself. Options if
this matters: state it in the nudge text ("this is attempt 2 of 2"), or drop the
`AO_ATTEMPT` row from the spec's table for agent stages. Do not "fix" it by
relaunching the stage.

### Agent stages write no `stage-logs/<stage>.log`

Spec 3 says stage logs are captured for "both executors, always". Command stages
write one; agent stages write none, by design (the agent executor's own comment:
its record is the session's scrollback, which outlives the stage on every outcome
that keeps the session). Run detail renders the absence as "No log was captured
for this stage." rather than an error, so nothing is broken, but the spec
sentence is not true. Either capture the pane on settle or amend the spec line.

### `Context.md` only exists once something is indexed

Spec 3 lists `Context.md` in the run folder layout unconditionally. The engine
writes it when a stage's declared artifact verifies, so a run with no `produces:`
anywhere has no `Context.md` and `$AO_CONTEXT` names a path that does not exist.
The agent preamble handles that ("It is empty: nothing ran before you"), so this
is a documentation nit, not a defect.

### `agent-outputs/<filename>`, not `agent-outputs/<stage>.md`

Spec 3's layout sketch writes `agent-outputs/<stage>.md`; spec 6.2 says
`produces:` takes a bare filename resolving to `<run>/agent-outputs/<filename>`.
The code follows 6.2 (`produces: review.md` on stage `shirk` lands at
`agent-outputs/review.md`). 6.2 is the load-bearing text; the sketch is loose.

### Sessionless PR subjects are unreachable through the bridge

Spec 4 makes a PR subject with no session first-class, and the engine and the run
detail both handle it. The store cannot produce one: `pr.session_id` is a NOT NULL
foreign key into `sessions`, so every PR row the CDC bridge can read names a
session, and `PRBridge.process` always resolves one. The path is real in the
engine and exercised by unit tests; it has no live producer today. It becomes
reachable the moment PR discovery can record a PR nobody is working on.

---

## Found by the drills, not fixed

### A daemon on a non-default run file cannot be signalled from its own sessions

`ao pipeline done` resolves the daemon through the run file (`AO_RUN_FILE`,
default `~/.ao/running.json`), while a spawned session's environment carries
`AO_DATA_DIR` and a PATH pinned to the daemon binary but **not** `AO_RUN_FILE`.
On the first drill this sent the agent's `ao pipeline done` to the developer's
main daemon, which answered `ROUTE_NOT_FOUND`, and cost the same drill its
activity hooks for the same reason.

Harmless for a shipped single-daemon install, where the default run file is the
only one. It bites any second daemon: dogfooding, CI, a scratch instance. The
workaround used here was forwarding `AO_RUN_FILE` through the project's env
config. A real fix is to include the daemon's run file path in the session env
alongside `AO_DATA_DIR`, so a session always talks to the daemon that spawned it.

### A restart settles the stage but leaks its process

D16 reconciliation settles a lost command stage as `failed` and routes it, which
is what the drill was for. The OS process it started keeps running: after
`kill -9` on the daemon and a reboot, the stage's `sleep 300` was still alive with
nothing tracking it, and only the run folder named it. Command stages run in
their own process group, so recording the pgid alongside the stage would make a
boot-time reap possible. Until then a restart mid-run can leave work running.

### The reconciled agent stage's reason line is not true

A lost agent stage settles `no_signal` with "session exited without signalling".
The session usually has not exited: after the restart drill the session was alive
in tmux with its scrollback, correctly marked pipeline-orphaned. The engine's own
comment acknowledges it ("the session may well still be alive, but nothing in
this process is listening to it any more"); only the reason string, which is
shared with the genuine session-gone path, says otherwise. A distinct reason for
the reconciliation path would fix it.

### The nudge can tell an agent it signalled when it did not

The nudge text is chosen by whether the artifact is on disk: no artifact gets
"You signaled done but agent-outputs/X does not exist or is empty", and an
artifact that is there gets "You appear to be finished but have not signalled."
The discriminator is right for the `no_output` path, where the agent did signal.
It is wrong for the idle-without-signal path, where the agent has not claimed
anything: the first drill nudged an agent that had gone idle before writing, told
it that it had signalled, and it dutifully rewrote a file it had already written.
The reducer knows which event it is reacting to; passing that through instead of
inferring from `artifactOK` would fix the wording.

### A harness trust prompt can burn a whole deadline

Every agent stage gets a fresh session worktree, and claude-code asks for
directory trust the first time it sees a path. One drill session sat on that
dialog until its deadline and settled `timed_out` with the agent never having
read the prompt. The engine behaved correctly (that is what deadlines are for),
but the failure mode is invisible unless someone opens the pane. Worth knowing
before pipelines meet a fresh machine; a harness-level trust preseed would remove
it.

### Idle is only meaningful from a harness with hooks

The fix in this PR treats an idle reading as the spawn placeholder until the
session's first hook callback lands. For a harness with no hook pipeline that
callback never comes, so its agent stages can no longer settle `no_signal` early
and are bounded by their deadline instead. That is the honest direction (the old
behavior settled them within seconds of spawn, always) but it means a hook-less
harness wants an explicit short `deadline:` on its stages.

---

## Decision: the Go template fixtures stay

`backend/internal/pipeline/testdata/templates/*.yaml` plus `templates_test.go`
(from #322) exist because `POST /pipelines/validate` was 501 when they were
written. It is live now, and the question was whether they should become an
integration test.

They stay, unchanged. What they buy is not "validation works" (the endpoint and
its own tests cover that) but a byte-identical pin between the two sides: the TS
test asserts `serializeToYaml(template.draft())` matches these files, and the Go
test runs the real parser and the real validator over the same bytes, warnings
included. A template edited in TypeScript that stops satisfying a Go rule fails
in Go; a template edited without regenerating the fixture fails in TypeScript.
An integration test through the daemon would prove less (it could not see the
serializer) and cost more (a daemon per run). The cost of keeping them is one
regeneration step when a starter template changes, which is exactly the step the
pin exists to force.
