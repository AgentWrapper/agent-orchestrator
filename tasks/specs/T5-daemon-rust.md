# T5 — Módulo Rust de supervisão do daemon

## Objective
Fill `frontend/src-tauri/src/daemon/mod.rs` (currently stubs) with the real daemon supervision: resolve the `ao` binary, run `ao daemon ensure --owner app --json`, hold the supervise-socket connection, expose start/stop/restart/status commands and emit `daemon://status` events.

## Files
Read (semantics to port):
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/shared/daemon-launch.ts` (binary resolution: `AO_DAEMON_COMMAND` env override w/ shell → dev `go run ./cmd/ao daemon` when `../backend/go.mod` exists relative to the project → bundled sidecar)
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/shared/daemon-status.ts` (the `DaemonStatus` shape the renderer expects — replicate field names EXACTLY in serde-serialized JSON)
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/main/supervisor-link.ts` and `/Users/paulo/Projects/agent-orchestrator/frontend/src/main/daemon-owner.ts` (supervise socket: `~/.ao/supervise.sock` unix, `\\.\pipe\ao-supervise-<dirhash>` windows — port the pipe-name derivation exactly; link only when owner is `app`; daemon self-stops ~5s after EOF)
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/shared/shell-env.ts` (login-shell PATH probe, 3s timeout) — port into `frontend/src-tauri/src/shell_env.rs`
- `/Users/paulo/Projects/agent-orchestrator/frontend/src/main.ts` lines 453–481 (`daemonEnv()`: `AO_OWNER`, `AO_APP_RUN_ID`, dev isolation `AO_PORT=3002`, `AO_RUN_FILE=~/.ao/dev/running.json`, `AO_DATA_DIR` dev override)
- The Go side already implements attach/spawn/takeover: run `cd /Users/paulo/Projects/agent-orchestrator/backend && go run ./cmd/ao daemon ensure --help` and read `/Users/paulo/Projects/agent-orchestrator/backend/internal/cli/daemon_ensure.go` for the JSON output shape.

Modify:
- `frontend/src-tauri/src/daemon/mod.rs` (replace stubs; keep command names/signatures)
- `frontend/src-tauri/src/shell_env.rs`
- `frontend/src-tauri/src/lib.rs` ONLY to add `.manage(...)` state and the `.setup(...)` hook if needed — do not alter plugin/command registration lines.
- Cargo.toml: DO NOT edit — `interprocess` is already added by the orchestrator.

## Steps
1. `DaemonState` struct in a `tauri::State<Mutex<...>>`: current status, child/link handles, app run id (uuid via `std::time`-seeded or add no new deps — derive from pid+timestamp).
2. `daemon_start`: resolve launch (env override / dev `go run` with cwd `<repo>/backend` when `go.mod` found by walking up from the executable and also from `CARGO_MANIFEST_DIR` in debug builds / sidecar path `ao` next to the app resources via `tauri::path::BaseDirectory::Resource`), build env (login-shell PATH probe with 3s timeout, dev isolation when `cfg!(debug_assertions)`), then run `<ao> daemon ensure --owner app --json` with 30s timeout via `tokio::process::Command`, parse the JSON line, connect the supervise link (mode `spawned`/`takeover`), update state, emit `daemon://status`.
3. `daemon_get_status`: return current status; if never started, probe like start but without spawning (run ensure only if explicitly started — a plain status when unstarted returns the `stopped`-equivalent shape from daemon-status.ts).
4. `daemon_stop`: drop the supervise connection (daemon self-stops ≤5s) and, if we spawned it, SIGTERM the process group as backstop (unix `killpg`; windows taskkill by pid tree). Wait for /healthz to stop answering (poll ≤5s), update + emit status.
5. `daemon_restart`: stop then start.
6. Supervise link with the `interprocess` crate (localsocket): open on start, keep alive in state; reconnect not required (matches Electron behavior).
7. Status events: every transition emits `daemon://status` with the exact DaemonStatus JSON (serde `rename_all = "camelCase"` or explicit renames to match).
8. Unit tests (`#[cfg(test)]`): binary-resolution table (env override / dev / sidecar), pipe-name derivation vs the TS test expectations in `frontend/src/main/supervisor-link.test.ts` (port the cases), DaemonStatus serialization field names, shell-env parse table from `frontend/src/shared/shell-env.test.ts`.
9. `cd frontend/src-tauri && cargo check && cargo test && cargo clippy -- -D warnings 2>/dev/null || cargo clippy` (report clippy result either way).

## Do NOT touch
`frontend/src/**` (TypeScript), `backend/**`, `settings/mod.rs`, `misc/mod.rs`, `import_scan.rs`, `tauri.conf.json`, `capabilities/`.

## Acceptance criteria
- `cd frontend/src-tauri && cargo check` → 0
- `cd frontend/src-tauri && cargo test` → 0 failures, incl. the ported tables
- Serialized `DaemonStatus` JSON field names byte-match `frontend/src/shared/daemon-status.ts`.

## Return format
Files modified; ensure-invocation summary (args/env); ported test tables; acceptance results; deviations with reason.
