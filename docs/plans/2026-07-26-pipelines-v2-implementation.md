# Pipelines v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `backend/internal/pipeline` in place to the v2 design spec (`docs/plans/2026-07-26-pipelines-v2.md`), keeping the whole UI surface, replacing v1's predicate/loop/findings semantics with the frozen-run, outcome-taxonomy, run-folder model.

**Architecture:** Keep v1's proven infrastructure shape (per-project engine actor + supervisor, pure reducer + effects, executor Start/Poll/Cancel, CDC trigger bridge, gitworktree adapter, AO_PIPELINES flag) and rebuild the semantics inside it: a per-run reducer over the v2 outcome taxonomy, a plan-at-start walker, a run folder on disk, engine-written Context.md, signal-based agent settlement, engine-held credentials, and concurrency groups at the supervisor.

**Tech Stack:** Go (backend, chi, sqlc/SQLite, yaml.v3), TypeScript/React (frontend, TanStack Query, React Flow, dagre, js-yaml, openapi-fetch).

## Global Constraints

- v2 is a redo **in place of** `backend/internal/pipeline`. No `pipeline2/` package (spec §2).
- The entire UI surface stays: canvas editor, Kanban run board, definitions page, run detail, settings modal (spec §2). Widgets tied to deleted semantics (predicate builder, findings panel) are replaced by their v2 equivalents, not left dangling.
- All state under `~/.ao` only (`AO_DATA_DIR` override). Run folders: `~/.ao/pipelines/<project-id>/<run-id>/`.
- `AO_PIPELINES` flag mechanism is unchanged: env override > persisted setting > off; nil Manager means every `/api/v1/pipelines/*` route returns 501.
- Every commit compiles and passes `cd backend && go test ./...` plus `gofmt`. CI also runs golangci-lint with `revive` (no shadowing builtins like `min`, `max`, `len` as identifiers) and `prealloc` (preallocate slices with known capacity); these are not installed locally, so write to them proactively.
- Frontend verification is the **full build** (`pnpm build` at repo root or per the repo scripts), not just typecheck; rollup tree-shaking hides missing exports otherwise.
- Never `git add -A` in frontend/ (committed dead symlink under node_modules pollutes diffs); stage explicit paths.
- No em dashes or en dashes in any produced content, including code comments and commit messages.
- Commit messages: conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
- v1 never shipped (behind the flag, unreleased), so **no data migration is owed**. Destructive SQL migration of `pipeline_runs`/`pipeline_stage_runs`/`pipeline_artifacts` is acceptable. `pipeline_definitions` keeps its shape (raw YAML travels as-is); old v1 YAML simply fails v2 validation when opened, which the editor already surfaces.

---

## Part 1: Decisions

These resolve the spec's §16 open questions and the choices the code surveys forced. They are made here so no task has to re-litigate them.

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Reducer granularity | **Per-run**: `Reduce(RunState, Event) (RunState, []Effect)`. The engine actor owns the run map and the concurrency table. | v1's whole-EngineState reducer existed for loop keys and cross-run history, both deleted. Runs are independent snapshots; concurrency groups are the only cross-run state and they live in the supervisor, not the reducer. |
| D2 | `run.json`: store or projection | **SQLite stays the store of record** (persist effects, hydration on restart, CDC change_log for SSE invalidation). `run.json` is written into the run folder on every persist as a projection for humans and debugging. | The whole live-update chain (SQLite triggers, change_log, cdc.Poller, SSE, query invalidation) and the Kanban board ride SQLite. Making files authoritative would rebuild all of that for zero user-visible gain. |
| D3 | Definition store location | Definitions stay in the `pipeline_definitions` SQLite table (raw `yamlSource` + parsed snapshot). Not moved to `~/.ao/pipelines/<project>/definitions`. | The UI contract (definitions travel as raw YAML strings) is unchanged; moving the store buys nothing and risks the editor flow. The frozen copy per run (`<run>/definition.yaml`) is what the spec actually requires, and that is new. |
| D4 | `Context.md` format | Markdown, engine-appended pointer lines exactly as spec §12.1. | No evidence yet that markdown is awkward; revisit only if dogfooding says so. |
| D5 | Ambient variable names | Exactly the spec §12.2 table. v1's `AO_PIPELINE_RUN_ID`/`AO_PIPELINE_STAGE` are renamed to `AO_RUN_ID`/`AO_STAGE`. v1's `AO_PR_URL`/`AO_PR_BRANCH`/`AO_PR_BASE_BRANCH`/`AO_PR_HEAD_SHA` become `AO_PR_REPO`/`AO_PR_HEAD` per spec (keep `AO_PR_NUMBER`). | Nothing shipped, so no compat burden. One vocabulary, the spec's. |
| D6 | Default deadline | `DefaultStageDeadline = 30 * time.Minute` (same constant v1 used). Overridable via `defaults.deadline` and per-stage `deadline`. | Placeholder in spec; 30m already proved workable in v1 tests. |
| D7 | Reaper bounds | Fixed constants: `MaxOrphanedSessionsPerPipeline = 3` (LRU), `OrphanTTL = 24 * time.Hour`. Not configurable. | Spec leans fixed; configurability is a later knob if dogfooding demands it. |
| D8 | Stage worktree provisioning | **Lazy**: provisioned by the driver when the stage's `StartStage` effect executes, never ahead of time. | Fan-outs already start concurrently, so eager provisioning saves nothing; lazy means a skipped branch never pays checkout cost. |
| D9 | Run folder GC | Deferred. v2 ships with: owned workspaces destroyed on success, kept on failure (spec §5.5); run folders never auto-deleted. A `questions/follow-up` note lands in the plan's final task. | Spec lists it as open; do not invent policy under deadline. |
| D10 | Findings/artifacts subsystem | **Deleted**, including the `pipeline_artifacts` table, artifact HTTP endpoints, dismiss/reopen UI, fingerprinting, and `.ao/pipeline-findings.jsonl` harvesting. v2's replacement surface is `produces:` artifacts listed in run detail with download links, plus `Context.md`. | v2's contract is one declared artifact verified by the engine. Structured findings with lifecycle states are v1 review-loop semantics with no v2 analogue (spec §2 rejects per-pipeline shared context; §6.2 defines the whole contract as `produces`). |
| D11 | Run-level status enum (Kanban) | `pending`, `running`, `succeeded`, `failed`, `cancelled`. Settled run status: `cancelled` if the run was cancelled; else `failed` if any stage settled in `{failed, no_output, no_signal, timed_out}`; else `succeeded`. `succeeded_unverified` stages still yield a `succeeded` run. | The spec defines stage outcomes but the Kanban board needs run columns. Five columns map cleanly from the eight stage outcomes. |
| D12 | Signal transport for `ao pipeline done\|fail` | CLI reads `AO_RUN_ID`/`AO_STAGE` from its own env (errors if missing, spec §6.3) and POSTs `/api/v1/pipelines/runs/{runId}/stages/{stageId}/signal` to the daemon, same auth/client plumbing as existing `ao pipeline` verbs. | Reuses the existing CLI HTTP client; no new IPC channel. |
| D13 | Credentials store | New SQLite table `pipeline_credentials(project_id, name, env_json, created_at, updated_at)`, values held only in the daemon, injected into command-stage process env at exec time. Managed via `ao pipeline credential set|rm|ls` (values never echoed back; list shows names only). No UI editor in this pass; the canvas renders declared names read-only. | Same trust level as the gh token already on disk. A secrets UI is a later feature; the tier separation (agent stages schema-forbidden) is the load-bearing part and ships now. |
| D14 | `pr.created` vs v1 `pr.opened` | Adopt spec names: `created`, `updated`, `merge-ready`, `merged` under `on.pr`. The trigger bridge maps CDC `EventPRCreated`/`EventPRUpdated` plus the existing transition detection (`isMergeReady`, merged) onto them. | Spec vocabulary wins; nothing shipped. |
| D15 | Idle detection for `no_signal`/nudge | The agent executor polls the session's activity state (as v1 already does through `SessionSpawner.Get`). `idle` without a signal, with `produces` declared, gets the one nudge via the existing `SessionMessenger.Send`; `exited` without a signal settles `no_signal` immediately (never nudged). | Both seams exist and are tested in v1; only the interpretation changes. |
| D16 | Restart reconciliation | On engine start, any stage persisted as `running` whose process/session handle is lost settles `no_signal` (agent) or `failed` (command), and the run proceeds through normal failure routing. Mirrors v1's `reconcileInflight`, retargeted at v2 outcomes. | Handles are in-process; a daemon restart cannot resume a Poll loop. Honest settle beats a stuck board. |
| D17 | Fork-PR identity rule | The v1 fork gate (`forkgate.go`, fail-safe on `ForkUnknown`) is repurposed: a fork-PR subject never blocks the run, but forces identity-only env (no `credentials:` injection anywhere in that run; command stages declaring `credentials:` settle `failed` with a stated reason at plan time). | Spec §8: outside-org PRs default to identity-only, shipped in v1 of the feature. Plan-time failure keeps the "fail the run, never silently fall back" rule. |

---

## Part 2: Disposition (cut / change / port)

### Backend `backend/internal/pipeline/` core

| v1 file | Disposition | Detail |
|---|---|---|
| `predicate.go`, `evaluator.go` | **Cut** | Expression language, rejected by spec §12.3. |
| `reducer_resume.go` | **Cut** | No resume (spec §14.1). |
| `reducer.go`, `reducer_helpers.go` | **Cut, patterns ported** | Loop rounds, convergence, exit decisions, findings materialization all die. Port: copy-on-write purity discipline (and the no-mutate-input test), deadline/Tick enforcement shape, deterministic attempt IDs. |
| `scheduler.go` | **Cut, replaced** | v1 scheduled from a homogeneous dependsOn DAG with predicate gates. v2 transition logic (on_success fan-out, needs joins, cascading skip, failure first-arrival) is written fresh inside the per-run reducer. |
| `types.go` | **Cut, rewritten** | Scope, TaskMode, BuiltinName, WorkspaceMode(2), Verdict, Severity, Artifact*, LoopState, per-stage triggers, budget/policy/retries/maxLoopRounds all die. New v2 types in Task 3. |
| `events.go` | **Changed** | Sealed Event/Effect union pattern ports verbatim; the concrete vocabulary is new (Task 4). |
| `config.go` | **Changed** | Strict yaml.v3 `KnownFields(true)` decode + collect-all-issues `ValidationError{Issues}` harness ports; every rule is rewritten for the v2 schema (Task 2). |
| `dag.go` | **Port** | 3-color iterative cycle detector; retarget edge collection to `on_success` and `on_failure`. |
| `ids.go` | **Port** | Typed string IDs; keep `ID`, `RunID`; `StageRunID`, `ArtifactID` die. |
| `schema.go` + `schema.json` | **Changed** | go:embed + defensive copy idiom ports; schema.json rewritten for v2 shape. |
| `store_types.go` | **Changed** | `Definition{ID, ProjectID, Name, YAMLSource, Config, ...}` survives with `Config` being the v2 `Pipeline`; `RunFilter` gets v2 statuses. |
| `validation.go` | **Cut** | TaskModeResolver/agent-mode validation is agent-taxonomy machinery, rejected by spec §6.2. |

