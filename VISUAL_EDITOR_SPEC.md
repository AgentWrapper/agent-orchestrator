# Visual Pipeline Editor — Spec

> **Status:** Resolved, ready for execution. Follow-on to Pipelines v1 (see PIPELINES_REIMPL_SPEC.md).
> **Target:** fork only. Branch off `pipelines`, PR into `pipelines`. Upstream untouched. Fork-only artifact: this file is stripped before any upstream PR.
> **Design source of truth:** the 5 mockups in `~/Downloads/visual-pipeline-mockups/exports/` (1a canvas, 1b predicate builder, 1c split, 1d validation, 1e new-pipeline). Referenced per task.
> **Ships behind the existing `AO_PIPELINES` flag / Settings toggle** — no separate flag.
> **Last updated:** 2026-07-18

---

## 0. TL;DR

Replace the raw-YAML-only authoring of pipeline definitions with a **visual editor**: a node-graph canvas of stages, a stage inspector, a recursive predicate builder, a Canvas/Split/YAML view toggle with two-way sync, live validation, and a New-pipeline modal with templates. It is **almost pure frontend**: the visual editor edits an in-memory draft and serializes it to the SAME YAML the current editor produces, reusing the Pipelines v1 create/update/schema API. The one backend addition is a dry-run validate endpoint so live validation reuses the Go validation instead of duplicating it in TypeScript.

## 1. Resolved decisions

1. **Graph library**: implementer's best judgment (user deferred). React Flow (`@xyflow/react`) + a layout lib (`dagre` or `elkjs`) recommended for the canvas + Auto-layout. New deps are approved.
2. **Live validation**: new backend endpoint `POST /api/v1/pipelines/validate` (dry-run: parse + validate via `pipeline.ParseDefinition`, return the issue list, persist nothing). The client debounce-calls it for the authoritative Problems list; only the instant cycle-edge highlight runs client-side. No porting of Go validation to TS.
3. **Save path**: the client serializes the visual draft to YAML and uses the EXISTING `POST /api/v1/pipelines` / `PUT /api/v1/pipelines/{id}` endpoints. No new write API. The Split/YAML view falls out of this for free.
4. **Templates**: 3 static templates baked into the renderer for v1 (no template API).
5. **Flag**: gated by the existing `AO_PIPELINES` subsystem (validate route is a normal gated pipelines route; nil manager → 501). The editor only renders when the Settings toggle is on.

## 2. What exists to build on (Pipelines v1, merged on `pipelines`)

- **Backend API** (`backend/internal/httpd/controllers/pipelines.go`, service `backend/internal/service/pipeline/pipeline.go`): definitions CRUD (`CreateDefinition`/`UpdateDefinition` take `yamlSource`), `GET /pipelines/schema` (JSON Schema), runs endpoints. `pipeline.ParseDefinition([]byte) (*Pipeline, error)` returns `*pipeline.ValidationError{Issues:[]Issue{Path,Message}}` on failure — the full multi-issue list with dotted paths.
- **Domain model** (`backend/internal/pipeline/types.go`, `predicate.go`): the authoritative shapes the draft mirrors (Pipeline, Stage, StageExecutor tagged union, TaskSpec, StageRoutes, ExitPredicates, the recursive Predicate DSL).
- **Frontend Definitions tab** (T9): `components/PipelineDefinitionsPage.tsx`, `components/YamlEditor.tsx` (CodeMirror 6, reuse it), `hooks/usePipelineDefinitions.ts` (CRUD mutations, query keys in the `pipeline`-prefixed family), `lib/pipeline-yaml.ts`, routes `routes/_shell.pipelines*.tsx`. Generated API types in `frontend/src/api/schema.ts`.
- **Live invalidation**: `lib/event-transport.ts` invalidates the `pipeline`-prefixed query family on `pipeline_*` CDC events.
- Design system: `DESIGN.md` ("clone agent-orchestrator verbatim" banner), shadcn primitives in `renderer/ui`, refined-blue accent, token-based classes.

## 3. The draft model (the spine)

A canonical TypeScript `PipelineDraft` object is the single in-memory representation everything edits:
- The canvas renders it (stages → nodes, `dependsOn` → edges).
- The inspector two-way binds to a selected stage.
- The predicate builder edits `routes.when` and `exitPredicates.{done,stalled,blocksMerge}` sub-trees.
- `serializeToYaml(draft)` → the YAML sent to the API on save; `parseYamlToDraft(yaml)` → rebuilds the draft when the user edits YAML in Split/YAML mode.
- Round-trip (`draft → yaml → draft`) must be stable for the fields the editor manages.

The draft mirrors `backend/internal/pipeline/types.go`. Derive the field set from that + the generated schema; do not invent fields.

## 4. Task breakdown — batches on the `pipelines` branch

Every task: one AO worker, TDD, PR base `pipelines`, label `pipelines-v1`, reviewed + squash-merged by the orchestrator. Restyle everything to the AO design system (do not copy mockup colors literally; match the app).

