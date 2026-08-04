# Plan: Migrate ABF ACP **streaming output** into Agent Orchestrator

> **Superseded as the active product goal (2026-08-04).**  
> Human hard pivot: **fully remove tmux** and run agents as ACP/HTTP child processes.  
> Active cutover plan: [`abf-no-tmux-acp-cutover.md`](./abf-no-tmux-acp-cutover.md).  
> This document remains useful as **Phase 1 subsystem detail** (AgentStreamEvent, normalizer, reducer).

**Status:** planning (docs only) — streaming subsystem; overall goal moved to no-tmux cutover  
**Primary goal (historical):** Bring AllBeingsFuture’s **normalized ACP stream pipeline** (events + sequence + consumer reduce) into this repo — **not** a full Chat product, provider matrix, or packaging port.  
**Source of truth (streaming):** Desktop `AllBeingsFuture`  
**Design fit (boundaries only):** Desktop `fenzhi` — Chat/protocol events stay in the daemon; renderer never imports ACP SDKs.  
**Target base:** current AO `main` (no Chat API / no stream surface today).

---

## 0. Scope correction (authoritative)

| In scope | Out of scope |
| --- | --- |
| Normalized stream **event types** and envelope (`sequence`, `sessionId`, source) | Full fenzhi chat product (compaction, steer, skills, config options, models, MCP reload, packaging) |
| **Backend normalizer**: provider/adapter events → sequenced stream events | Porting ABF Electron-main ACP TypeScript as the product transport |
| **Emission path** to the renderer over AO daemon HTTP (SSE or dedicated stream) | Full provider matrix (Claude/Codex/Droid/OpenCode bindings, `acp-runtime` packaging) |
| **Frontend reducer** + minimal timeline that renders the stream | Wholesale ABF conversation UI, missions, stickers, virtualization product chrome |
| Unit tests for normalizer + reducer parity with ABF | Replacing TUI sessions; remote ACP transports; experimental ACP v2 |

**One-sentence product slice:**  
*An AO session can push ACP-shaped activity as sequenced `AgentStreamEvent`s from the daemon; the desktop renderer reduces them into a live timeline (text, thinking, tools, plan, permission, terminal states) without speaking ACP itself.*

---

## 1. ABF streaming pipeline (what we are migrating)

```text
Provider adapter (ACP or legacy)
        │  BridgeEvent  (adapter-internal, not wire to UI)
        ▼
AgentStreamNormalizer  (sequence++, map kinds, tool output diff)
        │  AgentStreamEvent  (provider-neutral, sequenced)
        ▼
IPC agent:stream  ──▶  parseAgentStreamEvent
        │
        ▼
AgentStreamBatcher  (rAF coalesce text/thinking/tool progress)
        │
        ▼
reduceAgentStreamEvent  (pure)  ──▶  messages + AgentSessionStreamState
        │
        ▼
Conversation / activity UI
```

### Canonical source files (ABF)

| Layer | Path |
| --- | --- |
| Architecture | `docs/acp-architecture.md` (StreamNormalizer, envelope, mapping) |
| Renderer contract | `frontend/docs/acp-renderer-streaming.md` |
| Wire types | `frontend/src/types/agentStreamTypes.ts` |
| Normalizer | `electron/services/agent-stream-normalizer.ts` (+ `electron/tests/agent-stream-normalizer.test.ts`) |
| Main-side types twin | `electron/services/agent-stream-types.ts` (keep in sync with frontend types) |
| Pure reducer | `frontend/src/core/chat/agentStreamCore.ts` (+ tests) |
| Coalesce/batch | `frontend/src/core/chat/agentStreamBatch.ts` (+ tests) |
| Parse/IPC respond | `frontend/src/hooks/agentStreamIpc.ts` |
| Producer only | `electron/bridge/adapters/acp.ts` → emits `BridgeEvent`; normalizer is the seam |

