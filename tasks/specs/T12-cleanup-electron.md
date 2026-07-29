# T12 (M7) — Remoção do Electron

> Só rodar depois que M0–M6 estiverem verificados e o app Tauri validado manualmente pelo usuário.

## Objective
Delete the Electron shell and its build/release machinery; the Tauri app becomes the only desktop shell.

## Files
Delete: `frontend/src/main.ts`, `frontend/src/preload.ts`, `frontend/src/annotate-preload.ts`, `frontend/src/main/**`, `frontend/forge.config.ts`, `frontend/makers/**`, `frontend/vite.main.config.ts`, `frontend/vite.preload.config.ts`, `frontend/scripts/feed.mjs`, `blockmap.mjs`, `feed.test.mjs`, `blockmap.test.mjs`, old workflows `frontend-release.yml`/`build-artifacts.yml`/`testing-build.yml`/`desktop-testing.yml`/`release-latest-guard.yml` (feature-release.yml only if T11 replaced it), `.github/actions/macos-signing-setup` parts now unused.
Modify: `frontend/package.json` (remove electron/forge/app-builder-lib/electron-updater/electron-installer-* deps and dev/package/make/publish scripts; `dev` → `tauri dev`), `frontend/tsconfig.json` (drop forge/makers includes), `backend/internal/config/config.go` (remove `app://renderer` origin), `frontend/src/shared/*` files that referenced main-process-only code, docs (`frontend/docs/desktop-release.md`, `AGENTS.md` frontend description, `CLAUDE.md` userData rule → `~/.ao/tauri`), `backend/internal/cli/start.go` constants IF the team decides to point `ao start` at Tauri artifacts (flag, don't decide).

## Steps
1. Confirm precondition (orchestrator will have stated it in the dispatch message). 2. Delete/modify per above, chasing compile errors: `npm run typecheck`, `npm run typecheck:e2e`, vitest, `cargo check/test`, `cd backend && go build ./... && go test ./...`. 3. Grep `electron` across repo — remaining hits only in docs/history/lockfile-free contexts; report each. 4. Update `.gitignore` entries that pointed at forge outputs.

## Acceptance criteria
- `cd frontend && npm ls electron` → empty/error (not installed).
- All suites green: typecheck, typecheck:e2e, vitest, cargo test, go test ./...
- `grep -ril electron frontend/src backend/internal` → no source hits (docs ok).

## Return format
Deleted/modified lists; remaining `electron` mentions with justification; acceptance results.
