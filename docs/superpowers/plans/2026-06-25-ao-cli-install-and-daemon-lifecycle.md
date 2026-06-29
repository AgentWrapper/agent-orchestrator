# Daemon Shutdown = Adopt-Alive, Not Teardown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stopping the daemon (or losing the frontend) must NOT destroy live agent sessions. Sessions persist in the runtime and are re-adopted on the next boot, with their ids and context intact, on macOS/tmux exactly as on Windows/ConPTY.

**Architecture (validated by direct experiment):** tmux sessions survive the daemon process dying (they reparent to `launchd`), and the boot reconcile already adopts surviving sessions correctly. The bug is that the **graceful** shutdown path runs `SaveAndTeardownAll`, which calls `runtime.Destroy` (`tmux kill-session`) and DESTROYS the live session; the orchestrator then can't be restored (promptless → `ErrNotResumable`) and the frontend mints a new one (id increments). Fix: shutdown becomes a clean exit that leaves sessions alive; boot adopts them. The liveness link makes the daemon reliably stop when the frontend dies, via that same clean exit.

**Tech Stack:** Go daemon (`session_manager`, `daemon`, `httpd`, tmux/ConPTY runtimes), Electron main (TypeScript, `node:net`), `go test` + Vitest.

## Reproduction (recorded, sandboxed `AO_DATA_DIR`)

- Spawn worker + orchestrator → both get a live tmux session, DB `is_terminated=0`.
- `kill -9` daemon → tmux sessions survive → restart → both **adopted**: same id, `is_terminated=0`, same tmux session. No increment. ✅
- `ao stop` (graceful) → `SaveAndTeardownAll` → tmux sessions **killed**, marked `exited`, marker written → restart → orchestrator stays `is_terminated=1` (Restore returned `ErrNotResumable`) → `POST /orchestrators` creates `…-3` (num 2→3). ❌ This is the bug.

## Why only the orchestrator visibly breaks (workers are NOT immune)

The graceful path kills BOTH workers' and orchestrators' live sessions; the orchestrator is just the only one where the damage is visible, for two independent reasons that both happen to land on it:

1. **Restore failure is orchestrator-only.** Workers carry a saved `prompt`, so when the agent can't natively resume, `restoreArgv` falls back to relaunching fresh from the prompt and "succeeds". The orchestrator is promptless (`prompt=""` for all of them in the DB), so the same path hits `ErrNotResumable` (`manager.go:1238`) and it is left terminated.
2. **Auto-recreation is orchestrator-only.** The frontend calls `POST /api/v1/orchestrators` on load to _ensure_ an orchestrator; finding none active, it mints a new one (`num+1` → the visible `14→15→16`). Nothing auto-respawns workers, so a worker that fails to restore just silently vanishes.
   So both workers and the orchestrator lose their LIVE session + context on a graceful stop today; the orchestrator alone advertises it via the incrementing id. Task 1 (adopt-alive instead of teardown) restores live context for ALL sessions and needs no orchestrator special-casing — this is the unification you asked for.

## Global Constraints

- All app state under `~/.ao` (`AO_DATA_DIR`/`AO_RUN_FILE` overrides). Liveness socket under `~/.ao` (unix) / named pipe (Windows).
- No em dashes anywhere.
- Headless safety: a daemon with no frontend (CLI `ao start`) must never self-stop and must not have its sessions destroyed.
- `ao` on agent PATH already works in packaged builds via `HookPATH` (`session_manager/manager.go:1082`). No global install. Dev `go run` is the only gap (optional Phase D).
- Do not break genuine reboot recovery: when the runtime is truly gone, `reconcileLive` stashes the worktree and relaunches (work preserved). Keep that path.
- Mark shortcuts with `ponytail:` comments.

---

## File Structure

- **Modify** `backend/internal/daemon/daemon.go` — remove the `SaveAndTeardownAll` call from the normal shutdown path (`daemon.go:164`); the daemon exits leaving sessions alive. (Keep `Reconcile` on boot, which already adopts.)
- **Modify** `backend/internal/session_manager/manager.go` — `restoreArgv` (~1238): a promptless session relaunches fresh in the same id instead of `ErrNotResumable` (covers the reboot-only case). Audit/remove now-dead orchestrator divergence.
- **Create** `backend/internal/daemon/supervisor/{supervisor.go,listen_unix.go,listen_windows.go,supervisor_test.go}` — OS-native liveness listener + watchdog → triggers a clean shutdown (the same `RequestShutdown` the HTTP `/shutdown` uses) when the frontend link drops.
- **Modify** `backend/internal/daemon/daemon.go` — start the supervisor, publish its address (extend `runfile`/`/healthz`), wire `onLastClientGone` to `RequestShutdown`.
- **Create** `frontend/src/main/supervisor-link.ts` (+ test); **Modify** `frontend/src/main.ts` — hold the supervisor link open for the app lifetime; remove all daemon-stop logic from `before-quit`/`process.on("exit")`.

