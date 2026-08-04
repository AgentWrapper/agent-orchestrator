# Plan: Remove tmux — ABF-style ACP process cutover

**Status:** planning (docs only) — hard pivot 2026-08-04  
**Human decision:** Fully remove **tmux** from agent-orchestrator; agents are **child processes** (ACP v1 stdio / HTTP), not interactive CLIs in tmux panes.  
**Architecture source of truth:** Desktop AllBeingsFuture (`/Users/zhongshengjieweilai/Desktop/AllBeingsFuture`)  
**AO design fit:** Chat/protocol in the **daemon** (fenzhi-style ports); renderer consumes sequenced stream events only — never ACP SDK, never raw PTY for the agent pane.

**Supersedes** the streaming-only framing in `docs/plans/acp-migration-from-abf-fenzhi.md` as the active product cutover goal. Streaming remains a **subsystem** of this plan (Phase 1), not the whole program.

---

## 1. Goal and non-goals

### 1.1 Goal

Replace AO’s agent execution model:

```text
TODAY
  spawn → worktree → runtime (tmux|conpty) → agent CLI in PTY
       → ao send = send-keys → /mux xterm attach → “alive” ≈ tmux session alive

TARGET (ABF-like)
  spawn → worktree (keep)
       → start ACP (or HTTP) child process via Process/Chat runtime
       → stream AgentStreamEvent over daemon SSE/WS
       → Chat / stream UI primary (not xterm agent pane)
       → send = protocol prompt (not keystrokes)
       → alive ≈ supervised child process / controller health (not tmux)
```

**Delete / stop using for agent sessions:**

- `backend/internal/adapters/runtime/tmux/**`
- Agent attach via terminal mux that assumes a tmux/conpty **agent** session
- `ao doctor` hard-dep on `tmux` for the agent path
- Lifecycle/reaper logic that treats “tmux session alive” as “agent alive” for ACP sessions
- `ao send` as `tmux send-keys` / ConPTY keystroke injection for agents

**Platform completeness:** Windows is not “tmux-only cleanup.” Replace the **conpty agent path** the same way (child process + stream), not only Darwin/Linux tmux.

### 1.2 Non-goals (this cutover)

- Cloning ABF Electron UI, missions, stickers, or proprietary chrome wholesale  
- Keeping dual agent modes forever (TUI-in-tmux + ACP) as a product end state — dual-run is a **migration bridge** only  
- Shipping every provider binding on day one (phased: stream + one producer, then expand)  
- Remote ACP over network (stdio local / HTTP API local-or-configured only)

### 1.3 Shell terminals (human: 全量去掉 tmux)

Human direction: **remove the tmux package entirely.** User shell tabs must not reintroduce tmux.

| Option | When |
| --- | --- |
| **A. Plain PTY shell runtime** (recommended if shell tabs stay) | New thin adapter: spawn user shell in a PTY (unix `pty`, Windows ConPTY **only for interactive shell**, not agent CLIs); shellterm service retargeted |
| **B. Defer shell tabs** | Hide/disable shellterm until a non-tmux PTY lands; agent cutover unblocked |

**Do not** leave shellterm wired to `runtimeselect` → tmux after Phase 4.

---

## 2. ABF process architecture (source of truth)

```text
Renderer
  agentStreamCore / batch / UI
        ▲  agent:stream (IPC in ABF)
ProcessService
  start / stop / send / stream / permissions / multi-agent
        │
BridgeManager ── ProviderAdapter
        │              ├─ AcpAdapter: child_process.spawn + ACP v1 NDJSON stdio
        │              └─ OpenAI (HTTP) etc.
        ▼
StreamNormalizer → sequenced AgentStreamEvent
```

Key ABF properties AO must match:

| Property | ABF | AO today | Target |
| --- | --- | --- | --- |
| Agent isolation | worktree / cwd on child | git worktree + tmux session | **worktree only** (+ process cwd) |
| Control plane | ProcessService + Bridge | session_manager + Runtime | Process/Chat runtime in daemon |
| User input | `sendMessage` → adapter protocol | `Send` → send-keys | protocol `session/prompt` (or HTTP) |
| Output | normalized stream events | PTY bytes → xterm | `AgentStreamEvent` SSE/WS |
| Stop | cancel turn / destroy process | interrupt keystroke / kill tmux | `session/cancel` + process teardown |
| Liveness | child process / adapter | tmux has-session / pane | process PID / controller state |
| Multi-agent | parent/child ProcessService | orchestrator + worker sessions | keep AO session graph; drop tmux per worker |
| tmux | **none** | required on Darwin/Linux | **none** |

