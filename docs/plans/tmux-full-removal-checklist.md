# tmux / ConPTY full removal checklist

**Status:** inventory + ordered deletion plan (docs deliverable)  
**Date:** 2026-08-04  
**Scope:** every `tmux` and `agent-conpty` / `conpty` dependency in this repo, what can be deleted when, and what tests break  
**Cutover readiness:** **NOT READY** — TUI sessions still require a Runtime implementation. Prefer this inventory PR over code deletion until a replacement Runtime ships.

## Executive summary

| Fact | Detail |
| --- | --- |
| Runtime port already exists | `ports.Runtime` + `ports.Attacher` in `backend/internal/ports/outbound.go`; union in `adapters/runtime/runtimeselect` |
| Platform pick today | Darwin/Linux → `adapters/runtime/tmux`; Windows → `adapters/runtime/conpty` |
| Soft delete of doctor messaging | **Unsafe** while spawn still requires `tmux` on PATH (`session_manager` prerequisite check) |
| Safe PR now | This checklist + optional comment-only / skill wording fixes that do not claim tmux is gone |
| Hard delete order | See §5 — **do not** delete `tmux/` package until a non-tmux Unix Runtime implements the same port |

**Status legend:** `TODO` | `IN_PROGRESS` | `DONE` | `BLOCKED` | `N/A` (keep until product decides)

---

## 1. Ordered deletion plan (top order)

| Step | Action | Depends on | Risk | Status |
| --- | --- | --- | --- | --- |
| **0** | Inventory + checklist (this doc) | — | Low | **DONE** |
| **1** | Keep using `ports.Runtime` / `runtimeselect`; document that callers must not import `tmux` or `conpty` packages directly | 0 | Low | **DONE** (port exists; enforce in review) |
| **2** | Land **replacement Unix Runtime** (process/PTY or Chat-mode only product path) implementing `ports.Runtime` + `Attacher` + send/interrupt | 1 | High | **TODO** / **BLOCKED** on product choice |
| **3** | Wire `runtimeselect.New` to replacement; feature-flag dual-run | 2 | High | **TODO** |
| **4** | Soften doctor / install docs: “runtime backend” not “must install tmux” | 3 proven in CI | Med | **TODO** (do **not** do before 3) |
| **5** | Rewrite prerequisite checks (`tmux required…` → runtime-agnostic prerequisite errors) | 3 | Med | **TODO** |
| **6** | Delete `adapters/runtime/tmux/**` + tmux-only integration tests | 3–5 green | High | **TODO** |
| **7** | Decide Windows: keep `conpty` as Runtime, or replace with same process model | Product | High | **TODO** |
| **8** | Delete or shrink `conpty/**` + `cli/ptyhost` if Windows replacement exists | 7 | High | **TODO** |
| **9** | Docs/landing/skills purge of tmux attach narratives | 6 | Low | **TODO** |
| **10** | CI / e2e-pod: stop installing `tmux` | 6 | Low | **TODO** |

**Do not reverse the order.** Deleting doctor “tmux required” before step 3 lies to users and breaks spawn UX.

---

## 2. Reference inventory (by area)

### 2.1 Backend — core runtime (delete only after replacement)

| Path | Role | Status |
| --- | --- | --- |
| `backend/internal/adapters/runtime/tmux/tmux.go` | Unix Runtime: new-session, send-keys, capture-pane, kill-session, pane reaper | TODO delete after §1 step 6 |
| `backend/internal/adapters/runtime/tmux/commands.go` | CLI arg builders | TODO |
| `backend/internal/adapters/runtime/tmux/tmux_test.go` | Unit tests | TODO rewrite/replace |
| `backend/internal/adapters/runtime/tmux/tmux_integration_test.go` | Real `tmux` binary integration | TODO delete or skip forever |
| `backend/internal/adapters/runtime/conpty/**` | Windows Runtime + pty-host IPC (`agent-conpty` host process) | TODO decide keep/replace (§1 step 7–8) |
| `backend/internal/adapters/runtime/ptyexec/**` | PTY spawn helpers used by tmux attach path | TODO audit after tmux gone (may still serve process Runtime) |
| `backend/internal/adapters/runtime/runtimeselect/runtimeselect.go` | Platform factory | IN_PROGRESS (keep; retarget New) |
| `backend/internal/cli/ptyhost.go` | Internal CLI entry for ConPTY host | TODO with conpty |
| `backend/internal/ports/outbound.go` | `Runtime`, `Attacher`, `Stream`, `ErrRuntimePrerequisite` | **DONE** keep forever |
| `backend/internal/ports/agent.go` | Comment mentions empty tmux pane | TODO wording |
| `backend/internal/ports/runtime_observations.go` | Reaper facts | **DONE** keep |

