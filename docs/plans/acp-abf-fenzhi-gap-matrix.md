# ACP streaming output gap matrix (ABF vs Fenzhi vs current main)

**Status:** docs gap analysis — **streaming output only** (not full product ACP: no package resolve, multi-provider product, MCP product, session lifecycle beyond stream effects)  
**Date:** 2026-08-04 (scope correction)  
**Audience:** backend + frontend implementers who must land **live agent stream output** in current `agent-orchestrator`  
**File:** `docs/plans/acp-abf-fenzhi-gap-matrix.md`

## Scope

| In scope | Out of scope (do not block stream work) |
| --- | --- |
| Normalized stream event types | Full ACP product (auth, resume policy, packaging, multi-provider matrix) |
| Envelope + sequence / ordering | Worktree, spawn, binary discovery |
| StreamNormalizer (BridgeEvent → stream event) | Durable storage schema design (except how revision/sequence feeds live UI) |
| text / thinking / tool / plan / permission / terminal events | Non-stream features (skills, compaction, models catalog) |
| Batching, coalescing, replay safety | Experimental ACP v2 |
| ABF Electron IPC vs AO HTTP/SSE transport | Terminal TUI byte streams |

## Sources (read-only)

| Source | Streaming-relevant artifacts |
| --- | --- |
| **ABF** | `frontend/src/types/agentStreamTypes.ts`, `core/chat/agentStreamCore.ts`, `core/chat/agentStreamBatch.ts`, `hooks/agentStreamIpc.ts`, `docs/acp-architecture.md` §4, `frontend/docs/acp-renderer-streaming.md`, adapter emits internal `BridgeEvent` in `electron/bridge/adapters/acp.ts` |
| **Fenzhi** | `backend/internal/ports/chat.go` (`ChatEvent` / kinds), ACP `SessionUpdate` → `ChatEvent` in `chatdriver/acp/client.go`, projector folds into conversation snapshot, frontend `useConversation` (ordered snapshot + poll; CDC SSE invalidates workspaces) |
| **Current main** | Generic CDC SSE (`/api/v1/events`), notification stream, terminal mux WS — **no** agent stream event union, **no** StreamNormalizer, **no** chat conversation stream |

---

## 1. Architecture sketch

```text
ABF path
  ACP session/update  →  AcpAdapter BridgeEvent  →  [StreamNormalizer*]  →  AgentStreamEvent{sequence}
       → Electron IPC `agent:stream`  →  parseAgentStreamEvent  →  batcher  →  reduceAgentStreamEvent
  * StreamNormalizer is the documented integration seam; may still be incomplete vs runtime BridgeEvent

Fenzhi path
  ACP session/update  →  chatdriver maps to ports.ChatEvent  →  session_manager projects durable snapshot
       → REST ConversationSnapshot (ordered by sequence/revision)
       → UI polls snapshot (active 1s / idle 5s); optional future mux; board CDC SSE is separate

Current main path
  (missing agent stream)  — only session/workspace CDC SSE + terminal bytes
```

**Migration default for AO:** keep **daemon-owned** mapping (Fenzhi: ACP → `ChatEvent` → projection). Borrow **ABF’s** pure event union, monotonic sequence, append-only deltas, batch/coalesce, and reducer tests for any **live** path. Do **not** require Electron `agent:stream` IPC as the production transport.

---

## 2. Capability matrix (streaming only)