Reference files (read-only):

- `electron/services/process.ts` — ProcessService  
- `electron/bridge/bridge.ts` — BridgeManager  
- `electron/bridge/adapters/acp.ts` — spawn + ACP  
- `electron/services/agent-stream-normalizer.ts` — sequence + map  
- `frontend/src/types/agentStreamTypes.ts` — wire events  
- `docs/acp-architecture.md`, `frontend/docs/acp-renderer-streaming.md`

---

## 3. AO today — tmux / runtime blast radius

### 3.1 Core agent path

| Area | Role of tmux/conpty |
| --- | --- |
| `adapters/runtime/tmux/**` | Create session, send-keys, capture-pane, attach, IsAlive |
| `adapters/runtime/conpty/**` | Windows agent PTY host (same Runtime interface) |
| `adapters/runtime/runtimeselect` | `tmux` on unix, `conpty` on Windows |
| `session_manager.Manager` | Spawn/restore: `runtime.Create`; Send: `SendMessage`; kill: `Destroy`; prerequisites: **tmux on PATH** |
| `lifecycle` + `observe/reaper` | RuntimeFacts: session alive vs workload dead (tmux pane vs process) |
| `terminal` + `httpd` terminal mux | Attach Stream → xterm agent pane |
| `cli/doctor.go` | `tmux` version check (warn/fail) on non-Windows |
| Agent plugins | Build **argv** for CLI launch into runtime shell |

### 3.2 Secondary users of Runtime (must retarget)

| Area | Today | After cutover |
| --- | --- | --- |
| `service/shellterm` | Same Runtime as agents (tmux/conpty) | Plain PTY shell adapter **or** deferred |
| `review/launcher` | May use runtime patterns | Review agent via ACP process or explicit non-tmux path |
| Tests / fakes | `fakeRuntime`, tmux string fixtures | Process runtime fakes |

### 3.3 What to keep

- Git worktree workspace adapter (`adapters/workspace/gitworktree`)  
- Session/project domain, SQLite session rows, CDC for session facts  
- Orchestrator/worker session model, hooks, SCM, PR, notifications  
- Loopback daemon HTTP, thin CLI  
- `~/.ao` state rules  

---

## 4. Target architecture (AO-shaped)

```text
CLI / Desktop
    │  loopback HTTP
    ▼
Daemon
  session_manager.Spawn
      │  1) workspace.Create (worktree) — UNCHANGED
      │  2) processRuntime.Start(session) — NEW (ACP/HTTP child)
      │  3) streamHub.Configure(session)
      ▼
  Chat/Process controller (ABF ProcessService role)
      │  SendTurn / Interrupt / ResolvePermission / Destroy
      ▼
  adapters: acp | http-provider | (later bindings)
      │  stdio NDJSON or HTTP
      ▼
  StreamNormalizer → AgentStreamEvent
      │
      ├─▶ SSE GET /api/v1/sessions/{id}/agent-stream
      └─▶ (optional later) durable conversation projector

Lifecycle / reaper
  Agent alive := process/controller health + launch id
  NOT tmux has-session

Frontend
  Stream timeline primary
  Agent xterm pane hidden/removed
  Optional: user shell tab via plain PTY (no tmux)
```

### 4.1 Port split (do not overload Runtime)

| Port | Responsibility |
| --- | --- |
| `Workspace` | worktree create/destroy/restore (keep) |
| **`AgentProcess` / Chat driver** (new or fenzhi `ChatDriver`) | Start/resume/stop child; prompt; cancel; events |
| `StreamHub` | Per-session sequence, fan-out SSE |
| `ShellPTY` (optional, separate) | User shell only — **never** used for agent CLIs |
| ~~`Runtime` tmux/conpty for agents~~ | **Delete** after cutover |

Fenzhi reference (boundary only): Chat is separate from terminal keystroke ports; provider DTOs stay in adapters; production floor for mutating agents = streaming + approvals + interrupt + resume.

### 4.2 Wire: AgentStreamEvent (ABF)

Keep ABF stream union as daemon→UI JSON (see prior streaming plan). Transport: **session SSE** (preferred) or WS. Sequence monotonic per session; append-only deltas; plan replace; permission out-of-band POST.

### 4.3 Send / interrupt / kill / restore

