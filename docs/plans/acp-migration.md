# Plan: ACP Migration (Node Sidecar, Drop Tmux Agent Path, Chat UI)

**Status:** design only (this PR). No production runtime code lands here.  
**Audience:** implementer workers starting PR1 of the phased DAG below.  
**Date:** 2026-07-28

## Goal

Replace AO’s agent primary IO path (tmux/conpty + xterm PTY attach + `send-keys` paste) with **Agent Client Protocol (ACP)** as the sole agent control and streaming surface:

- Go daemon remains the supervisor of sessions, workspaces, lifecycle, SQLite, and HTTP.
- A **Node sidecar** (`acp-bridge`) speaks official ACP via `@agentclientprotocol/sdk`.
- Electron + React shows a **chat input + streaming reply** surface (`ChatPane`) instead of xterm as the primary agent UI.
- Shell/debug terminal (if retained later) is **out of scope for agent IO**; it must never be required for spawn/send/stream/kill of agents.

This plan is intentionally implementable without reference to third-party app source.

---

## Binding product decisions

| # | Decision | Implication |
|---|----------|-------------|
| 1 | **Remove tmux/conpty as agent IO path** | Agents use ACP only. No dual-path fallback for agent spawn/send/stream/kill. |
| 2 | **Node sidecar + official SDK** | `acp-bridge` uses `@agentclientprotocol/sdk`; Go daemon supervises the process. Go does not reimplement the ACP wire protocol. |
| 3 | **Electron + React chat UI** | Primary agent surface is chat input + streaming replies (`ChatPane`), following AO `DESIGN.md` (refined-blue, shadcn). |
| 4 | **Broad multi-agent via AO registry + official ACP** | Map existing AO harnesses through **our** adapter registry. Independent design — not a port of any third-party product’s agent list or configs. |

---

## IP / clean-room rules (lawsuit prevention)

These rules are **load-bearing** for every PR in this migration. Reviewers enforce them verbatim.

### Allowed sources