### Load-bearing ABF rules (must preserve semantics)

1. **`sequence`**: per local `sessionId`, start at `0`, strictly increasing for every emitted stream event; consumer ignores `sequence <= lastSequence` (replay-safe).  
2. **Append-only deltas**: `text_delta.delta`, `tool_update.resultDelta` / `output.text` never carry cumulative text.  
3. **Plan = full replace** snapshot each event.  
4. **Thinking**: ACP chunks as `mode: 'delta'`; legacy may `replace` (reducer supports both).  
5. **Tool updates**: ACP replacement content is **diffed** against previous full text before emitting `resultDelta`.  
6. **Terminal events**: `done` | `error` | `cancelled` finalize partial bubbles, clear permission UI, end the turn stream.  
7. **Permission**: surface only request (not outcome) as `permission_request`; respond out-of-band with `{ sessionId, requestId, optionId }`.  
8. **Silence fail-open** (ABF product): after ~12s without stream events while “active”, legacy paths may resume — in AO this becomes “prefer stream while active, then fall back to snapshot/CDC” if both exist.  
9. **No ACP SDK in renderer.**

---

## 2. Event type map: ABF → AO wire

### 2.1 Recommended AO product wire (streaming MVP)

**Keep the ABF `AgentStreamEvent` discriminated union as the cross-process contract**, with one transport change:

| ABF transport | AO transport (target) |
| --- | --- |
| Electron IPC `agent:stream` push | Daemon **SSE** (preferred) or WebSocket on loopback HTTP |
| `agent:permission:respond` invoke | `POST` on a session-scoped approval route (minimal) |
| Envelope fields on every event | Same: `sessionId`, `sequence`, optional `timestamp`, optional `source` |

**Do not** invent a second parallel event vocabulary in the renderer. Backend may use an internal adapter event type (ABF `BridgeEvent` or fenzhi `ports.ChatEvent`), but the **daemon→UI stream frame** should be ABF-compatible `AgentStreamEvent` JSON so the reducer ports almost verbatim.

Optional later: a thin alias layer if AO OpenAPI wants `camelCase` DTO names — keep field-level parity with ABF types.

### 2.2 `AgentStreamEvent` union (AO wire — copy semantics)

| `type` | Payload | Semantics |
| --- | --- | --- |
| `text_delta` | `itemId`, `delta` | Append-only assistant text |
| `thinking_update` | `itemId`, `text`, `mode?: 'delta' \| 'replace'` | Reasoning stream |
| `tool_call` | `toolCallId`, `title`, `name?`, `input?` | Tool creation |
| `tool_update` | `toolCallId`, `status`, optional fields, `resultDelta?`, `output?`, `error?` | Progress/result; deltas append-only |
| `plan` | `title?`, `entries[]` | Full plan replace |
| `status` | `status: starting \| running \| waiting \| idle`, `message?` | App lifecycle (not ACP v2) |
| `permission_request` | `request: { requestId, toolCallId?, title, description?, options[] }` | Blocks until resolve/cancel |
| `done` | `stopReason?` | Terminal success |
| `error` | `message` | Terminal failure |
| `cancelled` | `reason?` | Terminal cancel |

Envelope on every event:

```ts
{ sessionId: string; sequence: number; timestamp?: string;
  source?: { kind: 'native-acp-v1' | 'legacy-adapter'; provider?: string } }
```

### 2.3 Internal producer map (BridgeEvent / ACP → stream)

From ABF normalizer (`AgentStreamNormalizer.normalize`):

| Input (`BridgeEvent.event`) | Output stream `type` | Notes |
| --- | --- | --- |
| `delta` + text | `text_delta` | empty text → drop |
| `thinking` | `thinking_update` `mode: 'delta'` | |
| `tool` `!isUpdate` | `tool_call` | |
| `tool` `isUpdate` | `tool_update` | diff output → `resultDelta` |
| `plan` | `plan` | empty remove → `entries: []` |
| `permission` without outcome | `permission_request` | outcomes dropped |
| `status` phase | `status` | ignore non-UI phases (e.g. `ready`) |
| `done` / cancel stopReason | `done` or `cancelled` | clear tool output cache |
| `error` | `error` | clear tool output cache |
| `agent_task` | *(drop)* | out of stream MVP |