| Capability | ABF | Fenzhi AO design | Current main | Action for implementers |
| --- | --- | --- | --- | --- |
| **AgentStreamEvent / normalized event types** | Typed union: `text_delta`, `thinking_update`, `tool_call`, `tool_update`, `plan`, `status`, `permission_request`, `done`, `error`, `cancelled` | Provider-neutral `ChatEventKind`: `message.delta`, `reasoning.delta`, `activity.*`, `command.output.delta`, `turn.plan`, `approval.*`, `turn.started/completed`, `error`, `controller.state`, plus richer kinds | **Missing** | Define one AO wire shape (prefer Fenzhi kinds on REST/SSE **or** ABF union if a dedicated live stream is added). Keep renderer free of ACP SDK types. |
| **Envelope** | `{ sessionId, sequence, timestamp?, source? }` on every event; `source.kind` = `native-acp-v1` \| `legacy-adapter` | Snapshot-centric: items carry provider turn/item ids + revisions; no IPC envelope | Session CDC envelopes only (not agent stream) | Live stream: require session/conversation id + monotonic seq. Snapshot path: ordered items + revision (Fenzhi). |
| **Sequence** | Monotonic per **local** session, start 0, +1 per event; consumer ignores `sequence <= lastSequence` | Daemon snapshot “already ordered by sequence”; projector bumps revision per item on delta | No agent stream sequence | **P0:** allocate sequence (or durable revision) in daemon; document whether live clients drop stale seq; never reset mid-session without resetting consumer state. |
| **StreamNormalizer** | Documented seam: internal `BridgeEvent` (`event: delta\|thinking\|tool\|…`) → `AgentStreamEvent` (`type: text_delta\|…`); field renames M6–M20 | Adapter **is** the normalizer: ACP → `ChatEvent` inside Go driver; no separate BridgeEvent SPI | **Missing** | Backend: map ACP `session/update` once at driver boundary. If dual paths exist, one normalizer module with unit tests per event kind. |
| **text_delta** | Append-only `delta` + required `itemId`; never cumulative text in `delta` | `message.delta` with `Delta` + `ProviderItemID`; projector appends | **Missing** | Emit append-only chunks; stable item id (synthesize if ACP omits messageId). |
| **thinking / reasoning** | `thinking_update` + `mode: 'delta'\|'replace'`; ACP uses delta | `activity.started` (reasoning) + `reasoning.delta` | **Missing** | Stream reasoning as first-class activity; delta append; do not replace accumulation with empty settle. |
| **tool events** | Split `tool_call` vs `tool_update`; status pending/in_progress/completed/failed; `resultDelta` / `output.text` append-only; title required | `activity.started/completed` + `command.output.delta` / activity text; nested parent tool meta | **Missing** | Create then update; diff ACP replacement content before emitting deltas; stable `toolCallId`. |
| **plan events** | Full **replace** snapshot: `{ title?, entries: {id,title,status}[] }`; synthesize ids; no native `blocked` from ACP v1 | `turn.plan` → `ConversationPlan` steps (pending/in_progress/completed) | **Missing** | Replace entire plan per event; map ACP `content`→title; synthesize stable entry ids. |
| **permission stream events** | `permission_request` with options (`optionId`, `label`, `kind`); blocks UI until respond/cancel | `approval.requested` / `approval.resolved` with `RequestID` + offered decisions | **Missing** | Emit request on stream/snapshot; clear on resolve/cancel/terminal; requestId correlatable to Resolve API. |
| **Terminal events** | `done` / `error` / `cancelled` finalize turn; flush partials; clear permission UI | `turn.completed` + turn state; `error`; controller ready/stopped | **Missing** | One clear terminal per turn; map `stopReason==cancelled` distinctly from success; cancel pending permissions in stream state. |
| **status / controller** | App `status`: starting/running/waiting/idle (not ACP v2 state_change) | `controller.state`: connecting/ready/busy/recovering/stopped | Partial (session activity_state elsewhere) | Map lifecycle for stop button / waiting-on-permission UX without draft ACP v2. |
| **Batching / coalescing** | `agentStreamBatch`: rAF + maxWait 48ms; batchable: text_delta, thinking delta (not replace), tool_update pending/in_progress; coalesce consecutive same-item deltas keeping **last** sequence | Projection absorbs high-frequency deltas; slow `Events()` consumer disconnected rather than blocking; UI polls snapshot | No agent stream batch | **Frontend:** port batcher if applying live events to React store. **Backend:** serialize emit per conversation; drop-behind policy for live subscribers. |
| **Replay / reconnect** | Duplicate/old sequence ignored; optional ring buffer for resync; sequence lifetime of local session | REST snapshot is recovery; EventSource Last-Event-ID for CDC only | CDC Last-Event-ID exists for **workspace** events, not agent tokens | Prefer snapshot catch-up after reconnect; if live SSE for tokens is added, include seq + ignore stale; do not double-append text after REST resync. |
| **IPC vs AO SSE transport** | Electron `webContents.send('agent:stream')` + invoke `agent:permission:respond`; renderer never speaks ACP | No agent:stream IPC; conversation REST + poll; generic `/api/v1/events` CDC for board; approvals via REST resolve | Same CDC/SSE + REST as Fenzhi substrate; **no** conversation stream API | **Do not** invent Electron IPC for stream in AO. Use daemon HTTP: either (A) snapshot poll/mux like Fenzhi or (B) dedicated conversation SSE with ABF-style sequenced events. Permission respond stays REST. |
| **Legacy coexistence** | While normalized stream active, ignore `chat:update`/`chat:patch` for that session | Chat vs TUI modes separated; terminal bytes never Chat events | Terminal only | Keep terminal path separate from Chat stream; never parse TUI logs into stream events. |
| **Tests to port** | See §5 | Driver maps SessionUpdate → ChatEvent; conversation e2e; frontend snapshot mapping | No stream tests | Port ABF reducer/batch/parser tests + Fenzhi map tests; golden fixtures per event type. |

---