Phases (independently shippable):

- **Phase A** (Task 1): shutdown no longer tears down sessions → adopt-alive on the graceful path. THE fix; stops the increment and preserves context.
- **Phase B** (Tasks 2-4): OS-native liveness link → daemon cleanly stops when the frontend dies (no orphan), without tearing down sessions.
- **Phase C** (Task 5): promptless restore + de-segregate (covers the genuine reboot case).
- **Phase D** (Task 6, optional): dev `ao`-on-PATH.

---

## Task 1: Shutdown stops destroying live sessions (Phase A — the fix)

**Files:** Modify `backend/internal/daemon/daemon.go`.

**Change:** On the shutdown path (after `srv.Run` returns, `daemon.go:~162-166`), do NOT call `SaveAndTeardownAll`. The daemon exits and the tmux/ConPTY sessions stay alive; the next boot's `Reconcile`→`reconcileLive` adopts them (already implemented and verified). `SaveAndTeardownAll` is reserved for explicit teardown needs, not routine shutdown.

> Rationale proven above: with the teardown removed, the graceful path behaves like the hard-kill path, which already adopts cleanly. Uncommitted work is not lost: it stays in the on-disk worktree and, if the runtime is ever genuinely gone (reboot), `reconcileLive` stashes it on boot.

- [ ] **Step 1:** Write a failing `go test` at the daemon/session_manager seam: after a simulated graceful shutdown, live sessions remain non-terminated and their runtime handles are NOT destroyed. (Use the existing manager test doubles / a fake runtime that records `Destroy` calls; assert `Destroy` is not called on shutdown.)
- [ ] **Step 2:** Run it → FAIL (current code calls `SaveAndTeardownAll` → `Destroy`).
- [ ] **Step 3:** Remove the `SaveAndTeardownAll` invocation from `daemon.Run`'s shutdown sequence (keep ordered teardown of CDC/preview/lifecycle goroutines). Leave the function in place for explicit callers.
- [ ] **Step 4:** Run `go test ./internal/daemon/... ./internal/session_manager/... -race` → PASS (fix any test asserting the old teardown-on-shutdown).
- [ ] **Step 5:** Manual repro (sandbox `AO_DATA_DIR`): spawn orchestrator → `ao stop` → tmux session SURVIVES → `ao start` → orchestrator adopted, SAME id, no increment.
- [ ] **Step 6:** Commit `fix(daemon): do not tear down live sessions on shutdown; adopt them on boot`.

## Task 2: Supervisor watchdog core

**Files:** Create `backend/internal/daemon/supervisor/supervisor.go`, `supervisor_test.go`.
**Produces:** `New(grace, onLastClientGone, log)`, `(*Supervisor) Serve(ctx, ln net.Listener) error`. Arms on first accepted conn; when live count hits 0, starts `grace`; if it elapses still 0, calls `onLastClientGone()` once; a reconnect cancels it. Each conn read into a scratch buffer purely to detect close.

- [ ] **Step 1:** Failing tests: never fires pre-connect; fires once after grace on last disconnect; reconnect within grace cancels. Use `net.Pipe()` + a fake listener + short grace.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (mutex `liveCount`, `time.AfterFunc` grace, `sync.Once` fire).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(daemon): supervisor watchdog`.

## Task 3: Platform listeners + daemon wiring

**Files:** Create `supervisor/listen_unix.go`, `listen_windows.go`; Modify `daemon.go`.
**Produces:** `Listen(dataDir) (net.Listener, string, error)` — unix UDS at `~/.ao/supervise.sock` (unlink-stale first); windows named pipe `\\.\pipe\ao-supervise` (`//go:build windows`, via `go-winio` — confirm/declare the dep). Wire into `daemon.Run` after the HTTP server is up; publish `addr` (extend `runfile` write or `/healthz`); `go sup.Serve(ctx, ln)`; `onLastClientGone = deps.RequestShutdown`. Because Task 1 made shutdown non-destructive, a watchdog-triggered shutdown simply exits leaving sessions alive.

- [ ] **Step 1:** Implement listeners (unix first; windows behind build tag).
- [ ] **Step 2:** Wire + publish address.
- [ ] **Step 3:** `go build ./... && go vet ./...` clean (darwin at least).
- [ ] **Step 4:** Manual: start daemon, `nc -U ~/.ao/supervise.sock`, kill `nc` → daemon exits after grace, **tmux sessions still alive**; reconnect within grace → no shutdown.
- [ ] **Step 5:** Commit `feat(daemon): OS-native supervisor listener triggers clean shutdown`.