### 2.4 Optional mapping through fenzhi `ports.ChatEvent` (if Chat stack lands later)

Use only as an **adapter-internal** intermediate. Streaming MVP does **not** require durable conversation tables.

| ABF stream | fenzhi `ChatEventKind` (internal) |
| --- | --- |
| `text_delta` | `message.delta` |
| `thinking_update` | `reasoning.delta` |
| `tool_call` / `tool_update` | `activity.started` / `activity.completed` (+ `command.output.delta`) |
| `plan` | `turn.plan` |
| `permission_request` | `approval.requested` |
| `status` | `controller.state` / turn lifecycle |
| `done` / `cancelled` / `error` | `turn.completed` + `TurnState*` / `error` |

If both exist: **normalizer emits AgentStreamEvent for live UI**; durable projector may separately consume ChatEvents. Do not force the renderer to reduce ChatEvent kinds.

### 2.5 ACP v1 notification → BridgeEvent (producer side, reference)

From ABF docs (implement in Go or TS adapter behind the normalizer):

| ACP v1 | Bridge / stream |
| --- | --- |
| `agent_message_chunk` text | `delta` → `text_delta` |
| `agent_thought_chunk` text | `thinking` → `thinking_update` delta |
| `tool_call` | `tool` create → `tool_call` |
| `tool_call_update` | `tool` update → `tool_update` (diff content) |
| `plan` | `plan` → `plan` |
| `session/request_permission` | `permission` → `permission_request` |
| prompt `stopReason` | `done` / `cancelled` |
| transport failure | `error` |

---

## 3. Backend: normalizer + emission path

### 3.1 Placement in AO

```text
[optional] ACP process adapter (later PR / sibling)
        │  internal events (Bridge-like or ChatEvent)
        ▼
backend normalizer (NEW)  — sequence allocator per sessionId
        │  AgentStreamEvent JSON
        ▼
session stream hub (NEW)  — fan-out, optional ring buffer for reconnect
        │
        ▼
httpd SSE  GET /api/v1/sessions/{sessionId}/agent-stream
        │  (loopback 127.0.0.1, unauthenticated — existing AO rule)
        ▼
renderer EventSource → parse → batch → reduce → timeline
```

**Boundary rules (fenzhi-aligned):**

- Normalizer + sequence + permission correlation live in the **daemon**, not Electron main, not renderer.  
- Renderer does not import `acp-go-sdk` or Node ACP SDK.  
- CLI stays a thin HTTP client if any stream debug command is added later.

### 3.2 Why not only existing `/api/v1/events` CDC?

Main already has CDC SSE (`GET /api/v1/events`) for **durable row changes** (`session_updated`, PR facts, …). High-frequency token deltas do **not** belong as one SQLite change_log row per token:

| Approach | Fit for streaming MVP |
| --- | --- |
| **Dedicated agent-stream SSE** (recommended) | Matches ABF push semantics; sequence owned by stream hub; no DB write per delta |
| CDC after durable projection | Good for **final** message/activity rows once Chat storage exists; too slow/heavy for live typing |
| Terminal websocket mux | Wrong abstraction (bytes/PTY), not typed agent events |

**MVP recommendation:** new session-scoped SSE for live `AgentStreamEvent`. Optionally later, CDC invalidates a conversation snapshot after terminal turn.

### 3.3 Backend components to add (minimal)

