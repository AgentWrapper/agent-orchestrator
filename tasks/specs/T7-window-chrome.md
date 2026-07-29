# T7 (M3) — Chrome de janela por OS

## Objective
Achieve window-chrome parity in the Tauri shell: frameless titlebar per OS, drag regions, window controls, theme, fullscreen events.

## Files
Read: `/Users/paulo/Projects/agent-orchestrator/frontend/src/main.ts` lines 234–352 (current BrowserWindow config), `frontend/src/main/menu.ts`, `frontend/src/renderer/styles.css` (search `-webkit-app-region`), `frontend/src-tauri/tauri.conf.json`, `frontend/src-tauri/src/misc/mod.rs` (menu_action/window commands), renderer titlebar component (grep `titlebar`/`traffic` under `frontend/src/renderer`).
Modify: `tauri.conf.json` (+ per-OS keys), renderer titlebar component + CSS, `src-tauri/src/window/` (new module allowed — register `mod window;` in lib.rs), `capabilities/main.json` only if a new permission is required.

## Steps
1. macOS: `"titleBarStyle": "Overlay"`, `"hiddenTitle": true`, `trafficLightPosition {x:14,y:12}` in tauri.conf (macOS-specific window config). Windows/Linux: `"decorations": false`.
2. Replace every `-webkit-app-region: drag`/`no-drag` usage with `data-tauri-drag-region` attributes on the titlebar elements (CSS property does nothing under Tauri). Interactive children must NOT inherit the attribute.
3. Windows/Linux custom titlebar: wire minimize/toggle-maximize/close buttons to `getCurrentWindow().minimize()/toggleMaximize()/close()` from `@tauri-apps/api/window` (permissions already granted in capabilities).
4. Fullscreen: in `src-tauri` emit `window://fullscreen` (bool payload) from `WindowEvent::Resized`-based fullscreen detection or `on_window_event` fullscreen transitions, matching the Electron `enter/leave-full-screen` behavior.
5. `theme_set` already exists; verify it flips the webview prefers-color-scheme (manual note ok).
6. `window_set_overlay`: on Windows keep as no-op (custom titlebar tints itself); document in code.
7. Do NOT implement moveToApplicationsFolder (decision: dropped — record in tasks/todo.md Review section).
8. Run `cd frontend && npm run typecheck && npx vitest run --config vite.renderer.config.ts` and `cd src-tauri && cargo check && cargo test`.

## Do NOT touch
`frontend/src/main.ts`, `preload.ts`, `src/main/**` (Electron stays functional until cleanup), daemon/settings/misc modules beyond window-related commands, `backend/**`.

## Acceptance criteria
- typecheck, vitest, cargo check/test all exit 0.
- `grep -rn "webkit-app-region" frontend/src/renderer` → only matches inside code paths still used by Electron (or zero if fully replaced by the attribute approach with Electron CSS kept via a shared class — either is fine; state which).
- tauri.conf.json contains the macOS Overlay + trafficLightPosition and windows/linux decorations:false split.

## Return format
Files modified; per-OS behavior summary; acceptance results; deviations.
