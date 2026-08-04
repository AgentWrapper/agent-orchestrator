# ACP gap matrix: AllBeingsFuture vs Fenzhi AO design vs current main

**Status:** docs gap analysis (no product code in this deliverable)  
**Date:** 2026-08-04  
**Audience:** backend and frontend implementers migrating Agent Client Protocol (ACP) into current `agent-orchestrator`  
**Sources (read-only):**

| Source | Path / refs | Role |
| --- | --- | --- |
| **ABF** | `/Users/zhongshengjieweilai/Desktop/AllBeingsFuture` — `docs/acp-architecture.md`, `frontend/docs/acp-renderer-streaming.md`, `electron/bridge/adapters/acp.ts`, `electron/bridge/acp-package-resolve.ts`, tests under `electron/tests/acp-*` | TypeScript Electron-main ACP client + renderer normalized stream contract |
| **Fenzhi** | `/Users/zhongshengjieweilai/Desktop/fenzhi` — `backend/internal/ports/chat.go`, `backend/internal/adapters/chatdriver/acp/*`, provider bindings (`claudeacp`, `nativeacp`, `droidacp`, `opencodeacp`), `frontend/src/renderer/components/chat/*`, `frontend/acp-runtime` | Go daemon Chat driver over ACP + durable conversation UI |
| **Current main** | this worktree (aligned with `origin/main` at analysis time) | Terminal/runtime session model only; **no ACP / Chat driver stack** |

## Executive summary

Current `agent-orchestrator` **main has no ACP surface**: no `ports.ChatDriver`, no `chatdriver/*`, no conversation domain projection for machine-protocol turns, no chat workspace UI, no packaged ACP runtime. Migrating ACP is a greenfield port against the **Fenzhi AO design** (daemon-owned Go transport + provider-neutral `ChatEvent`s), informed by **ABF** for stable v1 wire semantics, permission UX, package-resolve pitfalls, and stream-ordering rules.

**Architectural default for AO implementers:** follow **Fenzhi’s placement** (daemon Go adapter, not Electron-main process ownership). Use **ABF** as a clean-room checklist for stable ACP v1 mapping, IPC/stream sequencing discipline, and Electron packaging of JS wrappers. Do **not** paste ABF’s Electron `BridgeManager`/`agent:stream` path into AO’s renderer; AO already owns agent lifecycle in the loopback daemon.

### Design tension to resolve early

| Topic | ABF | Fenzhi | Recommendation for current AO |
| --- | --- | --- | --- |
| Process owner | Electron main | Daemon (Go) | **Daemon** (match AO architecture) |
| SDK | `@agentclientprotocol/sdk` (TS) | `github.com/coder/acp-go-sdk` | **Go SDK in daemon**; keep renderer SDK-free |
| Resume | `session/load` when `loadSession` | `session/resume` required | Prefer Fenzhi **resume**; optionally support **load** if product needs agents that only advertise `loadSession` |
| Stream model | Monotonic `sequence` IPC `AgentStreamEvent` | `ChatEvent` channel → durable projection / HTTP+SSE | Prefer Fenzhi **domain events**; borrow ABF **monotonicity / append-only delta** rules for any live stream |
| Client capabilities | Conservative `fs/terminal: false`; may advertise `plan` | No fs/terminal; elicitation + plan caps + extension meta | Match Fenzhi production honesty; gate experimental features |

---

## Capability matrix

Legend for **Current main**: `Missing` = not present; `Partial` = related substrate exists but not ACP/Chat; `Present` would mean shipped ACP/Chat behavior (none at analysis time).

