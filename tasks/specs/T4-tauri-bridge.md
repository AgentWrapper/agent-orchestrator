# T4 — Extrair AoBridge para shared e criar tauri-bridge.ts

## Objective
Move the `AoBridge` type contract out of Electron files into `frontend/src/shared/bridge-types.ts`, and implement `frontend/src/renderer/lib/tauri-bridge.ts` — an `AoBridge` implementation over `@tauri-apps/api` — selected by `frontend/src/renderer/lib/bridge.ts` when running under Tauri.

## Files
Read:
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/preload.ts` (the full `api` object — the contract to replicate; `AoBridge = typeof api`)
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/renderer/lib/bridge.ts` (browser fallback + how AoBridge is imported today)
- Type sources: `frontend/src/shared/shortcuts.ts` (KeybindingOverrides + the 7 shortcut channel consts), `frontend/src/shared/daemon-status.ts` (DaemonStatus), `frontend/src/shared/telemetry.ts` (TelemetryBootstrap), `frontend/src/shared/browser-annotations.ts`, `frontend/src/main/browser-view-host.ts` (BrowserNavState, BrowserRect types only), `frontend/src/main/app-state.ts` (MigrationState), `frontend/src/main/update-settings.ts` (UpdateSettings, UpdateStatus), `frontend/src/main/auto-updater.ts` (UpdateCheckOptions), `frontend/src/main/feature-builds.ts` (FeatureBuild)

Create:
- `frontend/src/shared/bridge-types.ts`
- `frontend/src/renderer/lib/tauri-bridge.ts`

Modify:
- `frontend/src/preload.ts` (imports + `satisfies AoBridge`; keep runtime behavior identical)
- `frontend/src/renderer/lib/bridge.ts` (import from shared; add Tauri detection)
- The `main/*` and `shared/*` type-source files ONLY as needed to relocate pure type definitions (see step 1) — never runtime code.

## Steps
1. In `bridge-types.ts`: define (moved, not duplicated) the pure type definitions `BrowserRect`, `BrowserNavState`, `MigrationState`, `UpdateSettings`, `UpdateStatus`, `UpdateCheckOptions`, `FeatureBuild`, plus `BrowserBoundsInput`, `BrowserNavigateInput`, `ImportFolderMode`, `ImportRepoScan`, `ImportFolderScan` (currently in preload.ts). For each type moved out of a `main/*` or `shared/*` file, replace the original definition with `export type { X } from "../shared/bridge-types"` (adjust relative path) so all existing importers keep compiling. Types that live in `shared/` files WITHOUT importing Electron/main code (KeybindingOverrides, DaemonStatus, TelemetryBootstrap, browser-annotations types) stay where they are; bridge-types.ts imports them.
2. Define `export interface AoBridge { ... }` in bridge-types.ts with the exact shape of the `api` object in preload.ts (all 14 namespaces, exact member names and signatures, unsubscribe functions returned by every `on*`).
3. preload.ts: import the moved types from `./shared/bridge-types`, keep the `api` object identical, end with `const api = { ... } satisfies AoBridge` and `export type { AoBridge } from "./shared/bridge-types"` (keep existing named type exports working).
4. bridge.ts: import `AoBridge` from `../../shared/bridge-types`. Add `const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;` — when true, use `createTauriBridge()` from `./tauri-bridge`; otherwise the existing browser fallback unchanged. Preserve the existing exported API of bridge.ts.
5. tauri-bridge.ts: `export function createTauriBridge(): AoBridge`. Implementation rules:
   - `invoke` from `@tauri-apps/api/core`, `listen` from `@tauri-apps/api/event`.
   - Command naming: IPC channel `ns:verb` → `ns_verb` snake_case: `daemon_get_status`, `daemon_start`, `daemon_stop`, `daemon_restart`, `app_get_version` (maps to `app.getVersion`), `app_scan_import_folder`, `terminal_save_dropped_file`, `window_set_overlay`, `window_is_full_screen`, `theme_set`, `menu_action`, `clipboard_write_primary` (unused for now), `notifications_show`, `app_state_get_migration`, `app_state_set_migration`, `update_settings_get`, `update_settings_set`, `keybindings_get`, `keybindings_set`, `keybindings_set_recording`, `telemetry_get_bootstrap`.
   - Events: `daemon.onStatus` ← `"daemon://status"`, `window.onFullScreen` ← `"window://fullscreen"`, `notifications.onClick` ← `"notifications://click"`, the 7 `app.on*Shortcut`/help subscriptions ← `"shortcuts://<channel>"` where `<channel>` is the existing const value from `shared/shortcuts.ts`. Each `on*` calls `listen(...)` (async) and synchronously returns `() => { p.then((un) => un()); }`.
   - `app.chooseDirectory` → `open({ directory: true, title })` from `@tauri-apps/plugin-dialog`; `app.openExternal` → `openUrl` from `@tauri-apps/plugin-opener`; `clipboard.writeText`/`readText` → `@tauri-apps/plugin-clipboard-manager`. Install these three npm packages (`@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-opener`, `@tauri-apps/plugin-clipboard-manager`, v2).
   - `terminal.saveDroppedFile`: convert `Uint8Array` to `Array.from(bytes)` for the invoke payload.
   - `menu.notifyShellFocus`: fire-and-forget `invoke("menu_action", { action: "shell-focus" }).catch(() => {})`.
   - Namespaces `browser`, `updates`, `featureBuilds`: NOT yet backed by Rust (later milestones). Delegate these three namespaces to the same objects the browser fallback uses (refactor bridge.ts minimally to export its fallback implementations of those namespaces for reuse), marked with `// TODO(M4)/(M5)`.
   - Add `satisfies AoBridge` on the returned object.
6. Check e2e fake: `grep -rn "AoBridge" frontend/e2e frontend/src` — update import paths where they pointed at `../../preload`. Keep `satisfies AoBridge` tripwires working.
7. Run: `cd frontend && npm run typecheck && npm run typecheck:e2e && npx vitest run --config vite.renderer.config.ts`.

## Do NOT touch
- Runtime logic in `src/main/**` or `src/main.ts` (type relocation re-exports only). No renderer feature code. No Rust files. Do not modify `frontend/src-tauri/**`.

## Acceptance criteria
- `cd frontend && npm run typecheck` → 0
- `cd frontend && npm run typecheck:e2e` → 0
- `cd frontend && npx vitest run --config vite.renderer.config.ts` → 0 failures

## Return format
Files created/modified; list of types relocated; the three acceptance results; deviations with reason.