### Backend `engine/`, `executors/`, `triggers/` and platform

| Area | Disposition | Detail |
|---|---|---|
| `engine/engine.go` actor + mailbox + tick loop | **Port shape, rewrite internals** | Single-goroutine actor, `do(func())`, 2s ticker, inflight handle map: all keep. Effect walk and hydration retarget to v2 state (Task 15). |
| `engine/supervisor.go` | **Port + extend** | Per-project lazy engines keep; gains the concurrency-group table and the orphan reaper (Tasks 14, 16). |
| `engine/adapters.go` | **Port + extend** | DI seams (`SessionSpawner`, `CommandSessions`, `SessionMessenger`) keep; `ArtifactStore` seam dies; workspace-provisioner seam added. |
| `executors/executor.go` (`StageExecutor`, `Handle`, `Set`) | **Port shape** | Start/Poll/Cancel contract and owner-tagged handles keep; `StartInput` rewritten (Task 8). |
| `executors/agent.go` | **Rewritten** | Findings polling dies. New: spawn with env, poll for signal/idle/exit, nudge, kill-on (Task 10). |
| `executors/command.go` | **Changed** | Runner plumbing and capped capture keep; JSON stdout envelope dies (exit code is the outcome); env names change; full log streamed to `<run>/stage-logs/<stage>.log` (Task 8). |
| `executors/builtin.go` | **Cut** | No builtin executor kind in v2. |
| `executors/findings.go`, `stageprompt.go` | **Cut** | Findings harvesting and the findings-instruction prompt block die. A much smaller v2 prompt preamble (ambient pointers) replaces stageprompt (Task 10). |
| `executors/forkgate.go` | **Changed** | Becomes the identity-only rule (D17), not a skip gate. |
| `executors/runner*.go` | **Port** | `CommandRunner`, process-group kill, `capBuffer` port as-is. |
| `triggers/bridge.go` | **Changed** | Non-blocking enqueue + worker goroutine + transition snapshot pattern ports; vocabulary moves to pipeline-level `on:` and v2 names; a sibling session-event bridge is added (Task 13). |
| `adapters/workspace/gitworktree` | **Port + generalize** | Create/Destroy/ForceDestroy reused for run/stage workspaces with a run-scoped key scheme (Task 7). No new adapter. |
| `session_manager` spawn env | **Extend** | `ports.SpawnConfig` gains `Env map[string]string`, merged into `runtimeEnv` (Task 9). Required for `ao pipeline done` to resolve itself. |
| `storage/sqlite` pipeline store | **Rewritten** | New tables and hydration for v2 state; artifacts table dropped (Task 17). |
| `httpd/controllers/pipelines.go` | **Changed** | resume + artifact endpoints die; signal, log, output endpoints added; DTOs rewritten (Task 18). |
| `cli/pipeline.go` | **Changed** | `resume` dies; `done`, `fail`, `credential` added; `show` renders v2 outcomes (Task 19). |
| `daemon/pipelines_flag.go`, `pipeline_wiring.go` | **Port** | Flag precedence untouched; `startPipelineEngine` wires the new constructor set. |
| CDC event types | **Port + extend** | `pipeline_definition_changed`/`pipeline_run_updated`/`pipeline_stage_run_updated` keep; `pipeline_artifact_updated` dies with its table; session orphan updates ride the existing `session` events. |

### Frontend

| File | Disposition |
|---|---|
| `lib/pipeline-draft.ts` | **Rewritten**: v2 AST (Task 20). Highest-leverage file; everything derives from it. |
| `lib/pipeline-graph.ts` | **Rewritten**: two edge kinds, needs indicators, state-machine cycle check (Task 20). |
| `components/PredicateBuilder.tsx`, `PredicateBuilderModal.tsx`, `lib/predicate-summary.ts`, `lib/predicate-text.ts` | **Cut** (no expression language). |
| `components/PipelineCanvas.tsx`, `StageInspector.tsx` | **Rewritten** for v2 stage schema and edges (Task 21). |
| `components/PipelineSettingsModal.tsx` | **Rewritten**: triggers, concurrency, defaults (Task 22). |
| `lib/pipeline-templates.ts` | **Rewritten** in v2 shape, same three concepts (Task 22). |
| `lib/pipeline-display.ts` | **Rewritten**: 8-outcome stage palette, 5-column run statuses (Task 23). |
| `components/PipelineRunCard.tsx`, `PipelineWorkbench.tsx`, `PipelineFilterBar.tsx` | **Changed lightly**: new tones/columns; shell logic keeps (Task 23). |
| `components/PipelineRunDetail.tsx` | **Rewritten**: outcome badges, attempts/nudge, log + output links, orphaned-session affordance; findings panel dies (Task 24). |
| `components/SessionsBoard.tsx`, `Sidebar.tsx` session list | **Extended**: pipeline-orphaned badge + kill (Task 25). |
| `hooks/usePipelineDefinitions.ts`, `usePipelineRuns.ts`, `usePipelineDraft.ts` | **Changed mechanically** after schema regen. |
| `hooks/usePipelinesEnabled.ts`, `usePipelinesSetting.ts`, `PipelinesSection.tsx`, all 4 route files, `useStageSelection.ts`, `NewPipelineModal.tsx`, `api-client.ts` core, `event-transport.ts` structure | **Untouched** (representation-agnostic). |

---

## Part 3: Target file map (backend/internal/pipeline after v2)

```
backend/internal/pipeline/
  ids.go            typed IDs (ported)
  definition.go     v2 config structs + YAML parse (replaces config.go's types half)
  validate.go       edit-time validation rules, Issue/ValidationError (replaces config.go's rules half + validation.go)
  dag.go            cycle detector (ported, retargeted)
  outcome.go        Outcome, RunStatus enums + helpers
  subject.go        Subject, SubjectKind, scope-identity resolution
  state.go          RunState, StageState (replaces types.go runtime half)
  plan.go           ComputePlan: reachability, effective deadlines, workspace validity
  events.go         v2 Event/Effect sealed unions
  reducer.go        per-run Reduce + transition logic (subsumes v1 scheduler.go)
  runfolder.go      run folder layout, frozen definition, run.json projection
  context.go        Context.md append + produces verification
  schema.go         go:embed (ported)
  schema.json       rewritten v2 JSON Schema
  store_types.go    Definition, RunFilter (v2 shapes)
  engine/           actor, supervisor (+concurrency groups, reaper), adapters
  executors/        executor.go, agent.go, command.go, forkgate.go, runner*.go, workspace.go
  triggers/         prbridge.go, sessionbridge.go
```

---

## Part 4: Tasks

Phases: A teardown, B core model, C execution, D orchestration, E frontend, F validation. Tasks inside a phase are sequential unless noted. Each task ends green (`cd backend && go test ./...`, and for frontend tasks the full build).

---

### Task 1: Strip v1 to a compiling skeleton

**Files:**
- Delete: `backend/internal/pipeline/{predicate.go, predicate_test.go, evaluator.go, evaluator_test.go, reducer.go, reducer_test.go, reducer_helpers.go, reducer_resume.go, reducer_resume_test.go, reducer_blocksmerge_test.go, reducer_loopkeys_test.go, scheduler.go, scheduler_test.go, enforcement_test.go, engine_test_helpers_test.go, fingerprint_test.go, validation.go, validation_test.go, events.go, types.go, config.go, config_test.go, schema_test.go}`
- Delete: `backend/internal/pipeline/executors/{builtin.go, builtin_test.go, findings.go, findings_test.go, stageprompt.go, stageprompt_test.go, agent.go, agent_test.go, command.go, command_test.go, executor.go, executor_test.go, forkgate.go, forkgate_test.go}` (runner*.go files stay)
- Delete: `backend/internal/pipeline/engine/{engine.go, engine_test.go, adapters.go, adapters_test.go, supervisor.go}` (recreated in later tasks; deleting now avoids carrying dead references)
- Delete: `backend/internal/pipeline/triggers/{bridge.go, bridge_test.go}`
- Keep: `ids.go` (trim to `ID`, `RunID`), `dag.go` + `dag_test.go` (temporarily adjust to a local edge-list input, see below), `schema.go`, `schema.json` (stale content is fine until Task 2), `store_types.go` (trim `Definition.Config` to `any` placeholder until Task 2 lands the v2 `Pipeline`).
- Modify: `backend/internal/service/pipeline/pipeline.go`, `backend/internal/storage/sqlite/store/{pipeline_store.go, pipeline_hydrate.go}`, `backend/internal/httpd/controllers/pipelines.go`, `backend/internal/cli/pipeline.go`, `backend/internal/daemon/pipeline_wiring.go`: comment-free minimal stubs. The controllers keep their routes registered but every handler returns `apispec.NotImplemented` (same body the nil-Manager path already produces). `startPipelineEngine` becomes a no-op that logs "pipelines v2: engine not yet wired".
- Modify: `dag.go`: change signature to `FindFirstCycle(order []string, edges map[string][]string) []string` (pure edge-list input, no `Stage` dependency) and update `dag_test.go` accordingly.

**Interfaces:**
- Produces: a repo where `go test ./...` passes, `AO_PIPELINES=on` daemon boots, and every pipelines route returns 501. `FindFirstCycle(order []string, edges map[string][]string) []string` for Task 2.