| Capability | ABF | Fenzhi AO design | Current main | Action for implementers |
| --- | --- | --- | --- | --- |
| **Protocol version** | Stable ACP **v1** only (`protocolVersion: 1` / SDK `PROTOCOL_VERSION`); reject mismatch; forbid experimental v2 product paths | Negotiates via `acpsdk.ProtocolVersionNumber` on `Initialize`; incompatible → `ErrChatDriverIncompatible` | **Missing** | Pin one Go ACP SDK; assert negotiated version; CI ban experimental imports; document supported integer (v1). |
| **Initialize** | `initialize` with clientInfo + conservative `clientCapabilities` (fs/terminal off; plan optional); store `agentCapabilities` / `agentInfo` | `Initialize` with `ClientInfo` name `agent-orchestrator`, `PlanCapabilities`, elicitation caps, Claude-bridge meta (`subagent-transcript`, `terminal_output`); no client fs/terminal | **Missing** | Implement handshake first; advertise only capabilities AO will actually serve; never grant daemon terminal/fs APIs to the agent via ACP client methods. |
| **Session new** | `session/new` with absolute `cwd`, MCP servers, optional `additionalDirectories` | `session/new` after connect; absolute workspace; MCP + additional dirs gated by agent caps; optional `NewSessionMeta` / mode+config options | **Missing** | `ChatDriver.Start` → new session; require abs worktree; persist provider session id for resume. |
| **Session load** | Prefer `session/load` when `loadSession` and `resumeSessionId` set | Not primary path; resume uses **ResumeSession** | **Missing** | Decide product path: implement **resume** as primary (Fenzhi); add **load** only if target agents lack resume. Never silently fall back to new session on failed resume. |
| **Session resume** | Documented as optional later (`sessionCapabilities.resume`) | **Required**: Start/Resume fail if `SessionCapabilities.Resume == nil`; `Resume` reopens stored id without replaying AO transcript | **Missing** | Persist `ProviderConversationID`; resume after daemon restart; surface `ErrChatResumeFailed` to UI with recovery choices. |
| **Prompt / turn** | One active `session/prompt` per adapter; content blocks (text + images always forwarded); system prompt injection once per process | Deferred turn: `SendTurn` prepares id, `StartDeferredTurn` after durable bind; `session/prompt` with message id; concurrent turn rejected | **Missing** | Backend: deferred binding to avoid race with projections; one in-flight turn; map stopReason → turn state. Frontend: composer send + busy/disable until terminal. |
| **Cancel / interrupt** | UI Stop → `session/cancel` + cancel pending permissions + grace then kill | `Interrupt` → `session/cancel`; `ErrChatNoActiveTurn` if none; turn cancel context | **Missing** (terminal stop ≠ ACP cancel) | Wire stop control to ACP cancel; cancel parked permissions/elicitations; do not treat late stop as hard error. |
| **Permissions / approvals** | `session/request_permission` → UI `permission_request`; respond via IPC; autoAccept policy; silent cancel is a known mismatch to fix | Park permission with AO-generated `requestId`; emit `approval.requested` with offered decisions; `ResolveRequest` validates offered option; timeout/cancel outcomes | **Missing** | Backend: park/resolve API (no auto-invented consent). Frontend: approval card from **offered** options only; dual-client race → `ErrChatRequestNotPending`. |
| **Tool calls** | Map `tool_call` / `tool_call_update`; diff replacement content into append-only `resultDelta`; status pending/in_progress/completed/failed | Tool updates → activity started/completed + command/output deltas; nested agent metadata via parent tool id | **Missing** | Normalize tools into durable activities; append-only output deltas; preserve toolCallId stability. |
| **Plans** | Full-replace plan events; map ACP `content`→title; synthesize ids; ACP statuses pending/in_progress/completed (`blocked` only for legacy) | `ChatEventPlanUpdated` / `domain.ConversationPlan` steps | **Missing** | Backend emit plan snapshots; frontend `TurnPlan`-style replace UI; do not invent ACP `blocked` on native path. |
| **Thinking / reasoning** | `agent_thought_chunk` → `thinking_update` mode `delta` | `AgentThoughtChunk` → activity kind reasoning + `reasoning.delta` | **Missing** | Stream reasoning as first-class activity; never replace accumulation with empty settle. |
| **MCP** | Normalize stdio/http/sse into session new/load; capability checks for http/sse | `normalizeMCPServers` with stdio/http/sse; fail if agent lacks transport; optional MCP server status events; reject ACP-tunneled MCP client methods | **Missing** | Pass session MCP configs at start/resume; gate on agent mcpCapabilities; secrets only to local process env/headers. |
| **Package / binary resolve** | `acp-package-resolve`: asar vs asar.unpacked; bundled `claude-agent-acp` / `codex-acp`; host CLIs via PATH | Claude: packaged Node + `@agentclientprotocol/claude-agent-acp` under `frontend/acp-runtime`, `CLAUDE_CODE_EXECUTABLE` → user binary; native providers launch **plugin-resolved** binary only (no download) | **Partial** — agent plugins resolve TUI binaries; no ACP runtime pack | Port packaging story: ship adapter runtime for JS bridges; never substitute user CLIs; resolve spawnable paths outside asar. |
| **Process cleanup** | Ordered destroy: cancel → optional `session/close` → close connection → SIGTERM → SIGKILL; drop maps | `Close`: cancel turn, fail pending permissions/inputs, best-effort `CloseSession`, stdin close + 3s wait + process-group kill; stderr drained to avoid deadlock | **Partial** — session/runtime reaper for TUI processes, not ACP conversations | Implement ACP-specific teardown; process groups (unix); no orphan node/agent on app quit; drain stderr. |
| **Stream sequencing** | Per local session monotonic `sequence`; renderer drops `<= last`; append-only text/tool deltas; plan full replace; serialize emit | Event channel with buffer; slow consumer disconnected rather than blocking reader; durable projector folds deltas by item id | **Missing** for Chat; SSE/CDC exist for other domains | If live stream: guarantee order per conversation; append-only deltas; terminal events finalize turn. Prefer durable projection as source of truth (Fenzhi). |
| **Multi-provider** | Profiles: native ACP + legacy Claude/Codex/Gemini/OpenCode/OpenAI adapters; `adapterType` selection | Shared `chatdriver/acp` + thin bindings: `claudeacp`, `opencodeacp`, `droidacp`, `nativeacp`; registry by harness; production floor caps | **Partial** — multi-harness TUI agents only | Reuse agent plugins for discovery/auth; one ACP transport; provider packages only launch/meta/mode mapping. Keep TUI path intact. |
| **Tests** | Fake ACP agent; init/version/timeout/crash; stream map; permission cancel; cancel cooperative/uncooperative; package resolve; optional live smoke (Grok/Codex) | Extensive `driver_test.go`: deferred prompt, resume, elicitation, nested tools, usage/rate limits, config options, skills, steering; provider package tests | **Missing** for ACP | Port fake-agent tests to Go; production-floor capability tests; resume failure; permission matrix; process cleanup; no network in unit tests. |

