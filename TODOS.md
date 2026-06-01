# TODOS

Cross-cutting work captured outside any single PR. Each item references the plan that motivates it; pick up by working sequentially through the sections.

---

## v0.2 — `CanvasProducer` plugin invocation (NEXT to ship)

**Why first:** Highest leverage per engineer-day. PR-status, linked-issues, cost canvases ship the moment this lands. Every existing AO user benefits with no plugin install.

**Source:** [docs/canvases-feature.html](docs/canvases-feature.html) Tier 2 + roadmap row v0.2.

**Scope:**
- Wire `CanvasProducer.listCanvases(session, project)` calls into the canvases API endpoint.
- Iterate over registered agent / SCM / tracker plugins; merge their returned canvases with file canvases + synthesized git diff.
- Same first-write-wins merge semantics as the file path (see `packages/web/src/app/api/sessions/[id]/canvases/merge.ts`).
- Tests: each producer source produces canvases, multiple producers merge correctly, producer crash → skipped with named warning, producer respects existing size caps.

**Effort:** ~3 days.

---

## v0.3 — Mux WebSocket push (after v0.2)

**Why second:** Fixes the felt-slowness UX gap of 5s polling. v0.4 inherits this gap if shipped first.

**Source:** [docs/canvases-feature.html](docs/canvases-feature.html) roadmap row v0.3.

**Scope:**
- New mux topic `canvases:{sessionId}`. Core publishes when a canvas file is added / modified / deleted in the workspace.
- `useSessionCanvases` subscribes per session; falls back to 5s REST poll if mux is unavailable.
- Visibility-aware pause stays.
- Invalidate-and-fetch pattern (don't ship full payload over the topic; signal a refetch).
- Tests: subscribe + receive event, fall back to poll on disconnect, multi-tab dedupe.

**Effort:** ~4 days.

---

## v0.4 — Canvas-renderer plugin slot (after v0.3)

**Source of truth:** [docs/canvases-v0.4-plan.html](docs/canvases-v0.4-plan.html) (locked decisions from plan-eng-review 2026-05-10).

**Scope is Maximalist** per cross-model tension 2A: core machinery + example tiny plugin + real-npm-pack CI fixture + `ao plugin install` CLI auto-rebuild + install-warning UI.

### Implementation lanes (parallelizable after schema registry lands)

| Lane | Module path | Effort | Depends on |
|---|---|---|---|
| **A. Schema registry foundation** | `packages/core/src/canvas-schema-registry.ts` (new) | ~2 days | — |
| **B. Discovery generator** | `packages/cli/src/lib/canvas-discovery.ts` (new) + `scripts/generate-canvas-renderers.ts` (new) | ~3 days | A |
| **C. AST compatibility lint** | `packages/cli/src/lib/plugin-contract-lint.ts` (new) | ~3 days | — (parallel with A) |
| **D. Web renderer dispatch** | `packages/web/src/components/CanvasRail.tsx` (extend) + `packages/web/src/components/CanvasErrorBoundary.tsx` (new) | ~2 days | B |
| **E. `ao plugin install` CLI** | `packages/cli/src/commands/plugin.ts` (new) | ~3 days | B |
| **F. Install-warning UI** | `packages/web/src/components/PluginTrustWarning.tsx` (new) | ~2 days | E |
| **G. `ao canvas prune` CLI** | `packages/cli/src/commands/canvas.ts` (new) | ~1 day | A |
| **H. Example tiny plugin** | `packages/plugins/canvas-counter/` (new package) | ~2 days | A, B, D |
| **I. CI fixture (real npm pack)** | `packages/integration-tests/canvas-plugin.integration.test.ts` (new) | ~3 days | H |
| **J. Tests + docs** | distributed across the above modules | ~3 days | all |

### Failure modes the implementation MUST handle (codex-derived)

These are the failure cases the test suite is organized around (replaces the "29 tests" framing with concrete failure modes):

- **Stale build artifact:** plugin installed after last `pnpm build` — show "rebuild required" placeholder, not "unsupported type".
- **Missing rebuild:** user `npm install`-d but never ran `pnpm build` — `ao plugin install` CLI auto-runs the build.
- **Real npm-pack vs workspace symlink:** CI fixture uses `npm pack` + tarball install, not `pnpm` workspace.
- **Zod peer-dep mismatch:** plugin's Zod is a different major than core's — discovery rejects with named error.
- **Renderer chunk failure:** lazy chunk fails to load (network error, integrity check) — Suspense fallback shows "renderer unavailable" state, not blank canvas.
- **Schema import throws:** plugin's `dist/index.js` throws during import — per-plugin try/catch, plugin omitted from registry.
- **Schema import hangs:** plugin's import takes >5s — timeout, plugin omitted.
- **Type-id collision:** two plugins claim the same `canvasType` — fatal, AO refuses to start, names both.
- **Built-in shadow:** plugin claims `markdown`/`diff`/`table`/`stats` or any `core-*` prefix — discovery refuses to load that plugin.
- **Plugin uninstall:** workspace has stale canvas JSON referencing removed canvasType — `ao canvas prune --type X` cleans them.
- **Unsupported type disambiguation:** placeholder UI distinguishes "plugin missing" / "stale build" / "failed discovery" / "AO version mismatch."
- **Next.js production build:** CI fixture runs `next build` (production), not dev mode — proves file tracing includes dynamic imports.

### Effort summary

2.5–4 engineer-weeks of core work for the full Maximalist scope (lanes A–J).

---

## v0.5+ — Deferred (do not start until v0.4 is in production)

- **Iframe sandboxing** for community / untrusted renderers. Only with a real use case + a designed-end-to-end protocol (CSP headers, postMessage validation, focus management, viewport sizing).
- **Image rendering in built-in markdown.** Needs allowlist policy + `data:` policy.
- **Write-back canvases / action buttons** that mutate session state. Needs CSRF, auth scope, consent UI.
- **Plugin hot-reload during dev.** Plugin authors restart AO at v0.4; this is a quality-of-life improvement.
- **Plugin marketplace UI.** AO-hosted catalog of community plugins.

---

## Maintenance / non-canvas

(Add as discovered. Don't let TODOs land here without a referenced plan or motivating issue.)