| Operation | Today | Target |
| --- | --- | --- |
| Send | `tmux send-keys` / conpty write | `session/prompt` or provider HTTP chat |
| Interrupt | C-c keystroke | `session/cancel` + cancel pending permissions |
| Kill session | destroy tmux + worktree policy | stop process → close ACP → worktree policy unchanged |
| Restore / daemon restart | reattach tmux if alive | **resume** provider conversation or fail loud (`resume failed`); re-spawn child; no tmux reattach |
| Liveness | runtime session exists | child PID / controller state / negotiated session id |

### 4.4 Windows

| Today | Target |
| --- | --- |
| `conpty` Runtime hosts agent CLI | Same ACP/HTTP **child process** model as unix (pipes, not agent ConPTY) |
| doctor “conpty built-in” as agent prereq | doctor checks process runtime / provider binary, not tmux, not agent-conpty |
| ConPTY may remain **only** for optional user shell PTY | Not for agent path |

---

## 5. Phased PR breakdown

### Phase 0 — Docs (this file)

- Land cutover plan; mark older ACP plan as superseded for product goal.  
- **Exit:** team agrees no-tmux end state + process architecture.

### Phase 1 — ACP process runtime + stream pipeline (replace agent launch core)

**Build:**

1. Internal process runtime: spawn supervised child (stdio), env, cwd=worktree, kill tree on destroy.  
2. ACP v1 client (prefer Go `acp-go-sdk` in daemon; ABF TS is reference only).  
3. StreamNormalizer + StreamHub + SSE `GET /api/v1/sessions/{id}/agent-stream`.  
4. Fake ACP agent + unit tests (handshake, prompt, tools, permission, cancel).  
5. Feature flag / session flag `execution=acp` (or force all new spawns once ready).

**Still allowed temporarily:** old tmux path for unflagged sessions (bridge only).

**Success:** spawn ACP fake → sequenced events on SSE; no tmux binary used on that path.

### Phase 2 — Session spawn / send / kill / restore without tmux

**Change `session_manager` (and services):**

| API | Behavior |
| --- | --- |
| Spawn | worktree + `AgentProcess.Start`; store process/provider conversation id; **no** `runtime.Create` for agents |
| Send | protocol send; reject keystroke path for ACP sessions |
| Interrupt / stop turn | process cancel |
| Kill / cleanup | process Destroy + existing worktree rules |
| Restore / RestoreAll | resume or recreate process; remove tmux restart/relaunch branches for agents |
| validateRuntimePrerequisites | remove tmux LookPath for agent spawn |

**Lifecycle / reaper:**

- Stop treating “runtime session alive + workload dead” as the primary agent model for ACP.  
- Agent death = process exit / controller stopped (with existing “failed probe ≠ dead” caution).  
- Drop or rewrite reaper paths that inspect tmux panes / supervised process **inside** tmux.

**CLI:** `ao send`, `ao session kill`, restore paths updated; docs strings that mention tmux send-keys fixed.

**Success:** end-to-end agent session on Darwin/Linux/Windows CI matrix **without** `tmux` installed (agent path).

### Phase 3 — Frontend: stream UI primary; hide agent terminal

1. Port ABF pure stream modules (types, reduce, batch, parse) + tests.  
2. EventSource (or WS) client → timeline UI in session workbench.  
3. Permission resolve POST; stop/interrupt control.  
4. **Hide/remove agent xterm pane** for ACP sessions (no `/mux` attach to agent handle).  
5. New Task / session UX assumes chat stream, not “open terminal to type at CLI”.  
6. Optional: keep xterm **only** for user shell tabs if Phase 4A ships plain PTY.

**Success:** primary agent interaction is stream UI; no dependency on agent mux for happy path.

### Phase 4 — Remove tmux adapter + doctor + docs + tests

**Delete / purge:**

- `backend/internal/adapters/runtime/tmux/**`  
- `runtimeselect` tmux branch (and agent conpty path — see Phase 5)  
- doctor `tmux` check and tests  
- session_manager tmux prerequisite + comments  
- integration tests that require real tmux for agents  
- architecture/STATUS/stack/cli docs that mandate tmux for agents  
- prompt text telling agents not to write to tmux (replace with AO send / protocol wording)

**Shell:** implement plain PTY shell **or** disable shellterm; **must not** call deleted tmux package.

**Gate:**