**Steps:**
- [ ] **Step 1:** Delete the files listed above. Run `cd backend && go build ./...` and fix every compile error by stubbing (not adapting) the four dependent packages: handlers return `apispec.NotImplemented`, store methods return `errors.New("pipelines v2: not implemented")`, CLI verbs print the same, `pipeline_wiring.go` no-ops.
- [ ] **Step 2:** Rewrite `dag.go`/`dag_test.go` to the edge-list signature. Test cases to keep: no cycle, simple cycle, self-loop skipped, deterministic first-cycle order.
- [ ] **Step 3:** `cd backend && go test ./...` until green. Grep for leftover references: `grep -rn "pipeline\." backend/internal/{service,storage,httpd,cli,daemon} | grep -v _test` and confirm only stubs remain.
- [ ] **Step 4:** Boot check: `AO_PIPELINES=on` start the daemon, `curl` `/api/v1/pipelines` expecting 501.
- [ ] **Step 5:** Commit: `refactor(pipelines): strip v1 core to compiling skeleton for v2 rebuild`

---

### Task 2: v2 definition schema, parsing, edit-time validation

**Files:**
- Create: `backend/internal/pipeline/definition.go`, `backend/internal/pipeline/validate.go`
- Create: `backend/internal/pipeline/definition_test.go`, `backend/internal/pipeline/validate_test.go`
- Modify: `backend/internal/pipeline/schema.json` (full rewrite), `store_types.go` (`Definition.Config Pipeline`)

**Interfaces:**
- Produces (exact, later tasks depend on these):

```go
type ExecutorKind string // "agent" | "command"
type WorkspaceKind string // "" (unset) | "auto" | "inherit" | "session" | "run" | "stage" | "checkout"
type PREvent string      // "created" | "updated" | "merge-ready" | "merged"
type SessionEvent string // "idle" | "exited" | "blocked"
type ConcurrencyScope string // "" | "pr" | "session" | "project"

type Pipeline struct {
    Name        string          `yaml:"name"`
    On          TriggerSpec     `yaml:"on"`
    Concurrency ConcurrencySpec `yaml:"concurrency"`
    Defaults    DefaultsSpec    `yaml:"defaults"`
    Stages      []Stage         `yaml:"stages"`
}
type TriggerSpec struct {
    PR      []PREvent      `yaml:"pr"`
    Session []SessionEvent `yaml:"session"`
}
type ConcurrencySpec struct {
    Scope            ConcurrencyScope `yaml:"scope"`
    Group            string           `yaml:"group"`
    CancelInProgress bool             `yaml:"cancel-in-progress"`
}
type DefaultsSpec struct {
    Deadline  time.Duration `yaml:"deadline"`   // yaml "45m" via custom unmarshal
    OnFailure string        `yaml:"on_failure"`
}
type SessionSpec struct {
    KillOn []Outcome `yaml:"kill-on"` // nil means default [succeeded, failed]; empty list means never
}
type Stage struct {
    ID          string        `yaml:"id"`
    Executor    ExecutorKind  `yaml:"executor"`
    Agent       string        `yaml:"agent"`
    Prompt      string        `yaml:"prompt"`
    Produces    string        `yaml:"produces"`
    Session     *SessionSpec  `yaml:"session"`
    Run         string        `yaml:"run"`
    Credentials []string      `yaml:"credentials"`
    Workspace   WorkspaceKind `yaml:"workspace"`
    Deadline    time.Duration `yaml:"deadline"`
    OnSuccess   StageList     `yaml:"on_success"` // scalar or list in YAML
    OnFailure   string        `yaml:"on_failure"`
    Needs       []string      `yaml:"needs"`
}
type StageList []string // custom UnmarshalYAML: accepts "x" or ["x","y"]

func ParseDefinition(src []byte) (*Pipeline, error)               // strict decode + Validate
func Validate(p *Pipeline) (warnings []Issue, err error)          // err is *ValidationError
func (p *Pipeline) StageByID(id string) *Stage
func (p *Pipeline) EntryStage() *Stage                            // first in document order
func (s *Stage) EffectiveDeadline(d DefaultsSpec) time.Duration   // stage > defaults > 30m
func (s *Stage) EffectiveKillOn() []Outcome                       // nil session/kill-on => {succeeded, failed}
```

- `Issue{Path, Message string}` and `ValidationError{Issues []Issue}` port from v1 verbatim (collect all issues, one pass).
- Consumes: `FindFirstCycle` from Task 1, `Outcome` from Task 3 (define the `Outcome` string type and constants in this task inside `outcome.go` if implementing Tasks 2 and 3 out of order; the two tasks may land in either order but both before Task 4).