### 2.2 Backend — consumers (must stay Runtime-port-only)

| Path | Role | Status |
| --- | --- | --- |
| `backend/internal/daemon/daemon.go` | Wires runtime | TODO: no direct tmux import after cutover |
| `backend/internal/daemon/lifecycle_wiring.go` | Lifecycle + reaper + runtime | keep port wiring |
| `backend/internal/session_manager/manager.go` | Spawn, send, kill, reconcile reap; **PATH check for `tmux`** | TODO: replace prerequisite with runtime.Probe or equivalent |
| `backend/internal/session_manager/prompt.go` | Standing instructions: don’t write to tmux/PTY | TODO wording when Chat-mode primary |
| `backend/internal/lifecycle/manager.go` | Applies runtime death facts; comments re tmux session persistence | keep; de-tmux comments |
| `backend/internal/observe/reaper/reaper.go` | Polls `IsAlive`; comments re transient tmux outage | keep; de-tmux comments |
| `backend/internal/terminal/attachment.go` | Attach via Attacher | keep |
| `backend/internal/terminal/doc.go` | Documents tmux attach vs conpty dial | TODO rewrite |
| `backend/internal/service/shellterm/service.go` | Shell terminals reuse Runtime | keep port |
| `backend/internal/review/launcher.go` | Reviewer sessions via runtime | keep port |
| `backend/internal/cli/doctor.go` | `checkTmux` / conpty pass | **BLOCKED** soften until step 4 |
| `backend/internal/cli/client.go` | Timeout comment mentions tmux launch | TODO wording |
| `backend/internal/storage/sqlite/migrations/0027_shell_terminals.sql` | Schema comment only | N/A keep |
| `backend/internal/adapters/workspace/gitworktree/*` | incidental mentions | TODO if any hard deps |
| Agent adapters (`claudecode`, `kilocode`, tests for goose/aider/…) | mostly comments / PATH assumptions | TODO audit comments |

### 2.3 Backend — tests that **will break** or need rewrite when tmux is removed

| Test / file | Failure mode if tmux deleted without replacement | Replacement assertion |
| --- | --- | --- |
| `adapters/runtime/tmux/tmux_test.go` | package gone | Delete; cover new Runtime unit tests |
| `adapters/runtime/tmux/tmux_integration_test.go` | package gone / no binary | Delete; optional real-process integration |
| `terminal/attachment_integration_test.go` `TestAttachmentStreamsRealTmuxPane` | skips or fails without tmux | `TestAttachmentStreamsRealRuntimePane`: process alive + PTY read/write |
| Activity `observer_integration_test.go` `TestObserverIntegrationReconcilesRealTmuxOutputIntoSQLite` | needs real tmux output | Drive fake Runtime `GetOutput` or process Runtime capture |
| `session_manager/manager_test.go` `TestSpawn_RejectsMissingTmuxBeforeSessionRow` | string-matched `"tmux required"` | Assert `ErrRuntimePrerequisite` without tmux substring; or “runtime unavailable” |
| `TestReconcileReap_TerminatedButAliveTmuxDestroyed` / `…DeadTmuxLeftAlone` | name/comments only if fakes used | Rename to Runtime; assert Destroy only when `IsAlive` |
| `integration/lifecycle_sqlite_test.go` `TestReconcile_TerminatesDeadLiveSessionAndReapsLeakedTmux` | naming + any real handle | Leaked **runtime handle** destroyed when DB terminated |
| `cli/doctor_test.go` `TestDoctorChecksTmuxVersion*` / `TestDoctorWarnsWhenTmuxMissing` | doctor no longer checks tmux | Check “runtime” probe (process Runtime / none required) |
| `service/session/service_test.go` error fixture `"tmux required on macOS/Linux…"` | string match | Generic runtime prerequisite message |
| `service/shellterm/service_test.go` destroyErr strings `tmux: …` | cosmetic | Generic runtime errors |
| `httpd/terminal_mux_test.go` | if imports tmux semantics | Stream open/close against fake Attacher |
| `daemon/wiring_test.go` SessionMessenger → runtime pane | fake Runtime OK | Keep fakes |
| Lifecycle/reaper tests using handle id `"tmux-mer-1"` | naming only | Opaque handle ids (`rt-mer-1`) |
| Agent adapter tests looking up `tmux` in LookPath | spawn precheck changes | LookPath only agent binary |

### 2.4 Frontend