```bash
# Agent path must be clean. Allow only migration notes under docs/plans/ or changelog.
rg -n 'tmux' backend --glob '*.go'
# Expect: zero hits in adapters/runtime, session_manager agent path, doctor, lifecycle agent probes
# Residual comments in historical docs/plans only if explicitly retained
```

**Success criteria (human):**

- [ ] `rg tmux backend` zero for agent path (or only historical docs/migration notes)  
- [ ] Spawn agent works with **ACP stream only**  
- [ ] No `tmux` binary required for `ao doctor` agent path  

### Phase 5 — Windows: replace conpty **agent** path the same way

Do not treat “deleted tmux” as done on macOS only.

1. Stop using `adapters/runtime/conpty` for **agent** Create/Send/Attach.  
2. Same `AgentProcess` + ACP/HTTP + SSE on Windows.  
3. doctor: remove agent-conpty-as-session-runtime framing; check Node/provider as needed.  
4. Delete or shrink conpty package to **shell-only** PTY host, or delete if shell deferred.  
5. CI job without tmux; Windows job without agent conpty dependency.

**Success:** Windows agent spawn/stream/kill green; no tmux; no agent-conpty.

### Suggested sequencing

```text
P0 docs
  └─▶ P1 process + stream (+ flag)
        └─▶ P2 session_manager / lifecycle / send / restore
              ├─▶ P3 frontend stream UI (// after stream SSE stable)
              └─▶ P5 windows in parallel with P2/P3 once process runtime is OS-agnostic
                    └─▶ P4 delete tmux + doctor + docs (when flag default ON and P5 agent path done)
```

P4 is last: no deletion until agent path default is ACP and shell strategy is decided.

---

## 6. File-level change map

### 6.1 Add (primary)

| Area | Suggested location |
| --- | --- |
| Process/ACP runtime | `backend/internal/adapters/agentproc/` or `chatdriver/acp/` (fenzhi-style) |
| Stream normalizer + hub | `backend/internal/agentstream/` |
| SSE controller | `backend/internal/httpd/` + OpenAPI |
| Frontend stream core | `frontend/src/renderer/lib/agent-stream/` |
| Stream timeline UI | `frontend/src/renderer/components/...` (minimal chat surface) |
| Shell PTY (if kept) | `backend/internal/adapters/runtime/shellpty/` — **not** named tmux |

### 6.2 Rewrite

| File / package | Change |
| --- | --- |
| `session_manager/manager.go` | Spawn/Send/Kill/Restore without agent Runtime |
| `lifecycle/*`, `observe/reaper/*` | Process-based facts |
| `daemon/*` wiring | Wire process runtime + stream hub; unwire agent tmux |
| `cli/doctor.go` | Drop tmux agent check |
| `cli/send.go` + HTTP send | Protocol send |
| `ports/outbound.go` | Deprecate agent Runtime; add process ports |
| Frontend session terminal | Hide agent mux; show stream |
| `docs/architecture.md`, `STATUS.md`, `stack.md`, `cli/README.md` | No tmux requirement |

### 6.3 Delete (end state)

| Path |
| --- |
| `backend/internal/adapters/runtime/tmux/**` |
| Agent-only usage of `conpty` (package shrink or delete) |
| `runtimeselect` as agent backend selector (replace or delete) |
| Tests that shell out to `tmux` for agent e2e |

### 6.4 From ABF (logic, not Electron)

| Concept | Port into |
| --- | --- |
| ProcessService lifecycle | session_manager + process service |
| AcpAdapter spawn/map | Go ACP adapter |
| StreamNormalizer | Go + TS reduce (UI) |
| AgentStreamEvent | SSE JSON + frontend types |
| Permission broker | HTTP resolve + parked requests |

### 6.5 From fenzhi (optional accelerator)

If available: `ports/chat.go`, `chatdriver/acp`, `service/chat`, conversation durability — **after** process+stream work, not as a blocker for deleting tmux. Prefer process+stream cutover over waiting for full Chat product parity.

---

## 7. Migration / dual-run strategy

1. **Flag** `AO_AGENT_EXECUTION=acp|tui` or per-session mode (default tui → default acp → remove tui).  
2. New sessions: ACP once Phase 2 is default.  
3. Existing live tmux sessions: support until daemon restart, then restore via ACP resume or mark interrupted — **no** forever dual stack.  
4. P4 deletion only when: default ACP, Windows green, shell non-tmux, CI without tmux package.

---

## 8. Risks