- Public **Agent Client Protocol** documentation and schema: [agentclientprotocol.com](https://agentclientprotocol.com/), including protocol overview, prompt-turn model, session methods, and the published JSON schema.
- Official SDKs only, e.g. `@agentclientprotocol/sdk` (TypeScript) and any official language bindings published under the `agentclientprotocol` org.
- Public ecosystem facts at a high level (that ACP exists; that many coding agents advertise ACP support).
- **This repository’s own code**, `DESIGN.md`, `docs/architecture.md`, and AO domain names.

### Forbidden

- Do **not** copy code, comments, UI trees, assets, i18n strings, PRDs, adapter JSON, config schemas, icons, or directory structure from **AionUi** or any other third-party multi-agent desktop app.
- Do **not** clone look-and-feel, component names, or interaction patterns from those products.
- Do **not** vendor large excerpts of third-party source into this repo.
- Do **not** “port” another app’s IPC message names, bridge layout, or adapter registry format.

### Independent design requirements

- Use **AO-native names**: `acp-bridge`, `ChatPane`, AO harness IDs (`domain.AgentHarness`), AO session IDs, AO HTTP/SSE paths under `/api/v1/...`.
- Design the **Go ↔ Node IPC contract** independently for AO (section below). It is not the ACP wire protocol and is not another product’s IPC.
- Chat UI must follow **this repo’s `DESIGN.md`** (refined-blue accent, existing shadcn primitives, session chrome). Divergence from third-party UIs is required, not accidental.
- Mention third-party multi-agent clients only as **high-level prior art** (“other products use ACP for structured agent IO”), never as code to port.

### Review checklist (every implementation PR)

- [ ] Diff contains no third-party app source, assets, or copied adapter configs.
- [ ] New packages/modules use AO naming (`acp-bridge`, `ChatPane`, harness IDs).
- [ ] Protocol constants that match ACP come from **official schema/SDK**, cited in comments as public ACP names only where necessary.
- [ ] UI components do not mirror third-party component trees or class naming.

---

## Problem statement (current state)

Today, AO treats a coding agent as a process living inside a **terminal multiplexer runtime**:

```text
Electron / CLI
    │ REST / SSE / WebSocket /mux
    ▼
Go daemon (httpd + SessionManager + lifecycle)
    │
    ├─ Agent adapter: GetLaunchCommand / hooks / restore argv
    ├─ Runtime: tmux (Darwin/Linux) or conpty pty-host (Windows)
    │     └─ Execute agent CLI inside pane; paste via send-keys / PTY write
    └─ Frontend: XtermTerminal attached over /mux
```

Relevant code today (read-only anchors for implementers):

| Area | Location |
|------|----------|
| Session spawn / send / kill | `backend/internal/session_manager/manager.go` |
| Runtime port | `backend/internal/ports/outbound.go` (`Runtime`, `Attacher`, `Stream`) |
| Agent port | `backend/internal/ports/agent.go` (`GetLaunchCommand`, prompt delivery, restore) |
| Harness IDs | `backend/internal/domain/harness.go` |
| Adapter registry | `backend/internal/adapters/agent/registry/` |
| Terminal mux | `backend/internal/httpd/terminal_mux.go` |
| Frontend agent UI | `frontend/src/renderer/components/TerminalPane.tsx`, `XtermTerminal.tsx` |
| Shell terminals (non-agent) | `backend/internal/service/shellterm/`, `ShellTerminalsView.tsx` |

### Pain this migration removes

1. **Brittle paste IO** — `ao send` / SessionManager `Send` depends on pane paste + Enter, with harness-specific “nudge” loops because there is no delivery ack.
2. **PTY as protocol** — tool permission dialogs, streaming tokens, and activity are scraped from terminal bytes or hooks rather than structured messages.
3. **tmux/conpty operational cost** — PATH, attach failures, Windows parity, doctor checks, and reaper probes all hinge on a mux AO only needed because agents are terminal apps.
4. **UI mismatch** — supervisors think in messages and tool turns; xterm forces full terminal chrome for every agent session.

---

## Target architecture

```text
Electron ChatPane / CLI
    │ REST (spawn, send, kill, permissions)
    │ SSE / stream (chat deltas, tool events, activity)
    ▼
Go daemon
    │ SessionManager (no tmux/send-keys for agents)
    │ lifecycle / reaper / SQLite / workspace / PR facts
    │
    └─ supervises ──► acp-bridge (Node sidecar)
                            │ @agentclientprotocol/sdk
                            │ stdio / transport per official ACP
                            ▼
                      Agent process (per harness ACP adapter config)
```

### What stays in Go

- Session domain, durable facts, status derivation at read time.
- Workspace/worktree provision and teardown.
- Lifecycle, reaper, PR/check/comment observation.
- HTTP API, CLI thin client, SSE broadcaster, CDC.
- Supervision of `acp-bridge` (start, health, restart policy, shutdown).
- Permission decisions authored by the user (daemon stores + answers; bridge forwards via ACP).

### What moves to `acp-bridge` (Node)

- Official ACP client session lifecycle for each agent session.
- Streaming prompt turns, partial messages, tool call events.
- Mapping AO IPC request/response envelopes to ACP methods.
- Spawning the agent binary with harness-specific ACP launch args (from AO registry metadata).

### What the UI becomes

| Surface | Role after migration |
|---------|----------------------|
| `ChatPane` | Primary agent UI: composer, message list, streaming tokens, tool cards, permission prompts |
| Agent xterm / `/mux` attach | **Removed** as agent path |
| Shell terminal service | Optional later for user shell only — never required for agent IO |

---

## Sequences

### Spawn

```text
Client → POST /api/v1/sessions (project, harness, role, prompt?)
Daemon → provision worktree + durable session row
Daemon → ensure acp-bridge healthy
Daemon → IPC: session.create { aoSessionId, harness, cwd, env, model?, launch }
Bridge → ACP: initialize / new session with agent
Bridge → IPC: session.ready | session.error
Daemon → activity_state = waiting_input | active
Client ← session DTO + stream subscription ready
```

Acceptance: no tmux session name, no conpty host, no `/mux` dependency for a healthy agent session.

### Send (user message)

```text
Client → POST .../sessions/{id}/messages  { text, attachments? }
Daemon → reject if is_terminated or blocked without permission path
Daemon → IPC: session.prompt { aoSessionId, text, attachments? }
Bridge → ACP: prompt turn
Bridge → stream events (see Stream)
Daemon → activity_state transitions from ACP-derived facts (active → waiting_input / blocked / exited)
```

Acceptance: delivery is acknowledged by bridge/ACP; no `send-keys` / PTY paste.

### Stream

```text
Bridge → IPC notify: stream.delta | stream.tool | stream.message_end | session.activity
Daemon → persist durable activity facts as needed; fan out SSE
Client (ChatPane) → append/update message bubbles; render tool rows
```

Wire options (pick in PR3; both AO-native):

1. **SSE** on `GET /api/v1/sessions/{id}/chat/stream` (preferred first cut; matches existing SSE patterns).
2. Optional later: WebSocket if backpressure or bidirectional client events need it.

Events (illustrative AO envelope, not ACP wire):

```json
{ "type": "chat.delta", "sessionId": "...", "messageId": "...", "text": "..." }
{ "type": "chat.tool", "sessionId": "...", "toolCallId": "...", "name": "...", "status": "running|done|error" }
{ "type": "chat.message_end", "sessionId": "...", "messageId": "..." }
{ "type": "session.activity", "sessionId": "...", "activityState": "active|waiting_input|blocked|exited" }
{ "type": "permission.request", "sessionId": "...", "requestId": "...", "summary": "..." }
```

### Permission

```text
Bridge → IPC: permission.request { aoSessionId, requestId, tool, summary, options }
Daemon → activity_state = blocked; emit SSE permission.request
Client → user approves/denies in ChatPane
Client → POST .../sessions/{id}/permissions/{requestId} { decision }
Daemon → IPC: permission.respond { requestId, decision }
Bridge → ACP permission response
Daemon → clear blocked when turn resumes
```

Rule preserved from architecture: automation must never inject prompts into a `blocked` session.

### Kill

```text
Client → DELETE / POST terminate session
Daemon → IPC: session.cancel | session.close
Bridge → ACP cancel/end; SIGTERM agent if needed
Daemon → mark is_terminated; reaper cleans workspace per existing policy
Daemon → no tmux kill-session / conpty host teardown for agent path
```

---

## Sidecar + AO IPC contract

### Process model

- Binary/entry: Node process package name **`acp-bridge`** (AO-owned).
- Supervised by Go daemon (same lifecycle as other long-lived helpers): start with daemon, graceful stop on shutdown, crash restart with backoff, health ping.
- One bridge process may multiplex many AO sessions (recommended) to avoid N Node runtimes; session affinity is by `aoSessionId`.
- Transport **Go ↔ bridge**: newline-delimited JSON over Unix domain socket (Darwin/Linux) or named pipe / loopback TCP with a random token (Windows). Not HTTP to agents; not the ACP wire.

### Envelope (AO-native)

```json
{
  "v": 1,
  "id": "uuid",
  "kind": "req|res|evt",
  "method": "session.create|session.prompt|session.cancel|session.close|permission.respond|health.ping",
  "sessionId": "ao-session-id-or-empty",
  "payload": {}
}
```

| Method | Direction | Purpose |
|--------|-----------|---------|
| `health.ping` | Go → bridge | Liveness |
| `session.create` | Go → bridge | Start ACP session for harness + cwd |
| `session.prompt` | Go → bridge | User message / turn |
| `session.cancel` | Go → bridge | Cancel in-flight turn |
| `session.close` | Go → bridge | End ACP session + agent process |
| `permission.respond` | Go → bridge | User decision |
| `session.ready` / `session.error` | bridge → Go | Create result |
| `stream.*` / `permission.request` / `session.activity` | bridge → Go | Events |

### Mapping to official ACP

- Bridge uses **only** `@agentclientprotocol/sdk` and official ACP method names internally.
- Go never imports ACP types; it only speaks the AO IPC table above.
- Harness launch metadata (command, args, env) comes from AO’s adapter registry; bridge does not own product policy.

### Security / isolation

- IPC bound to local machine only; no LAN exposure of the bridge socket.
- Bridge inherits least-privilege env; secrets stay in daemon-controlled env injection for the agent child.
- LAN “Connect Mobile” listener (if enabled) continues to serve app API behind auth; it must not expose raw bridge IPC.

---

## SessionManager without tmux / send-keys

### Current responsibilities to keep

- Create session records, resolve project defaults, provision worktree.
- Send user text into an agent (API renamed conceptually to “prompt”, implementation via bridge).
- Terminate / archive flows.
- Activity updates and reaper cooperation.

### Responsibilities to delete or gut for agents

| Remove from agent path | Notes |
|------------------------|-------|
| `Runtime.Start` tmux/conpty for agents | Replace with bridge `session.create` |
| Paste / `send-keys` / PTY write for `Send` | Replace with `session.prompt` |
| `confirmActive` nudge loops based on PTY | Replace with ACP activity + delivery ack |
| Attach stream for agent xterm | Replace with chat SSE |
| Runtime kill via tmux/conpty | Replace with `session.close` + process group |

### Ports sketch

```text
// Conceptual — names illustrative for implementers
type AgentRuntime interface {
    Create(ctx, SessionCreate) (AgentHandle, error)
    Prompt(ctx, sessionID, Prompt) error
    Cancel(ctx, sessionID) error
    Close(ctx, sessionID) error
    // Events delivered via callback or daemon event bus from bridge
}
```

Existing `Runtime` / `Attacher` agent usages shrink; shell-only paths (if any remain) must not be required for agent sessions.

### Durable facts unchanged in spirit

- Still do **not** store derived display status.
- `activity_state` continues: `active`, `idle`, `waiting_input`, `blocked`, `exited`.
- Prefer bridge-reported activity over PTY heuristics; failed bridge probes are not proof of death (same rule as failed runtime probes today).

---

## Streaming API (daemon HTTP)

### New / adjusted routes (illustrative)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/sessions` | Unchanged intent; backend creates ACP session |
| `POST` | `/api/v1/sessions/{id}/messages` | User chat message (replaces paste-send semantics) |
| `GET` | `/api/v1/sessions/{id}/chat/stream` | SSE chat + tool + activity + permission events |
| `GET` | `/api/v1/sessions/{id}/messages` | Optional history snapshot for reconnect |
| `POST` | `/api/v1/sessions/{id}/permissions/{requestId}` | Approve/deny |
| `POST` | `/api/v1/sessions/{id}/terminate` | Existing terminate semantics via bridge |

CLI mirrors via thin HTTP client:

- `ao spawn` → create + optional first message  
- `ao send` → `messages`  
- `ao kill` / terminate → bridge close  

OpenAPI + `frontend/src/api/schema.ts` regenerated per `AGENTS.md` when routes land.

### Compatibility

- During early PRs, temporary dual-read of activity from hooks is acceptable only if it does not reintroduce tmux as the agent IO path.
- Final milestone: agent sessions work with tmux/conpty packages unused.

---

## Chat UI plan (`ChatPane`)

### Placement

- Electron renderer, session main pane: replace agent `TerminalPane` / `XtermTerminal` as default.
- Follow **`DESIGN.md`**: agent-orchestrator look, refined-blue accent, shadcn primitives (`components/ui/*`).
- AO-native component name: **`ChatPane`**. Do not import or clone third-party chat shells.

### UX slices

1. **Composer** — multiline input, send, attach (reuse AO attachment model where it exists), disable when terminated/blocked pending decision UI.
2. **Message list** — user + assistant bubbles; streaming partial assistant text; scroll stickiness.
3. **Tool rows** — compact status for tool calls (name, running/done/error); no raw PTY spam.
4. **Permission card** — inline approve/deny when `activity_state=blocked`.
5. **Reconnect** — on SSE drop, refetch history snapshot + resume stream; do not require terminal attach.
6. **Session chrome** — keep existing sidebar/status derivation; chat does not invent a second status model.

### Out of scope for chat MVP

- Full IDE editor embed.
- Replicating any third-party multi-agent product layout.
- Using xterm for agent transcript fallback.

---

## Adapter registry (map existing AO harnesses)

AO already owns harness IDs in `domain.AgentHarness` and adapters under `backend/internal/adapters/agent/`. Migration **extends** that registry — it does not replace it with an external product’s agent table.

### Existing harness IDs (canonical)

`claude-code`, `codex`, `aider`, `opencode`, `grok`, `droid`, `amp`, `agy`, `crush`, `cursor`, `qwen`, `copilot`, `goose`, `auggie`, `continue`, `devin`, `cline`, `kimi`, `kiro`, `kilocode`, `vibe`, `pi`, `autohand`, `fake`.

### Registry additions (ACP-oriented metadata)

Per harness, AO-owned fields (names illustrative):

| Field | Purpose |
|-------|---------|
| `Harness` | Existing `domain.AgentHarness` |
| `ACPLaunch` | Command + args to start agent in ACP mode (from official agent docs / flags only) |
| `ACPTransport` | How bridge attaches (stdio default per official ACP patterns) |
| `SupportsACP` | Bool; gate spawn until true |
| `EnvPassthrough` | Existing env/auth needs |
| `ModelFlags` | Existing role/model config mapping |

### Rollout policy

1. Mark harnesses with verified official ACP support as `SupportsACP=true` first (start with harnesses we dogfood + `fake` for tests).
2. Harnesses without ACP remain non-spawnable for agent sessions once the tmux path is removed — or temporarily hidden in UI with a clear “ACP required” message. **No silent fallback to tmux.**
3. `HarnessFake` gains an ACP-capable test double (or bridge-level fake agent) for e2e without network/tokens.
4. Never copy third-party adapter JSON; only official ACP + our harness IDs + our launch knowledge.

### Prior art (high level only)

Other multi-agent desktop clients demonstrate that structured ACP beats PTY scraping for chat UX. That observation is prior art only; AO’s registry, IPC, and UI are designed independently.

---

## Remove tmux / mux / xterm agent path

### Delete or quarantine (agent path)

| Component | Action |
|-----------|--------|
| `adapters/runtime/tmux` agent usage | Stop calling from SessionManager agent flows |
| `adapters/runtime/conpty` agent usage | Same |
| `httpd` terminal mux agent attach | Remove agent session attach routes or no-op with error |
| Frontend `XtermTerminal` as agent primary | Remove from session default; delete dead agent paths when unused |
| `ao doctor` tmux requirement | Drop tmux as hard requirement for agent operation on Darwin/Linux |
| Docs (`architecture.md`, `stack.md`) | Update in a docs PR in the DAG to describe ACP as agent IO |

### May remain (non-agent)

- User **shell** terminals (explicit shell feature), if product still wants them — separate from agent sessions, not used for `ao send`.
- Any emergency debug tooling must not be the supported agent path.

### Migration flag (short-lived)

Optional `AO_AGENT_IO=acp|legacy` only during intermediate PRs for internal dogfood. **Final acceptance: flag removed; ACP only.**

---

## Risks

| Risk | Mitigation |
|------|------------|
| Agent lacks stable ACP support | Registry `SupportsACP`; ship fake + dogfood harnesses first; no tmux fallback |
| SDK / protocol churn | Pin `@agentclientprotocol/sdk`; integrate official schema tests in bridge |
| Sidecar crash loses in-flight turns | Daemon marks session degraded; restart bridge; session recreate policy documented |
| Permission UX deadlock | Always surface `blocked` + permission card; timeouts + cancel path |
| Dual-write activity bugs | Single writer: bridge events → durable facts; avoid PTY heuristics |
| Windows IPC differences | Abstract transport early; CI matrix includes Windows bridge health |
| Scope creep / UI clone risk | Clean-room checklist on every PR; DESIGN.md only |
| Large bang-cut breakage | Phased DAG; e2e on `fake` ACP before deleting tmux |

---

## Phased PR DAG

```text
PR1  docs (this) ──► PR2 acp-bridge scaffold + IPC
                         │
                         ▼
                     PR3 daemon AgentRuntime + SessionManager spawn/send/kill via bridge
                         │
                         ├─► PR4 streaming API (SSE) + CLI send/spawn wire-up
                         │
                         └─► PR5 ChatPane UI (can parallelize after PR4 contracts frozen)
                                 │
                                 ▼
                             PR6 adapter registry SupportsACP roll-out + fake ACP e2e
                                 │
                                 ▼
                             PR7 remove tmux/conpty/mux/xterm agent path + doctor/docs
                                 │
                                 ▼
                             PR8 harden (permissions UX, reconnect, Windows IPC, telemetry)
```

### PR1 — Design doc (this PR)

**Delivers:** `docs/plans/acp-migration.md` only.  
**Acceptance:**

- [ ] Binding decisions + IP/clean-room section present.
- [ ] Current vs target arch, sequences, IPC, SessionManager, streaming, Chat UI, registry, removal, risks, DAG documented.
- [ ] No production code.

### PR2 — `acp-bridge` scaffold

**Delivers:** Node package `acp-bridge`, official SDK dependency, health IPC, supervised process from Go (minimal).  
**Acceptance:**

- [ ] Daemon starts/stops bridge; `health.ping` round-trip.
- [ ] No tmux in new code path.
- [ ] Clean-room: only official SDK + AO IPC names.

### PR3 — SessionManager ACP path

**Delivers:** Agent create/prompt/cancel/close via bridge; durable session rows still SQLite.  
**Acceptance:**

- [ ] Spawn session without tmux/conpty.
- [ ] Prompt delivers without send-keys.
- [ ] Kill closes bridge session.
- [ ] Unit/integration tests with fake bridge.

### PR4 — Streaming API + CLI

**Delivers:** SSE chat stream; `ao send` / spawn use messages API.  
**Acceptance:**

- [ ] Client receives deltas + activity events.
- [ ] OpenAPI + schema.ts regenerated.
- [ ] CLI table tests for happy path + daemon errors.

### PR5 — `ChatPane`

**Delivers:** Renderer chat input + streaming replies per DESIGN.md.  
**Acceptance:**

- [ ] Default agent surface is ChatPane, not xterm.
- [ ] Permission approve/deny UI when blocked.
- [ ] `ao preview` demo path works for QA.
- [ ] No third-party UI copy.

### PR6 — Registry + multi-harness

**Delivers:** `SupportsACP` metadata; map existing harnesses; fake ACP e2e.  
**Acceptance:**

- [ ] At least one real dogfood harness + `fake` pass e2e spawn/send/stream/kill.
- [ ] Unsupported harness fails clearly (no tmux fallback).

### PR7 — Remove agent tmux/mux/xterm path

**Delivers:** Delete or hard-disable agent runtime mux path; doctor/docs update.  
**Acceptance:**

- [ ] Agent session tests do not require tmux.
- [ ] Architecture docs describe ACP agent IO.
- [ ] Dead agent xterm attach removed or unreachable.

### PR8 — Harden

**Delivers:** Permission edge cases, SSE reconnect, Windows IPC, crash restart, telemetry (no secrets).  
**Acceptance:**

- [ ] Crash/restart bridge recovers or surfaces actionable error.
- [ ] Blocked sessions never auto-injected.
- [ ] CI green on primary platforms.

---

## Explicit non-goals (this program)

- Reimplementing ACP in pure Go.
- Keeping tmux as a hidden agent fallback.
- Porting AionUi or any third-party app.
- Moving daemon logic into Electron.
- Changing loopback daemon bind/auth rules (`127.0.0.1` unauthenticated primary listener stays).

---

## Success criteria (program level)

1. User can spawn, message, stream, approve permissions, and kill agents **without tmux/conpty**.
2. Primary UI is **ChatPane** streaming chat, AO DESIGN.md look.
3. Agents speak **official ACP** through **acp-bridge** + **`@agentclientprotocol/sdk`**.
4. Harness coverage expands through **AO adapter registry**, independently designed.
5. Clean-room checklist passes on every PR; no third-party app code or assets.

---

## References (allowed)

- Agent Client Protocol: https://agentclientprotocol.com/
- Official TypeScript SDK: `@agentclientprotocol/sdk`
- This repo: `docs/architecture.md`, `DESIGN.md`, `backend/internal/domain/harness.go`, `backend/internal/session_manager/`, `backend/internal/adapters/agent/`