| Path | Role | Status |
| --- | --- | --- |
| `frontend/src/shared/shell-env.ts` | Forces usable `TERM` for **tmux attach** clients | TODO: keep TERM hygiene for any PTY attach; drop tmux-specific comments when attach client changes |
| `frontend/src/shared/shell-env.test.ts` | “tmux attach needs clear-screen” | TODO rewrite assertion text |
| `frontend/src/main/supervisor-link.ts` | Comment: grace leaves tmux/ConPTY alive | TODO wording |
| `frontend/src/renderer/components/XtermTerminal.tsx` | terminal UI (indirect) | keep |
| `frontend/src/renderer/components/XtermTerminal.test.tsx` | conpty mouse SGR note | TODO wording |
| Landing docs under `frontend/src/landing/content/docs/**` | install, platforms, runtimes/tmux.mdx, cli attach, etc. | TODO purge after step 9 |
| `frontend/src/landing/content/docs/plugins/runtimes/tmux.mdx` | dedicated tmux plugin page | TODO delete when runtime gone |
| `…/plugins/runtimes/meta.json`, `index.mdx`, `process.mdx` | runtime plugin index | TODO |
| Changelog / icons | historical | N/A or archive |

### 2.5 Docs (repo root)

| Path | Status |
| --- | --- |
| `docs/architecture.md` | TODO rewrite runtime diagrams after cutover |
| `docs/backend-code-structure.md` | TODO |
| `docs/cli/README.md` (`ao doctor` tmux) | **BLOCKED** with doctor |
| `docs/daemon-environment.md` | TODO PATH/tmux narrative → agent CLI PATH |
| `docs/stack.md`, `docs/STATUS.md` | TODO |
| `docs/plans/tmux-full-removal-checklist.md` | **DONE** (this file) |

### 2.6 CI / skills / e2e

| Path | Status |
| --- | --- |
| `test/e2e-pod/boot-real.sh` installs `tmux` | TODO remove apt install after step 10 |
| `skills/bug-triage/SKILL.md` | TODO triage via Runtime/process not `tmux ls` |
| `.github/workflows/*` | no hard `tmux` package pin found in inventory pass; re-scan at step 10 |

---

## 3. ABF process lifecycle vs AO lifecycle / reaper

### 3.1 AllBeingsFuture (Electron ProcessService + adapters)

```text
initSession → BridgeManager → adapter.init (spawn child / ACP connect)
send        → adapter.send (prompt)
stop        → adapter.stop (ACP session/cancel or interrupt; process may stay up)
destroy     → adapter.destroy (session/close best-effort → SIGTERM → SIGKILL)
app quit    → destroyAll
orphan purge on cold start (child session rows)
```

- **Process owner:** Electron main (or adapter child).  
- **Liveness:** process exit / adapter events; no separate reaper polling `tmux has-session`.  
- **Terminal persistence:** not the product model for ACP; cancel ≠ destroy.  
- **Cleanup:** explicit destroy tree; ACP adapter `shutdownProcess` SIGTERM then SIGKILL.

### 3.2 Agent Orchestrator (daemon)

```text
spawn → Workspace.Create → Runtime.Create(argv) → persist RuntimeHandleID + LaunchID
send  → Runtime.SendMessage / paste+enter (TUI)  [Chat path separate if present]
reaper Tick → Runtime.IsAlive (+ optional SupervisedProcessInspector)
         → Lifecycle.ApplyRuntimeObservation (only unambiguous dead/alive)
kill / MarkTerminated → Runtime.Destroy (+ container reap labels)
reconcile: DB terminated but runtime still alive → Destroy (leaked session reap)
attach → Attacher.Attach → terminal mux WebSocket → xterm
```

- **Process owner:** daemon-selected Runtime (`tmux` session or ConPTY host).  
- **Liveness:** **observe/reaper** polls facts; failed probe ≠ dead (must not force-kill).  
- **Terminal persistence:** historically **tmux is the persistence layer** across daemon restarts (session_manager comments); replacement Runtime must define restore/reattach semantics explicitly.  
- **Cleanup:** Destroy + pane process reaper (SIGTERM→grace→SIGKILL on pane session PIDs for tmux).

### 3.3 Mapping for purge / ACP cutover

| Concern | ABF | AO today | After tmux purge |
| --- | --- | --- | --- |
| Isolate agent | Child process / worktree | Runtime session + worktree | Same ports; new Runtime impl |
| Soft stop turn | `stop` / cancel | interrupt / send Ctrl-C via runtime | Chat: `session/cancel`; TUI: Runtime.Interrupt |
| Hard stop | destroy + kill | Runtime.Destroy + LCM terminate | Process group kill without tmux |
| Survive daemon restart | adapter-dependent | tmux session reuse / restore | Must implement restore or accept cold relaunch |
| Probe death | process exit | reaper `IsAlive` | `kill(pid,0)` / waitpid / heartbeat |
| UI terminal | optional | xterm via Attach | Keep Attach contract |