1. **Providers without good ACP** — interim: HTTP adapter (ABF openai-style) or single CLI wrapper that speaks ACP; avoid resurrecting tmux.  
2. **Loss of “reattach to live CLI”** — intentional; resume is protocol resume, not pane attach.  
3. **Shellterm coupling** — shell still on tmux blocks P4; decide PTY vs defer early.  
4. **Reaper false positives/negatives** — rewrite probes carefully; failed probe ≠ dead (existing AO rule).  
5. **Windows process job control** — kill process trees correctly without ConPTY agent host.  
6. **Orchestrator agents expecting TUI** — standing prompts / hooks must say protocol send, not terminal.  
7. **Large session_manager blast radius** — surgical flags first; avoid big-bang rewrite without tests.  
8. **Review launcher / secondary runtimes** — hunt all `runtime.Create` call sites before deleting tmux.

---

## 9. Success criteria (checklist)

### Product

- [ ] Spawn agent creates worktree + ACP/HTTP child only (no tmux session).  
- [ ] Send delivers protocol turns; stream UI shows text/tools/plan/permissions.  
- [ ] Interrupt/cancel does not use send-keys C-c.  
- [ ] Kill/teardown does not call tmux kill-session.  
- [ ] Restore works without tmux reattach.  
- [ ] Agent terminal pane not required for agent work.  
- [ ] Windows agents use the same process model (not leftover agent-conpty).

### Engineering gates

- [ ] `rg -n tmux backend --glob '*.go'` clean for agent path (no adapter, no doctor, no spawn prereq).  
- [ ] `ao doctor` does not require `tmux` binary for agent health.  
- [ ] CI agent e2e runs in environment **without** tmux installed.  
- [ ] Frontend has no ACP SDK; stream over loopback HTTP only.

---

## 10. Recommended worker spawn order

1. **Docs** — this plan (P0).  
2. **Backend process + stream** (P1) — OS-agnostic child + normalizer + SSE + fake ACP.  
3. **Backend session_manager cutover** (P2) — spawn/send/kill/restore + lifecycle/reaper.  
4. **Frontend stream UI** (P3) — parallel once SSE contract frozen.  
5. **Windows agent process parity** (P5) — parallel with P2/P3.  
6. **Shell strategy** — plain PTY or disable shellterm (before P4).  
7. **Delete tmux + doctor + docs** (P4) — last.

Avoid concurrent edits to `session_manager/manager.go` and `adapters/runtime/tmux` deletion until P2 flag is default.

---

## 11. Explicit next actions for implementers

1. Inventory every `runtime.Create` / `SendMessage` / `Attach` / `IsAlive` call site; tag agent vs shell vs review.  
2. Implement **AgentProcess** + fake ACP + SSE (P1) behind flag; prove no tmux on that path.  
3. Switch spawn/send for flagged sessions; add lifecycle process facts.  
4. Land frontend stream reduce + minimal timeline; hide agent xterm when `execution=acp`.  
5. Decide shell: plain PTY package vs feature-off.  
6. Flip default to ACP; run CI without tmux.  
7. Delete `adapters/runtime/tmux`, doctor checks, docs; shrink conpty to shell-only or delete.  
8. Update `docs/architecture.md` / `STATUS.md` to describe process agents.

---

## 12. Open decisions

| Decision | Options | Recommendation |
| --- | --- | --- |
| Dual-run duration | Flag one release vs hard cut | Flag until P2+P3 green, then default ACP within same epic |
| Shell tabs | Plain PTY vs defer | Plain PTY if shell is product-critical; else defer to unblock P4 |
| First real producer | Fake only → Claude ACP → Codex app-server | Fake for P1; one real provider before default flip |
| Durable chat DB | Stream-only vs fenzhi conversations | Stream-only sufficient to delete tmux; durability can follow |
| `ao send` semantics | Always protocol | Yes for all agents post-cutover |

---

## 13. Related docs

| Doc | Role |
| --- | --- |
| `docs/plans/abf-no-tmux-acp-cutover.md` | **This plan — active cutover** |
| `docs/plans/acp-migration-from-abf-fenzhi.md` | Streaming subsystem detail; superseded as overall goal |
| ABF `docs/acp-architecture.md` | Process + stream contracts |
| fenzhi `ports/chat.go` + `chatdriver/acp` | Optional Go implementation reference |

---

*Plan only. Implementation must follow `AGENTS.md` (loopback daemon, thin CLI, no renderer protocol logic, `~/.ao` only).*