## 3. Event type crosswalk (implementers)

| Concern | ABF `AgentStreamEvent.type` | Fenzhi `ChatEventKind` | ACP v1 source (native) |
| --- | --- | --- | --- |
| Assistant text | `text_delta` | `message.delta` (+ `message.completed`) | `session/update` `agent_message_chunk` |
| Thinking | `thinking_update` | `reasoning.delta` (+ activity started) | `agent_thought_chunk` |
| Tool open | `tool_call` | `activity.started` | `tool_call` |
| Tool progress/result | `tool_update` | `activity.completed` / `command.output.delta` / `activity.text` | `tool_call_update` |
| Plan | `plan` | `turn.plan` | `plan` |
| Permission | `permission_request` | `approval.requested` / `approval.resolved` | `session/request_permission` |
| Lifecycle | `status` | `controller.state` / turn started | derived (not v2 state_change) |
| Terminal OK | `done` | `turn.completed` (completed) | `session/prompt` stopReason ≠ cancelled |
| Terminal cancel | `cancelled` | `turn.completed` (interrupted) | stopReason `cancelled` |
| Terminal fail | `error` | `error` + failed turn | transport/prompt failure |

**Field pitfalls (from ABF M-list, still load-bearing):**

| Pitfall | Wrong | Right for stream |
| --- | --- | --- |
| Text field | cumulative `text` as delta | append-only `delta` |
| Thinking mode | omit mode | ACP → `delta`; legacy may `replace` |
| itemId | optional | required / synthesized |
| Tools | single `tool` + `isUpdate` | split create vs update |
| Tool title | name only | always non-empty title |
| Tool body | full rawOutput every update | diff → `resultDelta` / output text |
| Plan entry | ACP `content`/`priority` | `id` + `title` + status |
| Permission label | ACP `name` | UI `label` |
| Permission id | missing | stable requestId for resolve |
| Cancel terminal | `done` + stopReason cancelled only | distinct cancelled / interrupted |
| sessionId on envelope | remote ACP id | **AO local** session/conversation id |

---

## 4. IPC vs AO SSE (transport decision)

| Dimension | ABF IPC `agent:stream` | AO CDC SSE today | Fenzhi conversation live path | Recommendation for stream migration |
| --- | --- | --- | --- | --- |
| Carrier | Electron main → renderer | `EventSource` `/api/v1/events` | REST snapshot poll (+ planned mux) | Daemon HTTP; not Electron ACP |
| Payload | Full `AgentStreamEvent` | Change-log style invalidation | Full ordered snapshot | **Tokens:** either sequenced live events or revisioned snapshot fields—not workspace-only invalidation |
| Ordering | `sequence` on event | Last-Event-ID cursor | Server-ordered snapshot | Server is authority for order |
| Reconnect | lastSequence drop | Last-Event-ID resume | Refetch snapshot | Snapshot catch-up mandatory |
| Permissions | IPC invoke | n/a | REST resolve + snapshot | REST resolve |
| High-frequency text | Client rAF batch | Low rate CDC | Poll absorbs | Batch on client **or** coalesce in projector |
| Multi-client | Single Electron window | Multi-subscriber | Multi-client REST | Prefer Fenzhi multi-client model |

**Anti-pattern:** emitting token deltas only as CDC “conversation.updated” without payload, then refetching huge snapshots every token without coalescing—too heavy. Prefer projector-side coalesce + throttled invalidate, or a dedicated conversation SSE channel with batched events.

---

## 5. Tests that must port

### P0 stream tests (minimum bar)

| # | Test | Source to port from | Assert |
| --- | --- | --- | --- |
| T1 | Parser/validator rejects malformed envelope (missing sequence/sessionId/type) | ABF `agentStreamIpc.test.ts` | Invalid → drop |
| T2 | Reducer ignores `sequence <= lastSequence` | ABF `agentStreamCore` tests | No double text |
| T3 | `text_delta` appends by itemId | ABF core | Concat order correct |
| T4 | `thinking_update` delta vs replace | ABF core | Replace not merged with delta incorrectly |
| T5 | `tool_call` then `tool_update` with resultDelta | ABF + Fenzhi client map | Status + append body |
| T6 | `plan` full replace | ABF + Fenzhi plan map | Entries replaced, not merged by accident |
| T7 | `permission_request` then clear on terminal/resolve | ABF core | No stuck waiting_permission |
| T8 | Terminal `done` / `error` / `cancelled` finalize | ABF core | Phase terminal; partials sealed |
| T9 | Batch coalesce consecutive text/thinking/tool progressive | ABF `agentStreamBatch` tests | Coalesced sequence = last; reduce still idempotent |
| T10 | ACP SessionUpdate → normalized events map | Fenzhi `driver_test` / ABF adapter tests | Golden ACP fixtures |
| T11 | Cancel maps to cancelled/interrupted not success | Both | Terminal kind correct |
| T12 | Reconnect: snapshot/resync does not re-append full history as new deltas | Design | Catch-up replaces or advances cursor |