**Implication:** removing tmux without a Runtime that preserves **Create/Destroy/IsAlive/Attach/SendMessage/Interrupt** (and preferably Restart) breaks TUI mode entirely. Chat-mode-only products can leave TUI Runtime behind a flag but still need lifecycle facts for any remaining terminal sessions.

---

## 4. Replacement assertions (when tests stop using real tmux)

Prefer **behavior contracts** over “tmux binary present”:

| Old assertion | New assertion |
| --- | --- |
| `exec.LookPath("tmux")` succeeds | Runtime.Create returns handle; or probe `Runtime` health API |
| `tmux list-sessions` contains id | `IsAlive(handle) == true` |
| `tmux kill-session` | after Destroy, `IsAlive == false` and OS pid gone |
| capture-pane contains prompt | `GetOutput` / stream read contains expected bytes **or** Chat stream heartbeat / message.delta |
| Doctor PASS on `tmux -V` | Doctor PASS on “runtime backend ready” (no external mux) or skip tool |
| Leaked tmux after DB terminate | After reconcile, handle destroyed; no orphan process group |
| Integration attach resize | Second Attach adopts new rows/cols (fake or process Runtime) |
| Activity from pane output | Inject output via fake Runtime or process Runtime; project activity_state |

**Stream heartbeats (Chat / ACP path):** if TUI is retired for a harness, assert:

- turn started → deltas or heartbeat within timeout  
- cancel → terminal turn state without requiring pane alive  
- controller state ready/stopped  

Do not require `tmux` for Chat-mode e2e.

---

## 5. First safe code PR policy (this worker)

| Candidate | Verdict |
| --- | --- |
| Remove doctor “tmux required” | **No** — spawn still requires tmux on Darwin/Linux |
| Extract Runtime interface | **Already done** (`ports.Runtime`, `runtimeselect`) |
| Delete `adapters/runtime/tmux` | **No** — cascade break |
| Inventory checklist doc only | **Yes** (this PR) |

Optional follow-ups (separate tiny PRs once cutover starts):

1. Rename test helpers `fakeTmux` → `fakeRuntime` (no behavior change).  
2. Centralize prerequisite error: `fmt.Errorf("%w: terminal runtime unavailable", ErrRuntimePrerequisite)` without hardcoding `tmux` in session_manager (still LookPath inside tmux adapter).  
3. Docs architecture note: “Runtime adapter (tmux today)” → point to this checklist.

---

## 6. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Delete tmux before replacement Runtime | **Critical** | Gate on §1 step 2–3 green on Darwin CI |
| Soften doctor early | High | Users spawn-fail with opaque errors |
| Assume ConPTY can replace Unix | High | ConPTY is Windows-only design (loopback host) |
| Lose daemon-restart session persistence | High | Define restore semantics for process Runtime or accept relaunch |
| Integration tests silently skip without tmux | Med | Replace with process Runtime tests that fail closed in CI |
| Shell terminals share Runtime | Med | Migrate shellterm in same cutover |
| Frontend TERM hacks tied to tmux attach | Low | Keep generic PTY TERM floor |
| e2e-pod still apt-installs tmux | Low | Step 10 |

---

## 7. Suggested owners / parallel work

| Workstream | Owns |
| --- | --- |
| Replacement Runtime (process/PTY) | Backend runtime |
| runtimeselect + prerequisite | Backend daemon / session_manager |
| Reaper + lifecycle comment/tests | Backend lifecycle |
| Doctor + landing docs | CLI + docs after cutover |
| Chat stream without terminal | ACP/Chat workers (orthogonal; do not block on tmux delete) |
| This checklist maintenance | Update statuses as PRs land |

---

## 8. Definition of done (full purge)

- [ ] No package under `adapters/runtime/tmux`  
- [ ] `runtimeselect` does not import tmux  
- [ ] `rg -i tmux backend` only historical comments or zero hits  
- [ ] Doctor does not require external multiplexer on Darwin/Linux  
- [ ] CI / e2e-pod do not install tmux  
- [ ] Landing `plugins/runtimes/tmux.mdx` removed or redirected  
- [ ] All tests in §2.3 rewritten to Runtime/process/heartbeat assertions  
- [ ] Windows path explicit: keep conpty **or** shared process Runtime  

Until then, treat **tmux as load-bearing production code**, not legacy.

---

## Document control

| Item | Value |
| --- | --- |
| Deliverable | Inventory + ordered plan |
| Code deletion in this PR | None (cutover not ready) |
| Runtime interface | Already extracted |
| Next backend milestone | Replacement Unix Runtime behind ports |