## Task 4: Electron holds the link; drop quit-time daemon teardown

**Files:** Create `frontend/src/main/supervisor-link.ts` (+ test); Modify `frontend/src/main.ts`.
**Produces:** `connectSupervisor(addr, opts?) -> { dispose() }` (`node:net` connect to UDS/pipe; retry with backoff if the daemon is not up yet; heartbeat byte every N s). In `main.ts`: connect after the daemon is ready (read addr from the handshake); **remove** all daemon-stop logic from `before-quit`/`process.on("exit")` (delete `killDaemon`/`ao stop`). Closing the app drops the socket → daemon self-stops cleanly, sessions persist.

- [ ] **Step 1:** Failing test: retry-until-connected against a throwaway `net.Server` on a temp UDS.
- [ ] **Step 2:** Run `pnpm vitest run src/main/supervisor-link.test.ts` → FAIL.
- [ ] **Step 3:** Implement `supervisor-link.ts`.
- [ ] **Step 4:** Edit `main.ts`; `pnpm tsc --noEmit && pnpm vite build --config vite.main.config.ts` clean.
- [ ] **Step 5:** Dev smoke: Cmd+Q AND `kill -9` Electron → daemon exits both ways, `running.json` gone, **tmux sessions still alive** → reopen → sessions adopted with context.
- [ ] **Step 6:** Commit `feat(desktop): supervisor link; daemon self-stops (clean) on frontend exit`.

## Task 5: Promptless restore + de-segregate (covers the reboot case)

**Files:** Modify `backend/internal/session_manager/manager.go`.
**Change:** In `restoreArgv` (~1238), when `ok=false` and `meta.Prompt==""`, relaunch fresh via `GetLaunchCommand` (empty prompt, system prompt only) instead of returning `ErrNotResumable`. This only matters when the runtime is genuinely gone (reboot) and `RestoreAll` runs; with Task 1, normal restarts adopt and never reach here. Remove orchestrator-only divergence the audit surfaces.

- [ ] **Step 1:** Failing `go test`: `restoreArgv` with `ok=false`, empty `AgentSessionID` + empty `Prompt` returns the fresh `GetLaunchCommand` argv, not `ErrNotResumable`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (drop the empty-prompt early return; fall through to `GetLaunchCommand`).
- [ ] **Step 4:** `go test ./internal/session_manager/... -race` → PASS.
- [ ] **Step 5:** Manual reboot-sim: spawn orchestrator → `tmux kill-server` (simulate reboot losing tmux) → restart daemon → orchestrator restored in the SAME id (not recreated).
- [ ] **Step 6:** Commit `fix(core): restore promptless sessions in place (reboot recovery, no increment)`.

## Task 6 (optional, Phase D): `ao` on agent PATH in dev

`HookPATH` needs the daemon binary named `ao`. Packaged satisfies this; dev `go run` produces a hash-named temp binary. If wanted, build a stable `~/.ao/dev/ao` once at dev startup and launch from it. Detail on request.

---

## Verification (whole feature)

- [ ] `go build ./... && go vet ./... && go test ./... -race` green; `cd frontend && pnpm vitest run && pnpm tsc --noEmit` green; full `pnpm build`.
- [ ] **Graceful stop preserves sessions:** spawn orchestrator → `ao stop` → tmux session ALIVE → `ao start` → orchestrator adopted, SAME id (reproduces the fix for the recorded bug).
- [ ] **Frontend death:** Cmd+Q AND `kill -9` Electron → daemon exits, sessions alive, reopen → adopted with context.
- [ ] **Reboot recovery:** `tmux kill-server` then restart → orchestrator restored in the same id.
- [ ] **Headless safety:** `ao start` from a terminal, no app → daemon runs forever, sessions intact.

## Self-Review

- Spec coverage: don't depend on clean close (Tasks 1+4), no orphan daemon (Task 4), orchestrator survives restart treated like a worker (Task 1 adopt; Task 5 reboot), OS-native pipe/socket transport (Tasks 2-3), `ao` to workers (HookPATH; dev = Task 6). Covered.
- Key insight baked in: the fix is primarily DELETION (stop tearing down on shutdown), validated by the hard-kill adopt experiment.
- Open implementation check (Task 1): confirm nothing else relies on `SaveAndTeardownAll` running at shutdown (e.g., a test or a resource-flush); the function stays available for explicit teardown.