### Nice-to-have (P1)

- Slow consumer / full buffer disconnect (Fenzhi Events channel policy)  
- Nested subagent activity text (Fenzhi)  
- Fail-open silence using `lastEventAt` (ABF stream state)  
- Parallel legacy + normalized path no double-append (ABF coexistence)

---

## 6. P0 stream gaps (current main) — ranked

These are the **only** P0 items for **streaming output** migration:

| Rank | Gap | Why P0 | Owner |
| --- | --- | --- | --- |
| **S0** | No normalized agent stream event model on main | Nothing to render or project | Backend (+ FE types) |
| **S1** | No ACP→normalized map (StreamNormalizer / driver SessionUpdate switch) | Wire never becomes UI facts | Backend |
| **S2** | No monotonic sequence / revision for stream items | Replay and multi-client double-append | Backend |
| **S3** | No append-only text/thinking/tool delta rules enforced | Garbled transcript | Backend + FE reducer |
| **S4** | No plan replace + permission stream events | Incomplete turn UX | Backend + FE |
| **S5** | No terminal event contract (done/error/cancelled) | Stuck streaming / wrong stop UX | Backend + FE |
| **S6** | No live delivery path for conversation stream (poll/SSE/mux) beyond generic CDC | UI cannot see tokens | Backend transport + FE subscribe |
| **S7** | No batch/coalesce strategy for high-frequency deltas | UI jank or SSE flood | FE batcher and/or BE projector |
| **S8** | Missing unit tests T1–T12 | Regressions inevitable | Both |

### Explicit non-P0 for this streaming slice

Package resolve, multi-provider product matrix, MCP product config, session/load vs resume product policy, skills, elicitation, usage banners—track elsewhere; do not block S0–S8.

---

## 7. Backend vs frontend — stream first

### Backend first (blocks meaningful FE)

1. Event vocabulary (`ChatEvent` **or** AO-native clone of ABF union) at the driver boundary.  
2. ACP `session/update` mapping: text, thinking, tool, plan, permission, usage optional.  
3. Sequence/revision allocation + serialized emit per conversation.  
4. Terminal mapping from prompt result / cancel / process death.  
5. Delivery: project into snapshot **and/or** push sequenced live events over HTTP SSE (not Electron IPC).  
6. Tests T5, T6, T10, T11 + sequence monotonicity.

### Frontend next

1. Types for stream/snapshot items (generated from OpenAPI when possible).  
2. Reducer or snapshot mapper: append deltas, replace plan, show permission, handle terminal.  
3. Port ABF batcher if applying event lists to a store; else rely on snapshot throttle.  
4. Subscribe path: poll active interval (Fenzhi) **or** conversation SSE; use CDC only as invalidate hint if payloads stay on REST.  
5. Tests T1–T4, T7–T9, T12.

### Transport choice (record decision in PR)

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Fenzhi snapshot poll** | Multi-client, simple reconnect, matches AO REST | Token latency = poll interval unless mux added |
| **B. Sequenced conversation SSE** | Low latency; ABF sequence tests apply almost 1:1 | Need cursor, backpressure, coalescing |
| **C. Hybrid** | Snapshot catch-up + SSE live tail | Most moving parts |

**Suggested:** A for MVP stream correctness; add B/C when latency requires it. Either way enforce S2–S5.

---

## 8. Suggested module touchpoints (current AO)

```text
backend/internal/ports/          # ChatEvent or stream event contracts
backend/internal/adapters/…/acp  # SessionUpdate → events (normalizer)
backend/internal/service/…       # project + sequence + optional SSE
backend/internal/httpd/…         # conversation snapshot and/or stream route
frontend/src/…                   # reducer/batcher or snapshot UI binding
docs/plans/acp-abf-fenzhi-gap-matrix.md  # this streaming matrix
```

ABF references only (do not copy Electron process ownership):

```text
frontend/src/types/agentStreamTypes.ts
frontend/src/core/chat/agentStreamCore.ts
frontend/src/core/chat/agentStreamBatch.ts
frontend/src/hooks/agentStreamIpc.ts
```

---

## Document control

| Item | Value |
| --- | --- |
| Scope | **ACP streaming output only** |
| Preferred ownership | Daemon (Fenzhi) |
| Preferred event purity / sequence / batch | ABF |
| Preferred reconnect | Snapshot catch-up (Fenzhi) |
| Current main stream status | Absent |
