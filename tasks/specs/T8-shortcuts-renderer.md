# T8 (M3) — Engine de atalhos no renderer

## Objective
Move the keyboard-shortcut engine from the Electron main process into the renderer: global keydown handling with chords, keybinding overrides from `~/.ao/keybindings.json` (via `keybindings_get/set` commands), and recording-mode suspension.

## Files
Read: `/Users/paulo/Projects/agent-orchestrator/frontend/src/main/app-shortcuts.ts` (+ `.test.ts`), `frontend/src/shared/shortcuts.ts` (+ test — chord definitions, channels, KeybindingOverrides), `frontend/src/main/keybinding-settings.ts` (validation), the renderer consumers of `window.ao.app.on*Shortcut` (grep `onNewSessionShortcut\|onFocusTerminalShortcut` etc. under `frontend/src/renderer`), `frontend/src/renderer/lib/bridge.ts` + `tauri-bridge.ts`.
Create: `frontend/src/renderer/lib/shortcut-engine.ts` (+ `.test.ts`).
Modify: `tauri-bridge.ts` ONLY in the 7 `app.on*` members: under Tauri they subscribe to the local shortcut-engine emitter instead of Tauri events (the engine runs in the same window). Do not change the fake/browser bridge or Electron path.

## Steps
1. Port the matching logic of app-shortcuts.ts (chord state machine, per-platform accelerators, recording-mode suspension) into `shortcut-engine.ts` operating on `window.addEventListener("keydown", ...)`. Reuse `shared/shortcuts.ts` definitions — do not duplicate tables.
2. Engine API: `initShortcutEngine(getOverrides: () => KeybindingOverrides | null)`, `setRecording(active)`, `on(channel, cb): () => void`. The tauri-bridge wires `keybindings.setRecording` to BOTH the Rust command (state for browser webviews later) and the local engine.
3. Load overrides at init via `keybindings_get`; re-read after every `keybindings.set`.
4. Port the test tables from `app-shortcuts.test.ts` and `shortcuts.test.ts` (keep originals passing — Electron still uses them until cleanup).
5. Initialize the engine from the tauri-bridge creation path only (never under Electron/browser fake).
6. `cd frontend && npm run typecheck && npx vitest run --config vite.renderer.config.ts`.

## Do NOT touch
Electron main/preload files; Rust code; `shared/shortcuts.ts` beyond exporting existing internals if needed (export-only changes allowed).

## Acceptance criteria
- typecheck + vitest → 0 failures, new engine tests included.
- `grep -n "addEventListener(\"keydown\"" frontend/src/renderer/lib/shortcut-engine.ts` → present.

## Return format
Files created/modified; chords covered; acceptance results; deviations.