---

## Expanded notes by area

### 1. Protocol version and initialize

**ABF** hard-fails when negotiated version ≠ stable v1 and documents capability honesty (do not advertise fs/terminal until implemented).

**Fenzhi** maps auth-ish RPC failures (`-32000`) to `ErrChatAuthRequired` and other init failures to incompatible/unavailable.

**Current main:** no initialize path.

**Implementers:** land Go initialize + capability storage before any UI work; log agentInfo for support.

### 2. Session new / load / resume

| Operation | ABF | Fenzhi | Main |
| --- | --- | --- | --- |
| new | yes | yes | no |
| load | yes (resume path) | no (primary) | no |
| resume | optional/future in docs | **required** | no |
| close | best-effort on destroy | best-effort on `Close` | n/a |

**P0 product rule (from Fenzhi):** failed resume must not silently create a new provider conversation.

### 3. Prompt, cancel, concurrency

Both designs enforce **one active prompt**. Fenzhi’s deferred start is important for AO’s durable turn rows and CDC/SSE consumers—port it when wiring session_manager.

Cancel must:

1. Notify `session/cancel`
2. Resolve pending permissions/elicitations as cancelled
3. Eventually emit a terminal turn state (interrupted/cancelled)
4. Keep process alive when healthy (ABF cooperative cancel) unless destroy/shutdown

### 4. Permissions

ABF documents mismatches M2/M15/M16 (missing IPC broker, requestId, silent cancel). Fenzhi already parks approvals with explicit decision validation.

**AO target:** Fenzhi-style API (`ResolveRequest`) exposed over daemon HTTP, not Electron-only IPC.

### 5. Tool calls, plans, thinking

Shared mapping rules (ABF table is the best wire checklist):