| Component | Responsibility |
| --- | --- |
| `AgentStreamEvent` DTO (Go) | Mirror ABF JSON field names |
| `StreamNormalizer` | Port ABF normalizer logic (sequence, tool diff, kind map) |
| `StreamHub` | Per-session subscribers, last-N ring buffer, configure source kind |
| `EventsController` route or new controller | `GET .../agent-stream?afterSequence=` |
| Permission resolve handler | Minimal POST; completes parked permission in producer |
| Fake producer (tests / demo) | Inject synthetic Bridge-like events without real ACP |

### 3.4 Sequence + reconnect

- Server allocates sequence; clients send `afterSequence` (or SSE `Last-Event-ID` if framed that way).  
- Replay from ring buffer only (`sequence > after`); never re-send cumulative text.  
- On hub clear/session destroy: clients reset `lastSequence` or receive a stream-reset control event (pick one policy in implementation; prefer explicit `status: idle` + client reset on session change).

### 3.5 What **not** to build in streaming PRs

- Full `chatdriver` provider matrix, `acp-runtime` packaging, conversation SQLite schema, steer/compaction/skills APIs.  
Those may land in **other** migrations; streaming must demo with a **fake producer** or a single thin ACP fake process.

---

## 4. Frontend: reducer + timeline

### 4.1 Port as pure modules (high fidelity)

| ABF module | AO target (suggested) | Notes |
| --- | --- | --- |
| `agentStreamTypes.ts` | `frontend/src/renderer/lib/agent-stream/types.ts` (or `shared/`) | Source of truth types |
| `agentStreamCore.ts` | `.../agent-stream/reduce.ts` | Pure reduce; **port tests** |
| `agentStreamBatch.ts` | `.../agent-stream/batch.ts` | Coalesce text/thinking/tool progress |
| `agentStreamIpc.ts` parse | `.../agent-stream/parse.ts` | Drop Electron invoke; keep parse |
| Permission respond | thin API client POST | No `window.electronAPI` |
| Stream subscribe | `EventSource` helper (pattern from `event-transport.ts` / workspace events) | |

### 4.2 Reducer contract (must keep)

From ABF `reduceAgentStreamEvent` behavior (tests are the spec):

- Ignore `sequence <= lastSequence`.  
- Stamp `lastEventAt`; silence timeout fail-open helpers.  
- Append text into partial assistant bubble by `itemId`; open **new** bubble after tools / after terminal even if itemId reuses.  
- Thinking delta vs replace.  
- Tool call + update correlation (`toolCallId`); progressive stdout merge.  
- Plan replace; clear plan on terminal/idle.  
- Permission set/clear on terminal.  
- Phase machine: `idle → running → waiting_permission → cancelling → done|error|cancelled`.

### 4.3 Minimal timeline UI (demo-only chrome)

Only enough surface to **prove the stream**:

- Scrollable list of reduced messages (assistant text, thinking collapsed, tool cards).  
- Plan panel when `stream.plan` set.  
- Permission buttons when `stream.permission` set.  
- Status/phase indicator + Stop (calls interrupt/cancel stub).  

Use existing AO shadcn / DESIGN.md primitives. **Do not** port ABF ConversationView layout, stickers, or virtualization product work unless a stream demo is blocked without them.

### 4.4 Integration point

- Session inspector or a dedicated “Agent stream” panel when a session is selected.  
- Hook: `useAgentStream(sessionId)` → EventSource + batcher + reduce into local React state (or a small store).  
- No dependency on Chat-mode session flag for MVP if fake producer is session-scoped for any session id used in tests.

---

## 5. Phased PRs (streaming only)

Keep PRs small; conventional commits; one concern each.

### PR-S0 — Docs (this plan)

- Rewrite plan around streaming-only goal.  
- **Exit:** team aligned on wire = ABF `AgentStreamEvent` over daemon SSE.

### PR-S1 — Shared stream types + pure reducer/batcher (frontend-first OK)

