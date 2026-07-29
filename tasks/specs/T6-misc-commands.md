# T6 — Comandos Rust: settings, misc, import scan

## Objective
Fill `frontend/src-tauri/src/settings/mod.rs`, `src/misc/mod.rs` and `src/import_scan.rs` (currently stubs) with real implementations ported from the Electron main process.

## Files
Read (semantics to port):
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/main/keybinding-settings.ts` (+ its `.test.ts`) — `~/.ao/keybindings.json` read/validate/write
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/main/app-state.ts` (+ test) — `~/.ao/app-state.json`, migration block get/set, atomic tmp+rename write, launch marker shape
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/main/update-settings.ts` (+ test) — `~/.ao/update-settings.json` get/set (JSON only; do NOT port updater reconcile logic — that is M5)
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/main/import-folder-scan.ts` (+ test) — git repo scan via `git` subprocess, 5s timeouts
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/shared/telemetry.ts` + `/Users/paulo/Projects/agent-orchestrator/frontend/src/main.ts` lines 385–392 and 1239–1355 (telemetry bootstrap fields; notifications; clipboard; theme; saveDroppedFile under userData/terminal-drops → new location `paths::ao_data_dir().join("tauri/terminal-drops")`)
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/preload.ts` (exact input/output shapes per command)

Modify:
- `frontend/src-tauri/src/settings/mod.rs`, `src/misc/mod.rs`, `src/import_scan.rs`, `src/shell_env.rs` is owned by another task — do NOT touch it.
- `frontend/src-tauri/src/lib.rs`: do not alter existing registration; only if a command needs `AppHandle`/`Window` parameters, adjust that command's signature in its own module (Tauri injects them without registration changes).
- Cargo.toml: DO NOT edit — `arboard` is already added by the orchestrator.

## Steps
1. settings/mod.rs: implement the 7 commands against files under `paths::ao_data_dir()`. Port validation rules from keybinding-settings.ts (reject unknown actions/malformed chords — mirror its tests). Atomic writes: write `<file>.tmp` then rename. `keybindings_set_recording` stores a bool in managed state (used later by M3) and returns Ok.
2. misc/mod.rs:
   - `app_scan_import_folder(path, mode)` → delegate to `import_scan.rs`: run `git` (`rev-parse`, `branch --show-current`, `remote get-url origin`) with 5s timeout per call via `std::process::Command` + wait_timeout pattern (use `tokio::time::timeout` + `tokio::process` since the command is async), replicate the `ImportFolderScan`/`ImportRepoScan` JSON shape from preload.ts including `status`/`reason`/`setupWarning` semantics from import-folder-scan.ts.
   - `terminal_save_dropped_file(name, bytes)` → sanitize filename (strip path separators), write under `ao_data_dir()/tauri/terminal-drops/<unix-millis>-<name>` (timestamp prefix, no uuid crate), return absolute path string.
   - `telemetry_get_bootstrap` → object `{ key, host, appVersion, platform }` (match TelemetryBootstrap field names) from env `AO_TELEMETRY_KEY`/`AO_TELEMETRY_HOST` with the same defaults main.ts uses; return null-equivalent (`Option::None`) when disabled the same way main.ts decides.
   - `theme_set(theme)` → `app.set_theme(Some(Theme::Light|Dark))`, `"system"` → `set_theme(None)`.
   - `window_is_full_screen` → `window.is_fullscreen()`. Also add a `.on_window_event` hook in lib.rs? NO — instead emit `window://fullscreen` from a listener registered in the misc module via an `init(app)` function called from lib.rs `.setup()` IF a setup hook already exists after T5; coordinate by defining `pub fn init(app: &AppHandle)` and calling it — if lib.rs has no setup hook when you start, add one minimal `.setup(|app| { misc::init(&app.handle()); Ok(()) })` line.
   - `window_set_overlay` → no-op `Ok(())` with comment `// custom titlebar handles overlay tinting (M3)`.
   - `menu_action(action)` → implement: `minimize`, `maximize`/`toggle-maximize`, `close`, `quit`, `reload` (webview eval `location.reload()`), `toggle-devtools` (`window.open_devtools()` behind `#[cfg(debug_assertions)]` or the `devtools` feature — if the feature isn't enabled just Ok), `zoom-in`/`zoom-out`/`zoom-reset` via `webview.set_zoom`, `togglefullscreen`, `shell-focus` → Ok(()). Unknown actions → Ok(()) with log (renderer handles edit roles itself — M3).
   - `notifications_show(id, title, body)` → `tauri-plugin-notification` builder; on click support emit `"notifications://click"` with the id where the platform allows; if the plugin's Rust API lacks click callbacks on some platform, emit nothing there (renderer tolerates it) and leave a comment.
   - `clipboard_write_primary(text)` → `#[cfg(target_os = "linux")]` arboard `set_text` on primary selection; other OS: Ok(()) no-op.
   - `app_get_version` stays as-is.
3. Match preload.ts input shapes exactly: commands receive a single object arg where preload sends one (e.g. `scanImportFolder({path, mode})` → `#[tauri::command] fn app_scan_import_folder(input: ScanInput)` with serde camelCase).
4. Unit tests: port the test tables from keybinding-settings.test.ts, app-state.test.ts, update-settings.test.ts (file IO against a tempdir via `AO_DATA_DIR` env), import-folder-scan.test.ts (against a scratch git repo created in the test with `git init`).
5. `cd frontend/src-tauri && cargo check && cargo test`.

## Do NOT touch
`frontend/src/**` TypeScript, `backend/**`, `daemon/mod.rs`, `shell_env.rs`, `Cargo.toml`, `tauri.conf.json`, `capabilities/`, `paths.rs` (consume it only).

## Acceptance criteria
- `cd frontend/src-tauri && cargo check` → 0
- `cd frontend/src-tauri && cargo test` → 0 failures, incl. ported tables for keybindings/app-state/update-settings/import-scan

## Return format
Files modified; commands implemented vs deferred (with M-tag); acceptance results; deviations with reason.