- `agent_message_chunk` → message delta  
- `agent_thought_chunk` → reasoning delta  
- `tool_call` / `tool_call_update` → activities (diff replacement content)  
- `plan` → full plan replace  
- `usage_update` → usage side channel (do not require non-schema prompt usage)

Fenzhi additionally maps nested subagent text, terminal output metadata, config option updates, available commands as skills, steering extension.

### 6. MCP

Both support stdio/http/sse shapes with capability checks. Neither should reintroduce MCP-over-ACP client tunnels without a security model.

### 7. Package resolve and multi-provider

| Provider style | ABF | Fenzhi |
| --- | --- | --- |
| Packaged JS ACP wrapper + host CLI | claude-agent-acp, codex-acp + asar unpack | Claude ACP runtime pack + `CLAUDE_CODE_EXECUTABLE` |
| Native user binary speaking ACP | generic `acp` profile | `nativeacp` / droid / opencode |
| Legacy non-ACP | separate adapters | keep TUI runtime path |

Current main already has agent plugins for binary discovery—**reuse them** for ACP launch; do not invent a second install tree under Application Support (hard rule: state under `~/.ao` only).

### 8. Stream sequencing vs durable conversation

**ABF renderer contract** (`agentStreamTypes`): sequenced envelopes, ignore stale sequence, terminal `done|error|cancelled`.

**Fenzhi frontend** (`components/chat/*`): conversation timeline, turn settings, plan, approvals, context meter, provider signals—driven by AO conversation APIs/events, not raw ACP.

**Current main frontend:** sessions board + terminal; no chat workspace.

For AO: implement **backend projection first**, then UI against domain snapshots/events (Fenzhi), while enforcing ABF’s **append-only / ordered delivery** invariants on the wire into the projector.

### 9. Tests (minimum bar)

Port/adapt:

1. Initialize v1 success + version mismatch  
2. Prompt streams text/thinking/tool/plan  
3. Permission park/resolve/cancel/timeout  
4. Cancel mid-turn; cancel mid-permission  
5. Resume happy path + missing id + agent without resume  
6. MCP unsupported transport fails clearly  
7. Process exit: no hang on stderr flood; kill tree  
8. Production floor: streaming + approvals + interrupt + resume  
9. Provider binding unit tests (launch args/env only)

---

## What current main already has (substrate, not ACP)

Useful existing pieces **not** to reinvent:

- Daemon loopback HTTP, services, SQLite, CDC/SSE patterns  
- Session lifecycle, worktrees, permission mode vocabulary on agent config  
- Agent plugins / harness registry for TUI launch and auth probes  
- Frontend Electron thin client + typed API client generation pipeline  

Still **absent** relative to Fenzhi:

- `ports/chat.go` and all Chat* types  
- `adapters/chatdriver/**`  
- Conversation domain / storage / HTTP controllers for turns  
- Chat UI (`ChatWorkspace`, approvals, plans, reasoning)  
- Packaged `acp-runtime` for JS bridges  

---

## Priority ranking for implementers

### P0 — must land before any “Chat mode” claim

1. **Go ACP transport** in daemon: initialize, session new, prompt, cancel, close, process lifecycle  
2. **`ports.ChatDriver` / `ChatConversation` / `ChatEvent`** boundary (provider DTOs never escape adapters)  
3. **Permissions park/resolve** + production floor (streaming, approvals, interrupt, resume)  
4. **Persist provider conversation id** + **resume without silent new-session**  
5. **Durable turn projection** (or equivalent) so UI/API can read history after reconnect  
6. **Fake-agent unit tests** for the above  

### P1 — product-complete first providers

1. **Claude ACP binding** + packaged Node/runtime resolve (Fenzhi `acp-runtime` model)  
2. **At least one native binary provider** (OpenCode or Droid pattern)  
3. **MCP server injection** at session start/resume  
4. **Plans + thinking + tool activities** end-to-end in UI  
5. **Frontend chat workspace** consuming daemon APIs (not raw ACP)  
6. **Process cleanup on session delete / daemon shutdown**  

### P2 — parity / polish