- Port `AgentStreamEvent` types, `parseAgentStreamEvent`, `reduceAgentStreamEvent`, batch/coalesce.  
- Port ABF unit tests (vitest) with AO paths.  
- **No** UI chrome beyond optional story/fixture if needed for tests.  
- **Success:** tests green for sequence ignore, text append, tools, plan, permission clear, terminal flush.

### PR-S2 — Backend normalizer + hub + SSE

- Go DTO + normalizer ported from ABF rules (table-driven tests).  
- In-memory hub + `GET /api/v1/sessions/{sessionId}/agent-stream`.  
- Fake producer endpoint or test-only inject for e2e (e.g. internal test helper, or `POST .../agent-stream/fixtures` behind build tag / debug).  
- **Success:** curl/EventSource receives strictly increasing sequences; tool diff correct; permission event shape valid.

### PR-S3 — Frontend wire-up + minimal timeline

- EventSource client + batcher + reduce into UI.  
- Permission POST + cancel/stop stub.  
- Session panel demo.  
- **Success:** running fake producer updates timeline live; replay afterSequence works; no ACP SDK in renderer.

### PR-S4 — Thin real producer (optional, still not full product)

- Single path that feeds the normalizer from a real or fake ACP stdio process **or** from fenzhi-style ChatEvent bridge if Chat lands.  
- Still **not** multi-provider packaging.  
- **Success:** one end-to-end native-acp-v1 source kind in `source` field.

### Dependency graph

```text
PR-S0 docs
  ├─▶ PR-S1 frontend pure stream modules + tests
  └─▶ PR-S2 backend normalizer + SSE
        └─▶ PR-S3 UI wire-up (needs S1 + S2)
              └─▶ PR-S4 optional real producer
```

S1 and S2 can parallelize after S0.

---

## 6. File-level port list (streaming)

### From ABF (primary for stream logic)

| Source | Action |
| --- | --- |
| `frontend/src/types/agentStreamTypes.ts` | Port types |
| `frontend/src/core/chat/agentStreamCore.ts` + tests | Port pure reduce |
| `frontend/src/core/chat/agentStreamBatch.ts` + tests | Port batch/coalesce |
| `frontend/src/hooks/agentStreamIpc.ts` | Port **parse** only; rehome permission to HTTP |
| `electron/services/agent-stream-normalizer.ts` + tests | Reimplement in **Go** (or shared test vectors) |
| `electron/services/agent-stream-types.ts` | Ensure parity with frontend types |
| `frontend/docs/acp-renderer-streaming.md` | Condense into this plan / short AO stream doc later |
| `docs/acp-architecture.md` §§4–5 | Mapping + permission rules |
| `electron/bridge/types.ts` | Internal producer event shape reference |
| `electron/bridge/adapters/acp.ts` | Producer mapping reference only |

### From fenzhi (boundary / emission reference only)

| Source | Use |
| --- | --- |
| `backend/internal/ports/chat.go` event kinds | Optional internal intermediate; not required for MVP wire |
| `service/chat` controller event loop | Pattern for serializing per-session emit |
| Chat UI components | **Not** required; steal patterns only if timeline needs a card |
| Full chatdriver / migrations / OpenAPI conversation surface | **Non-goal** for this plan |

### Main AO reuse

| Existing | Use |
| --- | --- |
| `frontend/src/renderer/lib/event-transport.ts` | EventSource reconnect patterns |
| `backend/internal/httpd/events.go` | SSE write helpers / style |
| Loopback daemon + typed API client generation | If stream route is OpenAPI-registered |

---

## 7. Risks

1. **Confusing stream SSE with CDC** — token spam must not hit `change_log`.  
2. **Sequence policy on reconnect** — wrong reset causes blank or duplicated text.  
3. **Tool output diff bugs** — replacement vs delta mismatches explode UI.  
4. **Permission correlation** — requestId must match parked RPC; invalid optionId must not consume request.  
5. **Scope creep** — full Chat stack / multi-provider packaging derails the stream demo.  
6. **Dual state** — if snapshot polling is added later, enforce ABF “prefer stream while active” rules.  
7. **Batching latency** — preserve ABF immediate flush for terminal/permission/plan; only batch high-frequency deltas.

