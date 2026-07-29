# T10 (M5) — Updater (canais, settings, escalation, feature builds)

## Objective
Implement auto-update in the Tauri shell with `tauri-plugin-updater`: channel manifests on GitHub Releases, settings/escalation/feature-build logic ported to Rust, `updates://status` events, in-app opt-in wizard.

## Files
Read: `/Users/paulo/Projects/agent-orchestrator/frontend/src/main/auto-updater.ts` (+ test), `update-settings.ts` (+ test), `feature-builds.ts` (+ test), `escalation-evaluator.ts` (+ test), preload `updates`/`updateSettings`/`featureBuilds` namespaces in `frontend/src/shared/bridge-types.ts`.
Create/modify: `frontend/src-tauri/src/updater/{mod.rs,settings.rs,escalation.rs,feature_builds.rs}`; add `tauri-plugin-updater = "2"` + `reqwest` (rustls) to Cargo.toml; register plugin + commands in lib.rs; implement `updates_get_status/check/return_home/download/install`, `feature_builds_list/get_active` commands; replace the fake delegation in tauri-bridge.ts for `updates`/`featureBuilds`/`updateSettings`; in-app wizard React modal replacing the 3-step dialog flow (grep renderer for existing update UI, follow DESIGN.md + shadcn primitives).
Signing/manifest generation is T11 (CI) — here, endpoints are read from `~/.ao/update-settings.json` with channel → URL mapping: `latest` → `.../releases/latest/download/latest.json`, `nightly` → `.../releases/download/nightly/nightly.json`, `pr<N>` → `.../releases/download/pr<N>/pr-<N>.json` (repo from `AO_RELEASE_REPO` build-time env, default `AgentWrapper/agent-orchestrator`).

## Steps
1. Port update-settings.ts semantics (defaults, migration of unknown fields) to settings.rs; commands read/write `~/.ao/update-settings.json`.
2. mod.rs: UpdaterBuilder with runtime endpoint per current channel; serialize check/download/install through one tokio mutex (mirror the promise-queue); status transitions emitted as `updates://status` with `UpdateStatus` field names byte-matching bridge-types.ts; hourly tokio interval; `updates_install` → plugin install + `tauri-plugin-process` restart.
3. Port escalation-evaluator.ts and feature-builds.ts test tables to Rust (`#[cfg(test)]`), fetching via reqwest; feature-build discovery parses the `<!-- ao-feature-build: {...} -->` marker from GitHub Releases API.
4. Wizard: React modal (shadcn) with the same 3 steps/copy as auto-updater.ts:562-605; triggered on first packaged run when settings lack a decision; writes settings via bridge.
5. `cargo check && cargo test`; `npm run typecheck && npx vitest run --config vite.renderer.config.ts`. Real update e2e deferred to T11 staging release.

## Do NOT touch
Electron files; browser/daemon modules; backend/**.

## Acceptance criteria
- cargo + npm suites green; ported tables present; `updates`/`featureBuilds`/`updateSettings` no longer delegate to the fake in tauri-bridge.ts.

## Return format
Files; command list; ported tables; acceptance results; deviations.