**Validation rules (spec §13, errors):** unknown stage id in `on_success`/`on_failure`/`needs`/`defaults.on_failure`; graph cycle over `on_success ∪ on_failure` edges (via `FindFirstCycle`, with the one carve-out: the `defaults.on_failure` target does not implicitly self-edge, spec §9.4); `needs` missing on a stage with >1 inbound success edge; `needs` set not exactly equal to the inbound success edge set (failure edges never counted); `workspace: inherit` on a stage with >1 inbound success edge; `credentials` present on an agent stage; `produces` containing a path separator (`/` or `\`); `produces` on a command stage; unknown `concurrency.scope` value; unknown executor kind; duplicate stage ids; empty `stages`; agent stage missing `agent` or `prompt`; command stage missing `run`; `kill-on` containing an unknown outcome; trigger spec with neither `pr` nor `session` events and no events at all is allowed (manual-only pipeline) but unknown event names are errors.

**Warnings:** neither `defaults.on_failure` nor per-stage `on_failure` everywhere (spec §9.4); `workspace: session` under a `pr.*` trigger (spec §5.3).

**Steps:**
- [ ] **Step 1:** Write `definition_test.go`: round-trip the spec §11 worked example verbatim (it is the canonical fixture; embed it as a testdata file `backend/internal/pipeline/testdata/release.yaml`), assert parsed fields (stage count 12, `prepare` fan-out list of 4, `verify-digests` needs 3, `sign-macos` credentials). Add scalar-vs-list `on_success` cases, duration parsing, unknown-key rejection (`KnownFields`).
- [ ] **Step 2:** Run, watch fail, implement `definition.go`. Run to green.
- [ ] **Step 3:** Write `validate_test.go`: one test per rule above (table-driven, each case a minimal YAML and the expected `Issue.Path`), plus: the §11 example validates clean with exactly one warning-free result; a `needs` mismatch reports the exact missing/extra ids in the message; multi-issue collection returns all issues in one error.
- [ ] **Step 4:** Implement `validate.go` to green. Mind prealloc lint on issue slices.
- [ ] **Step 5:** Rewrite `schema.json` to mirror the v2 shape (keep the hand-maintained-mirror comment and `schema_test.go` style enum-coverage check; recreate `schema_test.go` asserting every `Outcome`, `WorkspaceKind`, `PREvent`, `SessionEvent`, `ConcurrencyScope` constant appears in the schema text).
- [ ] **Step 6:** `go test ./internal/pipeline/...` green. Commit: `feat(pipelines): v2 definition schema, parser, and edit-time validation`

---

### Task 3: Outcomes, subject, run state, plan-at-start

**Files:**
- Create: `backend/internal/pipeline/outcome.go`, `subject.go`, `state.go`, `plan.go`
- Create: `backend/internal/pipeline/plan_test.go`, `outcome_test.go`

**Interfaces:**
- Produces:

```go
type Outcome string
const (
    OutcomePending             Outcome = "pending"
    OutcomeRunning             Outcome = "running"
    OutcomeSucceeded           Outcome = "succeeded"
    OutcomeSucceededUnverified Outcome = "succeeded_unverified"
    OutcomeFailed              Outcome = "failed"
    OutcomeNoOutput            Outcome = "no_output"
    OutcomeNoSignal            Outcome = "no_signal"
    OutcomeTimedOut            Outcome = "timed_out"
    OutcomeCancelled           Outcome = "cancelled"
    OutcomeSkipped             Outcome = "skipped"
)
func (o Outcome) IsSettled() bool   // not pending/running
func (o Outcome) IsSuccess() bool   // succeeded || succeeded_unverified
func (o Outcome) RoutesToFailure() bool // failed, no_output, no_signal, timed_out

type RunStatus string
const (
    RunPending   RunStatus = "pending"
    RunRunning   RunStatus = "running"
    RunSucceeded RunStatus = "succeeded"
    RunFailed    RunStatus = "failed"
    RunCancelled RunStatus = "cancelled"
)

type SubjectKind string // "session" | "pr" | "project"
type Subject struct {
    Kind      SubjectKind
    ProjectID string
    SessionID string  // session subjects, and pr subjects with a tracking session
    PR        *PRRef  // pr subjects
}
type PRRef struct {
    Number     int
    Repo       string // owner/name
    URL        string
    HeadSHA    string
    HeadBranch string
    BaseBranch string
    FromFork   bool
}
func (s Subject) ScopeIdentity(scope ConcurrencyScope) string // pr => repo#number, session => sessionID, project => projectID
func (s Subject) DefaultScope() ConcurrencyScope              // per spec §10

type EntryEdge string // "trigger" | "success" | "failure"
type StageState struct {
    ID            string
    Outcome       Outcome
    Attempt       int       // 0 until started; 1 normal; 2 after nudge
    EnteredVia    EntryEdge
    PrevStage     string    // sole success predecessor, "" at joins/entry
    FailedStage   string    // set when EnteredVia == failure
    FailedOutcome Outcome   // ditto
    SessionID     string
    WorkspaceKind WorkspaceKind // resolved, never "auto"/"inherit"/""
    WorkspacePath string
    DeadlineAt    time.Time
    StartedAt     time.Time
    SettledAt     time.Time
    Reason        string    // fail reason / cancel reason / plan-failure reason
}
type RunState struct {
    RunID        RunID
    ProjectID    string
    PipelineID   ID
    PipelineName string
    Subject      Subject
    Status       RunStatus
    RunDir       string
    Def          Pipeline            // frozen snapshot
    Stages       map[string]*StageState
    Nudged       map[string]bool     // stage id -> nudge spent
    CancelReason string
    CreatedAt, UpdatedAt, SettledAt time.Time
}

type Plan struct {
    Reachable   []string                    // document order
    Deadlines   map[string]time.Duration    // effective per stage
    Workspaces  map[string]WorkspaceKind    // resolved default per entry semantics, "inherit" left symbolic for failure entries
}
func ComputePlan(def *Pipeline, subject Subject) (*Plan, error)
```

- `ComputePlan` walks from `EntryStage()` over `on_success ∪ on_failure ∪ defaults.on_failure`, enumerates reachable stages, computes effective deadlines, resolves workspace defaults (`auto` to `session` or `run` by subject; unset on failure-entered stages to `inherit`; unset on success-entered to `auto` then resolved), and **fails** (returned error carries the spec's message shape: `stage 'review' requires workspace 'session'; PR #412 has no local session`) when any reachable stage resolves `workspace: session` with `subject.SessionID == ""`.
- Consumes: Task 2 types.

**Steps:**
- [ ] **Step 1:** Write `outcome_test.go` (predicate helpers) and `plan_test.go`: §11 example reaches all 12 stages; deadline inheritance (stage > defaults > 30m constant) checked on `prepare` (no deadline, inherits default) vs `build-macos` (40m); a `workspace: session` stage with a sessionless PR subject fails with the exact message; `auto` resolves per subject; failure-entered `diagnose-build` stays `inherit` symbolic in the plan.
- [ ] **Step 2:** Run failing, implement, run green.
- [ ] **Step 3:** Commit: `feat(pipelines): v2 outcomes, subjects, run state, plan-at-start`

---

### Task 4: Reducer part 1: lifecycle transitions

**Files:**
- Create: `backend/internal/pipeline/events.go`, `reducer.go`
- Create: `backend/internal/pipeline/reducer_test.go`

**Interfaces:**
- Produces:

```go
// Events (sealed union, v1 marker-method pattern)
type Event interface{ isEvent(); When() time.Time }
type TriggerFired   struct{ Def Pipeline; Subject Subject; RunID RunID; RunDir string; Now time.Time }
type StageLaunched  struct{ Stage string; SessionID string; WorkspacePath string; Now time.Time }
type StageLaunchFailed struct{ Stage string; Reason string; Now time.Time }
type AgentSignaled  struct{ Stage string; Done bool; Reason string; ArtifactOK bool; Now time.Time } // ArtifactOK: driver stat'd $AO_OUTPUT; true when no produces declared
type CommandExited  struct{ Stage string; ExitCode int; Now time.Time }
type SessionIdle    struct{ Stage string; ArtifactOK bool; Now time.Time } // idle without signal
type SessionGone    struct{ Stage string; Now time.Time }                  // exited without signal
type NudgeDelivered struct{ Stage string; Now time.Time }
type Tick           struct{ Now time.Time }
type CancelRequested struct{ Reason string; Now time.Time }

// Effects (sealed union)
type Effect interface{ isEffect() }
type StartStage      struct{ Stage string; Attempt int } // driver provisions workspace + launches executor
type NudgeStage      struct{ Stage string; SessionID string; Message string }
type InterruptStage  struct{ Stage string } // kill process, keep session (timed_out)
type CancelStageExec struct{ Stage string } // cancellation teardown path
type SettleSession   struct{ Stage string; SessionID string; Outcome Outcome } // driver applies kill-on / orphan
type AppendContext   struct{ Line string }
type PersistRun      struct{}
type RunSettled      struct{ Status RunStatus } // driver tears down owned workspaces (destroy on success, keep otherwise), releases concurrency slot

func Reduce(run RunState, ev Event) (RunState, []Effect)
```

- Copy-on-write: `Reduce` never mutates its input (port v1's `TestReducerDoesNotMutateInput` idea as `TestReduceDoesNotMutateInput` using a deep-copied fixture and reflect.DeepEqual).
- This task covers: `TriggerFired` (seed reachable stages `pending`, entry stage gets `StartStage`), `StageLaunched` (pending to running, stamp deadline), success settlement (`AgentSignaled{Done:true, ArtifactOK:true}` to `succeeded` or `succeeded_unverified` per `produces` presence; `CommandExited{0}` to `succeeded`), `on_success` fan-out (all targets `StartStage` when their needs are met), `needs` joins (start only when every needs entry `IsSuccess()`; if any needs entry settles non-success, the join and its downstream cascade-skip), branch end, run settlement (`RunSettled` when no stage pending or running; status per D11), `AppendContext` on verified artifact (`stage 'x' finished, its output is at agent-outputs/x.md`), `PersistRun` on every state change.
- Consumes: Tasks 2, 3.

**Steps:**
- [ ] **Step 1:** Write table-driven `reducer_test.go` part 1: linear two-stage happy path (trigger, launch, signal done, next stage starts, run succeeds); fan-out of 3 starts 3 `StartStage` effects in one reduction; join waits for all needs then starts once; join skips (cascades) when one predecessor fails and nothing routes; `succeeded_unverified` when no produces; no-mutate test.
- [ ] **Step 2:** Run failing. Implement `events.go` + `reducer.go` transition core. Green.
- [ ] **Step 3:** Commit: `feat(pipelines): v2 per-run reducer, success transitions, fan-out, joins, cascading skip`

---

### Task 5: Reducer part 2: failure routing, nudge, deadlines, cancellation

**Files:**
- Modify: `backend/internal/pipeline/reducer.go`
- Create: `backend/internal/pipeline/reducer_failure_test.go`, `reducer_nudge_test.go`

**Interfaces:**
- Produces (behavior, same `Reduce`):
  - Failure settlement: `AgentSignaled{Done:false}` to `failed` (never nudged, spec §7.1); `CommandExited{!=0}` to `failed`; `SessionGone` to `no_signal` (never nudged); routing target = stage `OnFailure`, else `defaults.on_failure`, else branch ends. Entered-via-failure stage gets `EnteredVia: failure`, `FailedStage`/`FailedOutcome` set, workspace `inherit` resolved at launch to the failed stage's tree. **First arrival wins**: a second stage routing into the same failure target while it is not pending is dropped (spec §9.3). The `defaults.on_failure` target's own failure ends the branch (spec §9.4 carve-out).
  - Nudge: `AgentSignaled{Done:true, ArtifactOK:false}` with attempt 1 emits `NudgeStage` with the exact spec §7.1 message (`You signaled done but agent-outputs/<name> does not exist or is empty.\nOverwrite it now, then signal again.`), sets `Nudged[stage]`, keeps the stage `running`, `Attempt` becomes 2 on `NudgeDelivered`. Same for `SessionIdle{ArtifactOK:false}` with produces declared. Attempt 2 with `ArtifactOK:false` settles `no_output`. `SessionIdle` with no produces declared settles `succeeded_unverified` after the one nudge disambiguation only when produces is declared; with no produces, idle-without-signal settles `no_signal` (there is nothing to verify and no signal came; nudging asks it to signal, so: with no produces, first `SessionIdle` still gets the one nudge whose message is `You appear to be finished but have not signalled. Run 'ao pipeline done' or 'ao pipeline fail --reason ...' now.`, second `SessionIdle` settles `no_signal`).
  - Deadlines: `Tick` settles any running stage past `DeadlineAt` as `timed_out`, emitting `InterruptStage` (process killed, session kept) and routing failure.
  - Cancellation: `CancelRequested` settles every pending stage `skipped` and every running stage `cancelled` with `CancelStageExec` effects, run status `cancelled`, **no** failure routing (spec §13.2).
  - Session disposition effect: every settlement of an agent stage emits `SettleSession{stage, sessionID, outcome}`; the driver decides kill vs orphan from `EffectiveKillOn()` (Task 10/16 consume this).
- Consumes: Task 4.

**Steps:**
- [ ] **Step 1:** Write `reducer_failure_test.go`: explicit on_failure route; defaults.on_failure fallback; first-arrival-wins with two builds failing into one diagnose stage (second arrival dropped, stage runs once); default-target-fails-ends-branch; timed_out routes to failure and emits InterruptStage; cancel settles pending as skipped and running as cancelled with no routing.
- [ ] **Step 2:** Write `reducer_nudge_test.go`: done+missing artifact nudges once then no_output; explicit fail never nudged; exited never nudged (no_signal); idle+produces nudges then settles by second event; nudge message text matches spec §7.1 exactly; AO_ATTEMPT semantics (Attempt 1 then 2).
- [ ] **Step 3:** Implement to green. Commit: `feat(pipelines): failure routing, nudge, deadlines, cancellation in v2 reducer`

---

### Task 6: Run folder, Context.md, run.json, artifact verification

**Files:**
- Create: `backend/internal/pipeline/runfolder.go`, `context.go`
- Create: `backend/internal/pipeline/runfolder_test.go`

**Interfaces:**
- Produces:

```go
type RunFolder struct{ Dir string }
func CreateRunFolder(baseDir, projectID string, runID RunID, defYAML []byte) (RunFolder, error)
    // makes <base>/<project>/<runID>/{agent-outputs,stage-logs}, writes definition.yaml
func (f RunFolder) OutputPath(stage *Stage) string     // <dir>/agent-outputs/<produces>
func (f RunFolder) LogPath(stageID string) string      // <dir>/stage-logs/<stageID>.log
func (f RunFolder) ContextPath() string                // <dir>/Context.md
func (f RunFolder) AppendContext(line string) error    // create-if-missing, append + newline
func (f RunFolder) WriteRunJSON(run RunState) error    // pretty JSON projection
func (f RunFolder) VerifyArtifact(stage *Stage) bool   // exists and non-empty; true when no produces
func RunWorkspaceDir(f RunFolder) string               // <dir>/workspace
func StageWorkspaceDir(f RunFolder, stageID string) string // <dir>/workspaces/<stageID>
```

- Base dir comes from the daemon config data dir: `<AO_DATA_DIR>/pipelines` (defaults under `~/.ao`). Never any other location.
- Consumes: Tasks 2, 3.

**Steps:**
- [ ] **Step 1:** Write `runfolder_test.go` against `t.TempDir()`: create writes definition.yaml byte-identical to input; VerifyArtifact false on missing, false on empty file, true on content, true when stage has no produces; AppendContext accumulates lines; WriteRunJSON round-trips through json.Unmarshal.
- [ ] **Step 2:** Implement to green. Commit: `feat(pipelines): run folder layout, Context.md writer, run.json projection`

---

### Task 7: Workspace resolver and provisioning

**Files:**
- Create: `backend/internal/pipeline/executors/workspace.go`
- Create: `backend/internal/pipeline/executors/workspace_test.go`
- Modify (only if required by key scheme): `backend/internal/adapters/workspace/gitworktree/workspace.go` (generalize the id component; prefer reusing `ports.WorkspaceConfig` with a `pipeline-<runID>[-<stage>]` pseudo-session id if path-component validation already accepts it, avoiding any adapter change)

**Interfaces:**
- Produces:

```go
type WorkspaceProvisioner interface {
    Provision(ctx context.Context, req WorkspaceRequest) (path string, owned bool, err error)
    Destroy(ctx context.Context, path string) error
}
type WorkspaceRequest struct {
    Kind        WorkspaceKind // resolved: session|run|stage|checkout|inherit
    ProjectID   string
    RunID       RunID
    StageID     string
    Subject     Subject
    InheritPath string // failed stage's tree for inherit
    BaseRef     string // subject's ref for run/stage worktrees
    RunDir      string
}
```

- Semantics: `session` resolves to the subject session's existing worktree (via `CommandSessions.Get` seam, not owned); `run` creates one worktree at `<run>/workspace` on first request and returns the same path afterwards (owned by run); `stage` creates `<run>/workspaces/<stage>` fresh per entry (owned); `checkout` returns the project's primary checkout path (not owned); `inherit` returns `InheritPath` (not owned, ownership stays with originating stage, spec §5.4). Worktrees are created from the subject's ref via the gitworktree adapter (object store shared, checkout not clone).
- Teardown policy lives with the driver (Task 15): owned paths destroyed when the run settles `succeeded`, kept otherwise (spec §5.5, §13.2).
- Consumes: Task 6 path helpers, gitworktree adapter, Task 3 Subject.

**Steps:**
- [ ] **Step 1:** Write `workspace_test.go` with a fake git layer (interface over the adapter): run workspace created once and memoized; stage workspaces distinct per stage; inherit passthrough; session resolution error when session missing (belt to Task 3's plan-time check); owned flags correct per kind.
- [ ] **Step 2:** Implement. If the gitworktree adapter's `validatePathComponent` rejects the run-scoped ids, add the minimal generalization there (a `WorkspaceConfig` id field is a name, not a session; keep the traversal guards).
- [ ] **Step 3:** Green, commit: `feat(pipelines): subject-derived workspace resolver over gitworktree`

---

### Task 8: Command executor v2

**Files:**
- Create: `backend/internal/pipeline/executors/executor.go` (v2 `StageExecutor`, `Handle`, `Set`, `StartInput`)
- Create: `backend/internal/pipeline/executors/command.go`, `command_test.go`
- Keep/consume: `runner.go`, `runner_unix.go`, `runner_windows.go`, `runner_io.go` (unchanged)

**Interfaces:**
- Produces:

```go
type StageExecutor interface {
    Start(ctx context.Context, in StartInput) (Handle, error)
    Poll(ctx context.Context, h Handle) (Poll, error)
    Cancel(ctx context.Context, h Handle) error
    Interrupt(ctx context.Context, h Handle) error // timed_out: kill process, keep session
}
type StartInput struct {
    ProjectID     string
    RunID         RunID
    RunDir        string
    Stage         Stage        // frozen copy
    Attempt       int
    Subject       Subject
    WorkspacePath string
    Env           map[string]string // fully-built ambient set (Task 15 builds it)
    Credentials   map[string]string // command stages only, resolved values
    LogPath       string
}
type Poll struct {
    State    PollState // running | signaled_done | signaled_fail | exited | idle | gone
    ExitCode int
    Reason   string
}
type Set struct{ Agent, Command StageExecutor } // owner-tagged handles as v1
```

- Command semantics: exec via `CommandRunner` with `Env` = process env + ambient + credentials (credentials last), cwd = `WorkspacePath`, stdout+stderr teed to `LogPath` (full stream to file; keep a 64KiB `capBuffer` tail in memory for the DTO). Exit 0 => `Poll{State: exited, ExitCode: 0}`; the driver maps exit codes to outcomes. **No stdout JSON envelope** (v1's `{outcome, verdict, artifacts}` protocol dies; exit status is the outcome, spec §6.1).
- Consumes: Task 7 (paths), runner port.

**Steps:**
- [ ] **Step 1:** Write `command_test.go` with a fake runner: env contains `AO_RUN_ID`, credentials only when provided, cwd correct; log file receives both streams; nonzero exit reported; Cancel kills the process group; Interrupt == Cancel for commands.
- [ ] **Step 2:** Implement to green. Commit: `feat(pipelines): v2 command executor, exit-code outcomes, stage log files`

---

### Task 9: Env plumbing into spawned sessions

**Files:**
- Modify: `backend/internal/ports/session.go` (`SpawnConfig` gains `Env map[string]string`)
- Modify: `backend/internal/session_manager/manager.go` (`runtimeEnv`/`spawnEnv` merge: base session env, then `SpawnConfig.Env`, project env still applies; spawn-config entries win over project env on collision because the engine's ambient identity must not be maskable by project config)
- Modify: whatever `SessionSpawner.Spawn`/`SpawnRequest` adapter surfaces exist between executors and session_manager (found in v1's `engine/adapters.go`; recreated in Task 15)
- Test: extend the existing session_manager spawn env test file (find via `grep -rn "runtimeEnv\|spawnEnv" backend/internal/session_manager/*_test.go`)

**Interfaces:**
- Produces: any spawned session can carry arbitrary extra env; `AO_SESSION_ID`/`AO_PROJECT_ID` behavior unchanged.
- Consumes: nothing pipeline-specific; this is a platform change usable by others.

**Steps:**
- [ ] **Step 1:** Write the failing test: spawn with `Env: {"AO_RUN_ID": "r1"}`, assert child env contains it; collision case asserts spawn-config wins over project env.
- [ ] **Step 2:** Implement the field + merge. Green across `go test ./internal/session_manager/... ./internal/ports/...`.
- [ ] **Step 3:** Commit: `feat(session): SpawnConfig.Env passthrough into session runtime env`

---

### Task 10: Agent executor v2

**Files:**
- Create: `backend/internal/pipeline/executors/agent.go`, `agent_test.go`
- Create: `backend/internal/pipeline/executors/prompt.go` (small v2 preamble builder)

**Interfaces:**
- Produces: `AgentExecutor` implementing Task 8's `StageExecutor`:
  - `Start`: spawns a worker session via the `SessionSpawner` seam with `SpawnRequest{..., Env: in.Env, Prompt: preamble + stage.Prompt}`. Preamble (short, pointer-style, no findings machinery): states the stage id, that `$AO_CONTEXT` file holds upstream pointers, the `$AO_OUTPUT` path when produces is declared, and that the agent must finish with `ao pipeline done` or `ao pipeline fail --reason "..."`. Verbatim `Context.md` content is included by pasting the file's current text into the preamble (spec §12.1 "pasted verbatim").
  - `Poll`: consults (a) the signal registry (Task 11 writes signals into the store; the executor seam receives them via a `SignalReader` interface `LatestSignal(runID, stageID) (Signal, bool)`) and (b) session activity via `SessionSpawner.Get`. Priority: signal beats activity. Maps to `Poll{State: signaled_done|signaled_fail|idle|gone|running}`.
  - `Interrupt`: sends the harness interrupt (or kills the tmux process) while leaving the session record alive.
  - `Cancel`: kills the session (used by run cancellation).
  - Nudge delivery is a driver concern: the engine executes `NudgeStage` effects via the `SessionMessenger.Send` seam (exists in v1 adapters), then feeds `NudgeDelivered` back to the reducer. The executor does not nudge.
- Consumes: Task 8 contract, Task 9 env plumbing, Task 11 `SignalReader` (define the interface here; Task 11 implements it).

**Steps:**
- [ ] **Step 1:** Write `agent_test.go` with fake spawner/messenger/signal-reader: spawn carries env and preamble; poll returns running while active and unsignaled; signaled_done wins over idle; exited maps to gone; interrupt does not kill the session record; cancel does.
- [ ] **Step 2:** Implement to green. Commit: `feat(pipelines): v2 agent executor, signal-or-activity polling, session-preserving interrupt`

---

### Task 11: Signal path: endpoint + `ao pipeline done|fail`

**Files:**
- Modify: `backend/internal/httpd/controllers/pipelines.go` (add route + handler), `backend/internal/service/pipeline/pipeline.go` (Manager method), `backend/internal/cli/pipeline.go` (verbs)
- Create: signal storage: simplest honest form is a `pipeline_stage_signals` table (run_id, stage_id, kind done|fail, reason, created_at) written by the service and read by the executor's `SignalReader`; lands with Task 17's migration, so within this task back it with an in-memory registry on the Manager guarded by a mutex, replaced in Task 17. ponytail note in code: `// ponytail: in-memory signal registry, replaced by pipeline_stage_signals in the storage task`.
- Test: `backend/internal/httpd/controllers/pipelines_test.go` (handler), `backend/internal/cli/pipeline_test.go` (env resolution)

**Interfaces:**
- Produces:
  - `POST /api/v1/pipelines/runs/{runId}/stages/{stageId}/signal` body `{"status":"done"}` or `{"status":"fail","reason":"..."}`; 404 unknown run/stage, 409 stage not running, 202 accepted.
  - CLI: `ao pipeline done` and `ao pipeline fail --reason "..."`; both read `AO_RUN_ID` and `AO_STAGE` from env and **error with a clear message when either is missing** (spec §6.3), never guessing. Reuse the existing CLI client plumbing (`c.postJSON`).
  - `type Signal struct{ RunID RunID; StageID string; Done bool; Reason string; At time.Time }` and `type SignalReader interface{ LatestSignal(RunID, string) (Signal, bool) }` satisfied by the Manager.
- Consumes: Task 10's interface definition.

**Steps:**
- [ ] **Step 1:** Handler test: done and fail accepted for a running stage; 409 otherwise; reason persisted.
- [ ] **Step 2:** CLI test: missing `AO_RUN_ID` errors mentioning the variable name; happy path POSTs the right body.
- [ ] **Step 3:** Implement, green, commit: `feat(pipelines): stage signal endpoint and ao pipeline done/fail`

---

### Task 12: Credentials store and injection

**Files:**
- Create: `backend/internal/pipeline/credentials.go` (`CredentialResolver` interface + validation hook), store methods in Task 17's file, CLI verbs in `backend/internal/cli/pipeline.go`
- Test: `credentials_test.go`

**Interfaces:**
- Produces:

```go
type CredentialResolver interface {
    Resolve(ctx context.Context, projectID string, names []string) (map[string]string, error) // flattened env
    Exists(ctx context.Context, projectID, name string) (bool, error)
}
```

  - Edit-time validation (extend Task 2's `Validate` via an optional second pass, mirroring v1's resolver-dependent `ValidateAgentModes` seam): unknown credential name is an error (spec §13). Wire into the save/validate service path, not into pure `Validate` (keeps `Validate` dependency-free).
  - Injection: Task 15's driver resolves credentials for command stages only and passes them via `StartInput.Credentials`. Fork-PR subjects (D17): plan-time failure for any reachable command stage declaring credentials.
  - CLI: `ao pipeline credential set <name> KEY=VALUE... --project <p>`, `credential ls` (names only), `credential rm <name>`.
- Consumes: Tasks 2, 3, 8.

**Steps:**
- [ ] **Step 1:** Tests: resolver-backed validation flags unknown names with path `stages[i].credentials[j]`; fork subject + credentials stage fails ComputePlan with a stated reason (add this check to `ComputePlan`, signature gains the credential name set: `ComputePlan(def *Pipeline, subject Subject, knownCreds func(string) bool) (*Plan, error)`; update Task 3 call sites).
- [ ] **Step 2:** Implement, in-memory resolver for tests. Green, commit: `feat(pipelines): engine-held credentials, resolver validation, fork identity-only rule`

---

### Task 13: Trigger bridges (PR rewrite + session new)

**Files:**
- Create: `backend/internal/pipeline/triggers/prbridge.go`, `prbridge_test.go` (rewrite of v1 bridge.go)
- Create: `backend/internal/pipeline/triggers/sessionbridge.go`, `sessionbridge_test.go`

**Interfaces:**
- Produces:
  - Both bridges follow v1's proven shape: synchronous `Broadcaster.Subscribe` callback that only filters + enqueues onto a buffered channel (cap 256, drop-and-log), one owned worker goroutine doing the blocking work.
  - PR bridge: consumes `EventPRCreated`/`EventPRUpdated`, re-reads PR facts, keeps the `prev map[string]prSnapshot` transition detector (port `isMergeReady` as-is), maps to `PREvent` values `created|updated|merge-ready|merged`, builds `Subject{Kind: pr, PR: &PRRef{...}, SessionID: <local tracking session if any>}`, and calls `EngineProvider.For(projectID).TriggerRun(TriggerRequest{...})` for each definition whose `On.PR` contains the event.
  - Session bridge: consumes `EventSessionUpdated`, detects activity transitions into `idle`/`exited`/`blocked` (its own `prev map[sessionID]ActivityState`), skips sessions that are themselves pipeline-spawned (marker from Task 16's orphan/pipeline metadata, to prevent trigger loops: a pipeline agent going idle must not fire session pipelines), builds `Subject{Kind: session, SessionID: ...}`, fires matching definitions.
  - `type TriggerRequest struct{ Definition Definition; Event string; Subject Subject }`
- Consumes: cdc broadcaster (exists), engine provider (Task 15), Task 3 Subject.

**Steps:**
- [ ] **Step 1:** Port/adapt v1 `bridge_test.go` cases to the PR bridge: transition-only merge-ready/merged, overflow drop, per-definition fan-out, event mapping.
- [ ] **Step 2:** Session bridge tests: idle transition fires once (not on every poll while idle), pipeline-spawned sessions ignored, exited and blocked map correctly.
- [ ] **Step 3:** Implement both, green, commit: `feat(pipelines): v2 PR trigger bridge and session trigger bridge`

---

### Task 14: Concurrency groups

**Files:**
- Create: `backend/internal/pipeline/engine/concurrency.go`, `concurrency_test.go`

**Interfaces:**
- Produces:

```go
type groupKey struct{ Group, ScopeIdentity string }
type ConcurrencyTable struct{ /* mutex, running map[groupKey]RunID, queued map[groupKey]pendingTrigger */ }
func (t *ConcurrencyTable) Admit(key groupKey, cancelInProgress bool, trigger pendingTrigger) Admission
// Admission: StartNow | Queued (replacing any previously queued trigger, depth 1) | CancelThenStart{Victim RunID}
func (t *ConcurrencyTable) Release(key groupKey) (next pendingTrigger, ok bool)
```

  - Key: `(group or pipeline name, Subject.ScopeIdentity(scope or subject default))` per spec §10.
- Consumes: Task 3 `ScopeIdentity`/`DefaultScope`.

**Steps:**
- [ ] **Step 1:** Tests: two PRs same pipeline run concurrently (different identities); same PR serializes; cancel-in-progress returns the victim; third arrival evicts the queued run (depth 1); release starts the queued trigger; scope default by trigger family; §11 example with `scope: project` serializes across PRs.
- [ ] **Step 2:** Implement, green, commit: `feat(pipelines): concurrency groups, cancel-in-progress, queue depth 1`

---

### Task 15: Engine actor v2 and wiring

**Files:**
- Create: `backend/internal/pipeline/engine/engine.go`, `engine_test.go`, `adapters.go`, `adapters_test.go`, `supervisor.go`
- Modify: `backend/internal/daemon/pipeline_wiring.go` (real wiring back in), `backend/internal/service/pipeline/pipeline.go` (Manager over supervisor: definitions CRUD, validate, list/get runs, trigger, cancel, signal passthrough)

**Interfaces:**
- Produces: v1's actor shape with v2 internals:
  - `Engine` per project: mailbox goroutine, `runs map[RunID]pipeline.RunState`, `inflight map[stageKey]executors.Handle`, 2s ticker driving Poll + `Tick`.
  - `TriggerRun(req TriggerRequest) (RunID, error)`: concurrency admit (Task 14), run-id allocation, run folder creation + definition freeze (Task 6), `ComputePlan` (plan failure settles the run `failed` immediately with the reason recorded and persisted; folder kept), then `TriggerFired` through the reducer.
  - Effect execution: `StartStage` (resolve workspace via provisioner, build the ambient env map here: the spec §12.2 table, including `AO_CONTEXT`, `AO_OUTPUT` when produces, `AO_PREV_*` only with exactly one predecessor, `AO_FAILED_*` on failure entry; then executor Start), `NudgeStage` (messenger send then `NudgeDelivered`), `InterruptStage`, `CancelStageExec`, `SettleSession` (kill-on decision: kill via spawner, else hand to the orphan registry, Task 16), `AppendContext`, `PersistRun` (store save + `WriteRunJSON`), `RunSettled` (teardown owned workspaces on success, keep otherwise; concurrency release; queued trigger start).
  - `Cancel(runID, reason)`, `State()` accessors for the service layer.
  - Restart: `Start(ctx)` hydrates from store, settles lost running stages per D16, resumes ticking.
  - `Supervisor.For(projectID)` unchanged shape; owns the shared `ConcurrencyTable` per project and the reaper (Task 16).
- Consumes: everything from Tasks 2 to 14.

**Steps:**
- [ ] **Step 1:** `engine_test.go` with fake executors/provisioner/store/messenger: full happy-path run (two stages, agent then command) settles succeeded with Context.md line and run.json on disk; nudge round-trip; timeout via tick; cancel mid-run; plan failure settles failed without any stage starting; restart with a lost running stage settles no_signal and routes failure; env map spot-checks (`AO_PREV_STAGE` unset at a join, `AO_FAILED_STAGE` set on failure entry).
- [ ] **Step 2:** Implement engine + adapters (spawner/messenger/command-sessions seams over session service, signal reader over Manager, credential resolver over store).
- [ ] **Step 3:** Rewire `pipeline_wiring.go` + service Manager; daemon boots with `AO_PIPELINES=on`; routes stop returning 501 for definitions CRUD (runs API still lands fully in Task 18).
- [ ] **Step 4:** Green, commit: `feat(pipelines): v2 engine actor, effect driver, ambient env, wiring`

---

### Task 16: Session disposition: orphans and reaper

**Files:**
- Modify: `backend/internal/domain/session.go` (`SessionMetadata` gains `PipelineOrphan *PipelineOrphanInfo`)
- Create: `backend/internal/pipeline/engine/orphans.go`, `orphans_test.go`
- Modify: `backend/internal/httpd/controllers/{sessions.go, dto.go}` (surface the field), session store persistence of the metadata field

**Interfaces:**
- Produces:

```go
type PipelineOrphanInfo struct {
    RunID    string    `json:"runId"`
    Stage    string    `json:"stage"`
    Outcome  string    `json:"outcome"`
    KeptAt   time.Time `json:"keptAt"`
    Pipeline string    `json:"pipeline"`
}
type OrphanRegistry struct{ /* per-pipeline LRU, cap 3, TTL 24h */ }
func (r *OrphanRegistry) Keep(ctx context.Context, pipeline string, sess PipelineOrphanInfo, sessionID string) // may evict LRU (kill it)
func (r *OrphanRegistry) Sweep(ctx context.Context, now time.Time) // TTL kills, run from supervisor ticker
```

  - `SettleSession` effect execution: outcome in `EffectiveKillOn()` kills; otherwise `Keep` marks the session metadata (persisted, so it survives restart and reaches the session list DTO) and registers for LRU/TTL. Also: sessions spawned by pipelines are marked at spawn (a `PipelineRunID` metadata field) so the session trigger bridge (Task 13) can ignore them.
- Consumes: Task 15 effect execution, session store.

**Steps:**
- [ ] **Step 1:** Tests: kill-on default kills on succeeded and failed but keeps no_output/no_signal/timed_out; `kill-on: []` never kills; 4th kept session evicts the least-recent (kill called); sweep kills past-TTL; metadata written with run id, stage, outcome.
- [ ] **Step 2:** Implement + DTO plumbing. Green, commit: `feat(pipelines): kill-on disposition, pipeline-orphaned sessions, LRU+TTL reaper`

---

### Task 17: SQLite storage v2

**Files:**
- Create: migration `backend/internal/storage/sqlite/migrations/00XX_pipelines_v2.sql` (next free number): drop `pipeline_artifacts`, recreate `pipeline_runs` and `pipeline_stage_runs` with v2 columns, create `pipeline_stage_signals`, `pipeline_credentials`; keep `pipeline_definitions`; recreate the CDC change_log triggers for the new tables (drop the artifact trigger).
- Modify: `backend/internal/storage/sqlite/store/{pipeline_store.go, pipeline_hydrate.go}`, sqlc query file + `gen` regeneration (`backend/internal/storage/sqlite/gen/pipeline.sql.go` via the repo's sqlc workflow; find it with `grep -rn sqlc backend/Makefile backend/**/*.yaml`)
- Test: `pipeline_store_test.go`

**Interfaces:**
- Produces (columns mirror Task 3 structs):
  - `pipeline_runs`: run_id PK, project_id, pipeline_id, pipeline_name, subject_kind, session_id, pr_number, pr_repo, pr_url, head_sha, from_fork, status, run_dir, cancel_reason, created_at, updated_at, settled_at
  - `pipeline_stage_runs`: run_id, stage_id (PK pair), outcome, attempt, entered_via, prev_stage, failed_stage, failed_outcome, session_id, workspace_kind, workspace_path, deadline_at, started_at, settled_at, reason, output_tail
  - `pipeline_stage_signals`: run_id, stage_id, kind, reason, created_at
  - `pipeline_credentials`: project_id, name (PK pair), env_json, created_at, updated_at
  - Store API: `SavePipelineRun(ctx, RunState) error` (upsert run + all stages in one tx), `GetPipelineRun`, `ListPipelineRuns(ctx, projectID, RunFilter)`, `HydratePipelineEngineState(ctx, projectID) ([]RunState, error)` (unsettled runs only), signal insert/latest, credential CRUD. Replace Task 11's in-memory signal registry with the table.
- Consumes: Task 3 state shapes.

**Steps:**
- [ ] **Step 1:** Store tests: save/get round-trip of a full RunState (all outcome values, subject variants); hydrate returns only unsettled; list filters by pipeline/status/limit; signal latest-wins; credential round-trip.
- [ ] **Step 2:** Migration + sqlc regen + implementation to green. Confirm CDC events fire (existing cdc tests pattern) for run/stage updates.
- [ ] **Step 3:** Commit: `feat(pipelines): v2 sqlite schema, store, hydration, signals, credentials`

---

### Task 18: HTTP API v2 + OpenAPI

**Files:**
- Modify: `backend/internal/httpd/controllers/pipelines.go` (full handler set), the OpenAPI spec source the repo generates `frontend/src/api/schema.ts` from (locate via `grep -rn "openapi" backend/ frontend/package.json`), regen `frontend/src/api/schema.ts`
- Test: `backend/internal/httpd/controllers/pipelines_test.go` (port the 501-when-off test verbatim)

**Interfaces:**
- Produces (routes; unchanged paths keep their operation ids so frontend churn stays mechanical):
  - Keep: GET/POST `/pipelines`, PUT/DELETE `/pipelines/{id}`, POST `/pipelines/validate` (now returns v2 issues + warnings array), GET `/pipelines/schema`, GET `/pipelines/runs`, POST `/pipelines/runs` (manual trigger: body gains optional `prNumber`; subject resolution server-side), GET `/pipelines/runs/{runId}`, POST `/pipelines/runs/{runId}/cancel`.
  - Remove: `/runs/{runId}/resume`, both artifact routes.
  - Add: POST `/pipelines/runs/{runId}/stages/{stageId}/signal` (Task 11); GET `/pipelines/runs/{runId}/stages/{stageId}/log` (tail query param, serves from `stage-logs/`); GET `/pipelines/runs/{runId}/outputs/{filename}` (serves `agent-outputs/`, filename validated against the run's declared produces set, no path traversal).
  - DTOs: `PipelineRunSummary{runId, pipelineId, pipelineName, status, subjectKind, sessionId?, prNumber?, headSha?, stageCount, stageOutcomes: Record<string,string>, createdAt, updatedAt, settledAt?}`; `PipelineRunDetail` adds `stages: PipelineStageView[]` where `PipelineStageView{stageId, outcome, attempt, enteredVia, failedStage?, sessionId?, workspaceKind, startedAt?, settledAt?, reason?, outputTail?, producedArtifact?: {name, exists}}`; `ValidatePipelineDefinitionResponse{valid, issues, warnings}`.
- Consumes: Tasks 15, 17.

**Steps:**
- [ ] **Step 1:** Handler tests: list/get run DTO shapes; signal 202/409; log endpoint tails; outputs endpoint rejects `..` and undeclared names; 501 flag-off preserved; validate returns warnings separately.
- [ ] **Step 2:** Implement, update OpenAPI source, regenerate `frontend/src/api/schema.ts` (commit the regenerated file; stage explicit paths).
- [ ] **Step 3:** Green backend + frontend typecheck (expect frontend compile breaks: they are fixed in Phase E, so gate this commit to backend + schema regen only if the workspace builds are separable; if not separable, land Tasks 18 and 20 in one PR-sized commit train but keep the commits distinct).
- [ ] **Step 4:** Commit: `feat(pipelines): v2 HTTP API, signal/log/output endpoints, OpenAPI regen`

---

### Task 19: CLI surface v2

**Files:**
- Modify: `backend/internal/cli/pipeline.go`, `pipeline_test.go`

**Interfaces:**
- Produces: `ao pipeline list|runs|show <runId>|run <ref>|cancel <runId>` (kept, `show` renders v2 outcomes with attempt and reason columns), `done`, `fail --reason` (Task 11), `credential set|ls|rm` (Task 12). `resume` removed.
- Consumes: Tasks 11, 12, 18.

**Steps:**
- [ ] **Step 1:** Update tests for the verb set (resume gone, done/fail env behavior already tested in Task 11), `show` golden output for a settled run with a nudged stage.
- [ ] **Step 2:** Implement, green, commit: `feat(pipelines): v2 CLI verbs, drop resume`

---

### Task 20: Frontend model: draft AST + graph

**Files:**
- Rewrite: `frontend/src/renderer/lib/pipeline-draft.ts`, `lib/pipeline-graph.ts`
- Delete: `frontend/src/renderer/components/PredicateBuilder.tsx`, `PredicateBuilderModal.tsx`, `lib/predicate-summary.ts`, `lib/predicate-text.ts`
- Modify: `lib/pipeline-problems.ts` (path mapping for new keys), `lib/pipeline-yaml.ts` (DEFAULT_PIPELINE_YAML v2 skeleton)
- Test: colocated `.test.ts` files matching the repo's existing frontend test convention (check for `lib/*.test.ts` siblings; if absent, add `pipeline-draft.test.ts` and `pipeline-graph.test.ts` under the same dir)

**Interfaces:**
- Produces (mirrors Task 2's Go schema, camelCase per yaml tags; comment at top stays "faithful TypeScript mirror of backend/internal/pipeline/definition.go"):

```ts
export type ExecutorKind = "agent" | "command";
export type WorkspaceKind = "auto" | "inherit" | "session" | "run" | "stage" | "checkout";
export type PREvent = "created" | "updated" | "merge-ready" | "merged";
export type SessionEvent = "idle" | "exited" | "blocked";
export type StageOutcome =
  | "pending" | "running" | "succeeded" | "succeeded_unverified" | "failed"
  | "no_output" | "no_signal" | "timed_out" | "cancelled" | "skipped";
export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface StageDraft {
  id: string;
  executor: ExecutorKind;
  agent?: string; prompt?: string; produces?: string;
  session?: { killOn?: StageOutcome[] };
  run?: string; credentials?: string[];
  workspace?: WorkspaceKind; deadline?: string;
  onSuccess?: string[]; onFailure?: string; needs?: string[];
}
export interface PipelineDraft {
  name: string;
  on?: { pr?: PREvent[]; session?: SessionEvent[] };
  concurrency?: { scope?: "pr" | "session" | "project"; group?: string; cancelInProgress?: boolean };
  defaults?: { deadline?: string; onFailure?: string };
  stages: StageDraft[];
}
export function parseYamlToDraft(src: string): { draft: PipelineDraft | null; parseError?: string };
export function serializeToYaml(draft: PipelineDraft): string; // prune empties, on_success scalar when length 1
```

  - `pipeline-graph.ts`: nodes stay index-identified; edges become `{kind: "success" | "failure" | "needs-implied"}`; derive success edges from `onSuccess`, failure edges from `onFailure` plus a synthetic dashed edge from stages inheriting `defaults.onFailure`; cycle detection over success+failure edges (client-side UX mirror of the server rule); dagre layout unchanged; `applyConnection(draft, from, to, kind)` writes `onSuccess`/`onFailure` and auto-maintains `needs` on the target when its inbound success count crosses 1 (mirror of the server rule so the editor produces valid YAML by construction); `effectiveDeadline(draft, stage)` helper for the canvas badge.
- Consumes: Task 18's regenerated `api/schema.ts`.

**Steps:**
- [ ] **Step 1:** Tests: YAML round-trip of the §11 release example (fixture string, same as backend testdata); scalar/list on_success; needs auto-maintenance on connect/disconnect; cycle flag on a failure loop; prune-empties serialization stability.
- [ ] **Step 2:** Rewrite both libs, delete the predicate family, fix `pipeline-problems.ts` path regexes for `stages[N].onSuccess` etc.
- [ ] **Step 3:** Frontend tests green; full build green (predicate imports gone everywhere; expect Canvas/Inspector compile errors: stub-fix minimal prop changes now if the components block the build, with real rewrites next task).
- [ ] **Step 4:** Commit: `feat(pipelines-ui): v2 draft AST and two-kind edge graph, drop predicate DSL`

---

### Task 21: Canvas + Stage Inspector

**Files:**
- Rewrite: `frontend/src/renderer/components/PipelineCanvas.tsx`, `components/StageInspector.tsx`

**Interfaces:**
- Produces:
  - Canvas: stage cards show executor badge (agent/command), produces filename chip, effective deadline badge (spec §13.1 visibility requirement), workspace chip when explicit; success edges solid (accent), failure edges dashed (destructive tone), defaults.onFailure synthetic edges dashed faint; join nodes show a `needs n` chip; the §5.3 warning icon on `workspace: session` under a `pr.*` trigger; connect gesture asks success/failure (modifier or edge-handle position, pick the simpler: two source handles per node, right = success, bottom = failure).
  - Inspector: forms per executor kind. Agent: agent picker (existing plugin list source), prompt textarea, produces input (filename validation, no separators), session kill-on multi-select over the 8 settled outcomes, deadline input. Command: run script textarea, credentials multi-select (names from a new lightweight `GET /pipelines/credentials?project=` endpoint if present; otherwise free-text chips validated server-side, choose free-text now, ponytail note), deadline. Shared: workspace select (6 values + "default" empty), onSuccess multi-select, onFailure single select, needs read-only chips (auto-maintained by graph lib, display only). All v1 fields (mode, plugin config, budget, retries, routes, policy) removed.
- Consumes: Task 20 draft/graph API. Follow DESIGN.md (clone agent-orchestrator web verbatim, shadcn primitives).

**Steps:**
- [ ] **Step 1:** Rewrite canvas against the new graph lib; keep selection/auto-layout/problems-reveal wiring intact.
- [ ] **Step 2:** Rewrite inspector; wire warning states (session-under-pr, credentials-on-agent impossible by construction since the field only renders for command).
- [ ] **Step 3:** Full build green; `ao preview` the definitions page with the release template and visually confirm edges/badges (run from inside a session so it renders in the desktop browser panel).
- [ ] **Step 4:** Commit: `feat(pipelines-ui): v2 canvas edges and stage inspector`

---

### Task 22: Settings modal, templates, entry modal

**Files:**
- Rewrite: `frontend/src/renderer/components/PipelineSettingsModal.tsx`, `lib/pipeline-templates.ts`
- Verify-only: `components/NewPipelineModal.tsx` (template source changes shape underneath it)

**Interfaces:**
- Produces:
  - Settings modal: name; triggers (pr events multi-select, session events multi-select); concurrency (scope select with subject-default hint, group text defaulting to name, cancel-in-progress switch with the §10 guidance line for pr.updated vs release pipelines); defaults (deadline, on_failure stage select).
  - Templates, three, v2-shaped: (1) PR review: `on.pr: [created, updated]`, agent review stage with `produces: review.md`, command stage posting the review, `concurrency: {scope: pr, cancelInProgress: true}`; (2) session idle triage: `on.session: [idle]`, single agent stage, `kill-on: []`; (3) release gate: a trimmed 6-stage version of the §11 example (prepare, build, verify, publish, notify-failure via defaults). Every template validates clean against the v2 backend (assert in a test that POSTs each to `/pipelines/validate` in an integration test, or minimally round-trips through `parseYamlToDraft` + local invariants).
- Consumes: Tasks 20, 21.

**Steps:**
- [ ] **Step 1:** Rewrite modal + templates; template round-trip test.
- [ ] **Step 2:** Full build green; preview the modal. Commit: `feat(pipelines-ui): v2 settings modal and starter templates`

---

### Task 23: Display vocabulary: tones, Kanban, run card

**Files:**
- Rewrite: `frontend/src/renderer/lib/pipeline-display.ts`
- Modify: `components/PipelineRunCard.tsx`, `PipelineWorkbench.tsx` (column keying only), `PipelineFilterBar.tsx` (untouched unless compile requires)

**Interfaces:**
- Produces:
  - `KANBAN_COLUMNS`: pending ("Queued"), running, succeeded, failed, cancelled, keyed on `RunStatus`.
  - `runStatusTone(status: RunStatus)` and `stageOutcomeDotTone(outcome: StageOutcome)`: succeeded = success tone; succeeded_unverified = success tone with hollow/outline dot (deliberately visible per spec §7); failed/timed_out = destructive; no_output/no_signal = warning; cancelled/skipped = muted; running = accent pulse; pending = neutral. Colors from the existing design tokens (DESIGN.md, refined-blue accent).
  - Run card: stage dots use outcomes; `succeeded_unverified` count surfaces as a subtle "n unverified" hint replacing the v1 findings hint.
- Consumes: Task 18 DTOs, Task 20 types.

**Steps:**
- [ ] **Step 1:** Rewrite display lib + card; build green; preview the run board with seeded runs (trigger two runs of a template against a scratch project).
- [ ] **Step 2:** Commit: `feat(pipelines-ui): v2 outcome palette and run-status Kanban`

---

### Task 24: Run detail v2

**Files:**
- Rewrite: `frontend/src/renderer/components/PipelineRunDetail.tsx`

**Interfaces:**
- Produces: header (pipeline, run status badge, subject: PR link or session link, run dir path, created/settled); per-stage rows in plan order: outcome badge, attempt ("nudged" tag when attempt 2), entered-via-failure indicator naming the failed stage, duration, reason line, log viewer (fetch the Task 18 log endpoint, collapsible tail), produced artifact link (outputs endpoint) with a missing-artifact state for no_output, session link when the stage has one plus an orphaned marker + kill button when the session was kept; cancel button (running runs only); resume button removed; findings panel removed.
- Consumes: Task 18 endpoints/DTOs, Task 16 orphan surfacing via session DTO.

**Steps:**
- [ ] **Step 1:** Rewrite; build green; preview a run with a nudged stage and a failure-routed diagnose stage (drive one with a template against a scratch repo).
- [ ] **Step 2:** Commit: `feat(pipelines-ui): v2 run detail, logs, artifacts, orphan affordance`

---

### Task 25: Pipeline-orphaned sessions in the session list

**Files:**
- Modify: `frontend/src/renderer/components/SessionsBoard.tsx` (and `Sidebar.tsx` if the session rows there show badges)

**Interfaces:**
- Produces: sessions whose DTO carries `pipelineOrphan` render a "pipeline" badge with tooltip (run id, stage, outcome that spared it, kept-at) and a kill action (existing session kill mutation). No new endpoint (field rides the session DTO from Task 16).
- Consumes: Task 16 DTO.

**Steps:**
- [ ] **Step 1:** Add badge + tooltip + kill wiring; update `SessionsBoard.test.tsx` (it already references pipelines per the survey); build green; preview.
- [ ] **Step 2:** Commit: `feat(pipelines-ui): pipeline-orphaned session badge and kill`

---

### Task 26: End-to-end dogfood and closeout

**Files:**
- Create: `docs/plans/2026-07-26-pipelines-v2-followups.md` (deferred items, D9 GC policy, credentials UI, matrix/cron per spec §2-out)
- Test: manual E2E, plus one Go integration test if the repo has a harness for daemon-level tests (check `backend/internal/daemon/*_test.go` patterns)

**Steps:**
- [ ] **Step 1:** With `AO_PIPELINES=on`, against a scratch project: run the PR-review template end to end on a real local PR (agent produces review.md, command stage consumes it); verify run folder contents match spec §3 exactly (definition.yaml, run.json, Context.md pointer line, agent-outputs/review.md, stage-logs per stage).
- [ ] **Step 2:** Failure drill: make the command stage exit 1; verify failure routing, kept workspace, orphaned session badge, notify path; cancel drill: cancel mid-run, verify skipped/cancelled outcomes and no failure routing.
- [ ] **Step 3:** Nudge drill: agent prompt deliberately signals done without writing; verify one nudge, then no_output on refusal; verify AO_ATTEMPT=2 visible in the session env.
- [ ] **Step 4:** Concurrency drill: two `pr.updated` fires on one PR with cancel-in-progress; verify the first run cancels.
- [ ] **Step 5:** Restart drill: kill the daemon mid-stage; verify D16 reconciliation on boot.
- [ ] **Step 6:** Full verification: `cd backend && go test ./... && gofmt -l .`, full frontend `pnpm build`, boot with flag off (all routes 501, no engine goroutines).
- [ ] **Step 7:** Write the followups doc. Commit: `docs(pipelines): v2 followups and dogfood notes`

---

## Part 5: Execution notes

- **Ordering:** A(1) then B(2,3,4,5,6) then C(7,8,9,10,11,12) then D(13,14,15,16,17,18,19) then E(20,21,22,23,24,25) then F(26). Within C, Task 9 is independent of 7/8 and can run in parallel. Task 17 unblocks the tail of 11 (signal table) and 12 (credential table); implement those with in-memory seams first as written, swap in 17.
- **The frontend is dark between Tasks 1 and 18** (routes 501 or partial). That is acceptable: the feature is flag-gated and unshipped. Keep `AO_PIPELINES` off in any shared build until Task 26 passes.
- **Branch:** work on `pipelines` (current branch). Dogfood/pipelines PRs go to the fork (`origin`), not upstream, per repo routing rules.
- **Spec drift:** if implementation contradicts the spec, the spec wins; if the spec is silent, this plan's Part 1 decisions win; if both are silent, choose the boring option and note it in the followups doc.

## Self-review record

- Spec coverage: §3 run lifecycle (Tasks 3,6,15), §4 triggers (13), §5 workspace (3,7,15), §6 executors+signal (8,10,11), §7 outcomes+nudge+disposition+reaper (3,4,5,16), §8 credentials (12,17), §9 graph (2,4,5), §10 concurrency (14), §11 example (fixture in 2,3,20), §12 Context.md+env (6,15,10), §13 validation+deadlines+cancellation (2,3,5), §14 divergences (resume/artifacts removed in 18,19; no continue-on-error or job outputs anywhere), §15 forward compat (workspace resolution is subject-to-tree in 7, credentials engine-held in 12), §16 opens (Part 1 decisions D2 through D9).
- Known deliberate scope cut vs "nothing is cut": the findings panel and predicate builder UI are removed because their backing semantics are removed (D10, spec §2 rejects the expression language and per-run shared findings). The UI surfaces (five pages/modals) all remain.
- Type consistency: `Outcome` strings, `RunStatus` strings, `StageList`, `PipelineOrphanInfo`, endpoint paths, and env var names are each defined once (Tasks 2,3,16,18) and referenced by name elsewhere.