1. Elicitation / structured user input  
2. Config options, skills, steering, usage/rate-limit banners  
3. Nested subagent transcript hierarchy  
4. Optional `session/load` for agents without resume  
5. ABF-style package-resolve hardening for asar edge cases in desktop builds  
6. Live smoke tests against real CLIs (gated, non-CI-default)  
7. Normalized stream sequence numbers if a pure live-tail UI is added beside durable projection  

---

## Backend vs frontend: what to implement first

### Backend first (blocking)

1. Port Fenzhi-shaped **`ports/chat.go`** contracts into current backend.  
2. Implement **`chatdriver/acp`** (SDK connect, lifecycle, event map).  
3. Wire **session manager / HTTP**: start, resume, send, interrupt, resolve approval, event stream or poll.  
4. SQLite durability for conversations/turns/activities (follow Fenzhi domain vocabulary where it fits AO storage rules; **new migrations only**).  
5. Register **one harness** (Claude ACP recommended) behind feature detection / probe.  
6. Tests with **fake ACP agent** (no network).  

### Frontend second (unblocked by stable API)

1. Generate/open API types once controllers exist (`npm run api`).  
2. **Chat workspace**: timeline, composer, stop, approval cards, plan panel, reasoning blocks.  
3. Capability-gated controls (hide skills/config if not negotiated).  
4. Resume failure UX (offer recover / new conversation—never silent).  
5. Keep **terminal/TUI mode** working unchanged; chat is additive.  

### Explicit non-goals for first migration slice

- Electron-main ACP client (ABF layout) as the production owner  
- Experimental ACP v2 / `state_change`  
- Forcing every TUI harness onto ACP in one PR  
- Remote HTTP/WebSocket ACP transport  
- Auto-allow_always without user policy  

---

## Suggested module map (target shape on current AO)

```text
backend/internal/ports/chat.go                 # ChatDriver contracts (from Fenzhi design)
backend/internal/adapters/chatdriver/acp/      # shared ACP transport
backend/internal/adapters/chatdriver/claudeacp/
backend/internal/adapters/chatdriver/nativeacp/
backend/internal/adapters/chatdriver/registry/
backend/internal/service/…                     # conversation/session chat orchestration
backend/internal/httpd/controllers/…           # REST + stream
frontend/acp-runtime/                          # optional packaged JS bridges + Node
frontend/src/renderer/components/chat/         # workspace UI
docs/plans/acp-abf-fenzhi-gap-matrix.md        # this file
```

ABF’s `StreamNormalizer` / `agent:stream` remains a **reference for event purity**, not a required Electron channel name in AO.

---

## Source file index (for implementers)

### AllBeingsFuture

- `docs/acp-architecture.md` — system architecture, M1–M28 mismatches, test matrix  
- `frontend/docs/acp-renderer-streaming.md` — renderer event union  
- `electron/bridge/adapters/acp.ts` — runtime adapter  
- `electron/bridge/acp-package-resolve.ts` — spawn path / asar  
- `electron/tests/acp-adapter.test.ts`, `acp-package-resolve.test.ts`, `acp-builtin-smoke.test.ts`  
- `frontend/src/types/agentStreamTypes.ts`, `frontend/src/core/chat/agentStreamCore.ts`  

### Fenzhi

- `backend/internal/ports/chat.go` — capabilities, events, driver interfaces  
- `backend/internal/adapters/chatdriver/acp/{driver,client,conversation,process,session_setup}.go`  
- `backend/internal/adapters/chatdriver/{claudeacp,nativeacp,droidacp,opencodeacp}/`  
- `backend/internal/adapters/chatdriver/acp/driver_test.go`  
- `frontend/src/renderer/components/chat/*`  
- `frontend/acp-runtime/`, `frontend/scripts/build-acp-runtime.mjs`  

### Current main

- No ACP-equivalent packages at analysis time; start from Fenzhi ports + AO `docs/architecture.md` daemon boundaries.

---

## Document control

| Item | Value |
| --- | --- |
| Deliverable type | Docs only |
| Protocol target | ACP stable v1 |
| Preferred implementation lineage for AO | Fenzhi daemon Chat driver |
| Preferred wire/UX checklist | ABF architecture + streaming contract |
| Current main ACP status | Absent |