---

## 8. Non-goals (explicit)

- Full Chat session mode, conversation SQLite schema, OpenAPI conversation CRUD.  
- Multi-provider Chat drivers (`claudeacp`, `codexappserver`, …) and desktop `acp-runtime` packaging.  
- Porting ABF Electron ACP adapter as AO’s runtime.  
- ACP SDK or provider parsing in the renderer.  
- Experimental ACP v2 / remote HTTP ACP.  
- ABF proprietary conversation chrome (missions, stickers, full virtualization product).  
- Replacing TUI terminal sessions.  
- Steer, compaction, skills, model pickers, MCP reload UIs — unless a stream event cannot be demoed without a stub control.

---

## 9. Success criteria (streaming MVP)

- [ ] Documented map ABF stream types ↔ AO SSE JSON is implemented 1:1 for the union above.  
- [ ] Backend allocates monotonic `sequence` per session; clients drop duplicates/replays.  
- [ ] Normalizer tool output is append-only `resultDelta` (diffed).  
- [ ] Frontend pure reducer + batcher tests ported and green.  
- [ ] Minimal timeline shows text, thinking, tools, plan, permission, and terminal states from a fake producer.  
- [ ] Permission resolve round-trip works over HTTP.  
- [ ] Renderer has zero ACP SDK dependency.  
- [ ] Loopback-only daemon path; no new authenticated network listener.

---

## 10. Recommended worker spawn order

1. **Docs** — this plan (S0).  
2. **Frontend stream core** — types + reduce + batch + tests (S1).  
3. **Backend stream** — normalizer + hub + SSE + tests (S2).  
4. **Frontend integration** — EventSource + minimal timeline + permission POST (S3).  
5. **Optional producer** — thin ACP or fixture feeder (S4).

Avoid parallel edits to the same files: S1 owns `frontend/.../agent-stream/*`; S2 owns `backend/.../agentstream/*` (or similar); S3 only wires them.

---

## 11. Explicit next actions for implementers

1. Freeze wire JSON: commit ABF-compatible `AgentStreamEvent` TypeScript + matching Go struct tags.  
2. Land **PR-S1** with ABF reducer/batcher tests as the behavioral spec.  
3. Land **PR-S2** with table tests for normalizer (text, thinking, tool diff, plan, permission drop-on-outcome, terminal).  
4. Add SSE route + ring buffer; document `afterSequence` query.  
5. Wire **PR-S3** demo panel; use fake producer only until S4.  
6. Do **not** start packaging/provider matrix under this plan’s PRs.

---

## 12. Open decisions (streaming-specific)

| Decision | Options | Recommendation |
| --- | --- | --- |
| Live transport | Session SSE vs WS vs reuse CDC | **Session SSE** |
| SSE event name | `agent_stream` vs unnamed `message` | Named `agent_stream` + JSON body |
| Fake producer | Debug HTTP inject vs test-only | Debug inject behind non-prod or explicit flag for demo |
| Where types live | `renderer/lib` vs `shared` | `shared` if main process ever needs parse; else renderer + Go DTO |
| Permission route | New minimal path vs wait for Chat approvals API | Minimal `POST .../agent-stream/permissions/{requestId}/resolve` for MVP |

---

## 13. Relationship to earlier “full Chat stack” thinking

An earlier draft of this file planned a wholesale fenzhi Chat/ACP product port. That is **superseded** for the active migration goal:

- **Streaming output path** (this document) ships first and stands alone.  
- Full Chat durability/drivers/OpenAPI may still use fenzhi later; they must **consume or bridge into** this stream contract rather than invent a second live UI event language.

---

*Implementation must follow `AGENTS.md` hard rules. Plan-only session: no stream stack code in the docs PR beyond this file.*
