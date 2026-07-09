# Per-project orchestrator system prompt (`orchestratorPrompt`)

Date: 2026-06-26
Status: Approved (design)

## Context / Problem

The orchestrator session's standing instructions are generated in code
(`backend/internal/session_manager/manager.go:1008` `orchestratorPrompt()`),
identical for every project. `ProjectConfig` is a closed, typed schema that
deliberately omits "prompt rules" (`backend/internal/domain/projectconfig.go:17-19`),
and the config HTTP endpoints reject unknown keys
(`backend/internal/httpd/controllers/projects_test.go:319`). So there is no way to
give one project a custom orchestrator prompt without editing Go and rebuilding the
daemon. We want a per-project override settable via `ao project set-config`.

## Goal

Add an optional `orchestratorPrompt` to `ProjectConfig`. When set, orchestrator
sessions in that project use it as their standing instructions instead of the
built-in base. Settable from the CLI. No effect on worker sessions or other projects.

## Design

### Semantics: replace the base

When `orchestratorPrompt` is non-empty, `buildSystemPrompt` uses it as the
orchestrator `base` in place of `orchestratorPrompt(projectID)`. The
`systemPromptGuard` (confidentiality) is still appended, exactly as today.
Empty/unset → built-in base (current behavior). The custom text is used **literally**
— no `{{}}` templating/substitution. (Rejected: augment/prepend, which would
duplicate the built-in's `ao spawn`/`ao send` lines.)

### Field (`domain/projectconfig.go`)

```go
// OrchestratorPrompt, when set, replaces the built-in orchestrator standing
// instructions for this project's orchestrator sessions. The confidentiality
// guard is still appended. Empty = built-in default.
OrchestratorPrompt string `json:"orchestratorPrompt,omitempty"`
```

`Validate()` enforces a max length. Exact cap confirmed in implementation after
checking how the agent adapter delivers the system prompt (process argv vs file):
chosen well above a real prompt (~16 KB) while bounding exec arg size — target ~64 KB.

### Wiring (`session_manager/manager.go`)

`buildSystemPrompt(ctx, kind, projectID)`: for `KindOrchestrator`, load the project
(`m.loadProject`) and use `cfg.OrchestratorPrompt` as base when non-empty, else
`orchestratorPrompt(projectID)`. Recomputed fresh at spawn/restore (consistent with
the current non-persisted prompt logic), so editing config + re-spawn picks it up.
Worker path unchanged.

### CLI (`cli/project.go`)

- Add `OrchestratorPrompt` to the CLI's hand-mirrored `projectConfig` type so
  `--config-json` round-trips it and `project get --json` returns it.
- New flag `--orchestrator-prompt-file <path|->`: reads the prompt from a file (or
  `-` for stdin), mirroring `ao review submit --body` (`cli/review.go:103-108`).
  Extract that file/stdin read into a small shared helper. (No inline
  `--orchestrator-prompt <text>` flag — consistent with `--body`, and prompts are large.)
- `project get` human-readable output shows a short indicator
  (`orchestratorPrompt: set (N chars)`) rather than dumping the full text.
- Note: `set-config` is **replace-semantics**; setting the prompt alone wipes other
  fields. To add it to an existing config, pass the full object via `--config-json`
  (or re-pass all field flags).

### API / generated artifacts

`domain.ProjectConfig` is reflected into the OpenAPI schema
(`apispec/specgen/build.go:131` → `ProjectConfig`). After adding the field, run
`npm run api` to regenerate `openapi.yaml` + `frontend/src/api/schema.ts`; commit them
with the Go change (CI api-drift gate). No SQLite migration — config is one JSON blob.

## Testing (TDD)

- **domain:** `Validate` accepts a normal prompt, rejects over-length; JSON
  round-trips `orchestratorPrompt`; `IsZero` is false when only the prompt is set.
- **manager:** orchestrator session uses the configured prompt when set, the built-in
  when empty; guard always appended; worker prompt unaffected.
- **cli:** `--orchestrator-prompt-file <path>` and `-` (stdin) populate the config;
  missing file errors cleanly; `--config-json` round-trips the field; replace-semantics
  covered.
- **controller:** strict decoder now accepts `orchestratorPrompt` and still rejects
  unknown keys.
- **api drift:** regenerated spec/types committed; `cd backend && go test ./internal/httpd/...` passes.

## Out of scope

- A per-project `workerPrompt` (YAGNI; same pattern later if needed).
- Templating/variable substitution inside the custom prompt.
- Any storage change beyond the existing `ProjectConfig` JSON blob.

## Apply (target: skyvern-cloud)

Reshape the existing standalone orchestrator template into system-prompt form (drop
`## User request`/`{{USER_REQUEST}}`, `## Scratchpad`, and `## Output`/`<command>`
protocol; keep role + rules + commands + branch/PR/review + superpowers). The daemon
appends the confidentiality guard, so it is not duplicated. Set it on `skyvern-cloud`
via `--config-json` (full existing config + `orchestratorPrompt`), built with `jq` to
avoid hand-escaping the markdown.
