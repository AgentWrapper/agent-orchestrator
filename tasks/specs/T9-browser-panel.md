# T9 (M4) — Painel de browser embutido (multi-webview)

> A MAIOR tarefa.
>
> **SPIKE JÁ APROVADO (2026-07-29)** — passo 1 está CONCLUÍDO, não repetir. Resultado:
> ~19–25ms/snapshot (~50fps) em release no macOS, via `src-tauri/src/browser_spike.rs`.
> **Contrato de concorrência load-bearing** (a primeira tentativa travou por violá-lo):
> `takeSnapshot`/`CapturePreview`/`snapshot` são INICIADOS na main thread
> (`with_webview`) e o completion handler é entregue pelo run loop da main thread —
> NUNCA bloquear a main thread esperando o resultado; iniciar na main, receber os
> bytes numa thread/tarefa de fundo (ver `snapshot_jpeg_blocking` no spike, que é a
> referência a seguir em `browser/capture/*.rs`). O mesmo padrão vale para toda API
> nativa assíncrona nas 3 plataformas. Depois de portar para `browser/capture/macos.rs`,
> deletar `browser_spike.rs`, o example e o comando `browser_capture_spike` do lib.rs.

## Objective
Reimplement the Electron `WebContentsView` browser panel in Tauri: child webviews per session, bounds sync, nav hardening, back/forward/stop, JPEG capture, annotation overlay via init script, mirror-by-snapshot-streaming.

## Files
Read (the spec of record): `/Users/paulo/Projects/agent-orchestrator/frontend/src/main/browser-view-host.ts` (+ `.test.ts`), `frontend/src/annotate-preload.ts`, `frontend/src/shared/browser-annotations.ts` (+ test), `frontend/src/preload.ts` browser namespace (16 members, exact shapes), `frontend/src/shared/bridge-types.ts`, `frontend/src-tauri/src/lib.rs`, `capabilities/browser-panel.json` (create).
Create/modify: `frontend/src-tauri/src/browser/{mod.rs,host.rs,bounds.rs,nav.rs,capture/{mod.rs,macos.rs,windows.rs,linux.rs},mirror.rs,annotate.rs}`; `frontend/src/browser-annotate/` (plain-JS Vite lib entry rebuilt from annotate-preload.ts, no Electron imports); register `mod browser;` + new commands in lib.rs; add the `browser_*` commands to tauri-bridge.ts replacing the fake delegation (TODO(M4) markers); native deps in Cargo.toml — allowed here: `objc2`/`objc2-web-kit` (macos), `webview2-com`/`windows` (windows), `webkit2gtk` (linux), `image` (jpeg), gated per-target.

## Steps
1. SPIKE (macOS, timeboxed): child webview via `window.add_child` (unstable feature already enabled) + `with_webview` → WKWebView `takeSnapshot` → JPEG bytes. Acceptance: a `#[cfg(test)]`-excluded example or debug command `browser_capture` returning a data URL >10KB from a real page. Report fps of 10 consecutive snapshots.
2. Host: registry `HashMap<viewId, Webview>` in managed state; `browser_ensure(sessionId)` creates label `browser-<sessionId>` (idempotent), `browser_destroy` closes; park hidden views at x:-10000 (uniform fallback).
3. `browser_set_bounds` (fire-and-forget), zoom-scaled bounds come already computed from React — apply LogicalPosition/LogicalSize.
4. Nav: `on_navigation` allowlist ported from browser-view-host.ts; URL normalization/omnibox stays in TS (port those pure functions from browser-view-host.ts into `frontend/src/renderer/lib/browser-url.ts` + tests, call before `browser_navigate`).
5. NavState pushes: `on_page_load` + title polling via annotate init script → emit `browser://nav-state` with `BrowserNavState` field names byte-matching bridge-types.ts. back/forward/stop/canGo* via platform modules.
6. Annotation: rebuild annotate-preload.ts as plain JS (shadow-DOM picker unchanged) in `src/browser-annotate/main.ts`, built by a vite lib config to a single IIFE string imported by Rust (`include_str!` of the built artifact or embed via build step — document choice); inject with `initialization_script()`. Messaging: `window.__TAURI_INTERNALS__.invoke("browser_annotation_submit"| "browser_annotation_cancel", payload)`. Capability `browser-panel.json`: webviews `browser-*`, `remote: {urls:["*"]}`, ONLY the three commands + `browser_forward_shortcut`. Rust validates payload viewId == caller label.
7. `browser_capture` → platform snapshot → JPEG data URL (contract: same string shape as Electron capturePage path).
8. Mirror: `browser_request_mirror(viewId) -> bool`; Rust loop 5–10fps snapshots → custom URI scheme protocol `mirror://<viewId>/frame` (register_uri_scheme_protocol) serving latest JPEG; renderer side: extend the existing mirror consumer to poll/paint canvas + `canvas.captureStream()` (locate consumer via grep `requestMirror` in renderer). Return false when unsupported.
9. Shortcut forwarding: init script keydown → `browser_forward_shortcut` → re-emit to main window as the matching `shortcuts://*` event.
10. Tests: Rust unit tests for registry/bounds/label validation; TS tests for browser-url port; hostile-page test documented as manual step (attempt invoking a non-allowed command from a child webview must fail — write an automated Rust test if feasible via capability config assertion).
11. `cargo check && cargo test && cargo clippy`; `npm run typecheck && npx vitest run --config vite.renderer.config.ts`.

## Do NOT touch
Electron files; daemon/settings/misc modules; backend/**.

## Acceptance criteria
- All commands of the preload `browser` namespace implemented (16 members: ensure, setBounds, navigate, clear, capture, requestMirror, goBack, goForward, reload, stop, destroy, setAnnotationMode, onNavState, onAnnotationSubmit, onAnnotationCancel) and wired in tauri-bridge.ts.
- cargo + npm suites green. Spike evidence included.

## Return format
Spike results first (fps, platform); files; per-member implementation status; acceptance results; deviations.