### Batch A — Foundation (must land first)

**V1 · Draft model + codec + validate endpoint + view shell**
- TS `PipelineDraft` type mirroring the Go domain model; `serializeToYaml` / `parseYamlToDraft` with a stable round-trip; a `usePipelineDraft` hook holding the draft + debounced validation.
- Backend: `POST /api/v1/pipelines/validate` (gated pipelines route; body `{yamlSource}`; returns `{valid, issues:[{path,message}]}` via `ParseDefinition`; persists nothing). Wire through the pipelines service + controller + OpenAPI + regenerate `schema.ts`.
- The Canvas/Split/YAML view-toggle shell in the definition editor route (extends T9's editor; YAML mode reuses `YamlEditor`). Scaffold the chosen graph + layout deps (empty canvas placeholder is fine here).
- Reference: mockups 1a (top bar toggle), 1c. Tests: round-trip codec table tests, validate-endpoint controller test (valid + multi-issue), hook debounce.

### Batch B — Core surfaces (parallel; depend on V1)

**V2 · Canvas + nodes + auto-layout**
- Graph canvas: node cards per executor kind (agent/command/builtin, visually distinct), edges = `dependsOn` (drawing an edge adds a dependency, deleting removes it; block self/cycle edges with the instant highlight), Add-stage, Auto-layout (dagre/elk), pan/zoom/Fit, node select → drives the inspector selection. Node card shows name, plugin·mode or command, finding/among summary, routes-when chip, workspace/rounds footer.
- Reference: mockup 1a canvas + node cards, 1d cycle edge. Tests: add/remove stage, edge add mutates dependsOn, auto-layout, cycle-edge detection.

**V3 · Stage inspector panel**
- Right panel bound to the selected stage: Name; Trigger (multi-select chips over the 5 events); Executor (Agent/Command/Builtin segmented, each revealing its fields — agent: plugin + mode; command: command/args/env/cwd; builtin: name); Task prompt (+ optional output schema, inputs); Depends-on chips; Routes-when summary + "Edit condition" (opens V4's builder); Workspace segmented; Advanced knobs (retries, timeout, max rounds, budget).
- Reference: mockup 1a right panel. Tests: each executor kind's fields bind, trigger multi-select, dependsOn edit reflects on canvas.

**V4 · Predicate builder**
- Recursive rule-builder component over a predicate sub-tree: "Match ALL/ANY of the following" groups, one row per predicate kind (all/any/majority_pass, no_open_findings, finding_count_below, loop_rounds_at_least, stage_retried_at_least, stage_verdict), `+Condition`, `+Group`, `not(…) wrap`, remove. Live "Compiled predicate · matches the DSL" readout rendering the exact DSL. Pure component; reused by V3 and V5.
- Reference: mockup 1b builder + compiled readout. Tests: build each kind, nest ALL/ANY, not-wrap, compiled-DSL output matches, round-trips through the draft predicate shape.

### Batch C — Compose + robustness (parallel; depend on Batch B)

**V5 · Pipeline settings modal**
- Modal: Name, Max concurrent (stepper), Allow fork PRs (toggle), and the three Exit conditions (done / stalled / blocksMerge) each authored with V4's builder.
- Reference: mockup 1b top + tabs. Tests: settings bind, each exit tab edits its predicate.

**V6 · Split/YAML sync + validation surfacing**
- Split view: canvas + `YamlEditor` side by side, edits sync both ways (draft is the bridge), selecting a node scrolls the YAML to its block. Validation: consume `/validate`; a Problems panel ("must resolve before saving") with Reveal, inline node error/warning badges, the red cycle edge; gate Save while errors exist; the top-bar Valid/N-problems indicator.
- Reference: mockups 1c, 1d. Tests: canvas edit updates YAML and vice versa, problems render from validate response, Save disabled on error.

### Batch D — Entry + polish (depends on Batch C)

**V7 · New-pipeline modal + templates + integration + e2e**
- "New pipeline" modal: Blank canvas / From template / Paste YAML, with 3 static templates (PR review loop, Nightly triage sweep, Release gate). Replace the T9 plain-YAML create flow in the Definitions tab with the visual editor; keep Paste-YAML as the import path. Empty state. Full flow test + update `docs/pipelines.md`.
- Reference: mockup 1e. Tests: each create path, template instantiation, end-to-end author → save → appears in list.

## 5. Constraints & notes

- Everything the visual editor produces MUST serialize to config the existing `ParseDefinition` accepts; the `/validate` endpoint is the contract check.
- Keep the YAML/Paste path first-class: agents and power users still author via YAML/API; the visual editor is additive.
- Do not modify the Pipelines v1 backend domain/reducer/engine. The only backend change in this whole effort is the `/validate` endpoint (V1).
- Route-tree file `routeTree.gen.ts` is untracked (regenerated at build). Whoever merges second in a batch rebases + regenerates.
- No em dashes in any produced content.
