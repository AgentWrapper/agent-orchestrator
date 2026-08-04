# ACP Migration Plan: AllBeingsFuture concepts → AO main (fenzhi architecture)

**Status:** planning deliverable (docs only)  
**Date:** 2026-08-04  
**Target branch base:** current `main` (no Chat API / no `chatdriver` today)  
**Authoritative design reference:** Desktop `fenzhi` (`/Users/zhongshengjieweilai/Desktop/fenzhi`)  
**Capability / product-reference source:** Desktop `AllBeingsFuture` (`/Users/zhongshengjieweilai/Desktop/AllBeingsFuture`)  

This plan is intentionally **implementation-free**. It tells implementer workers what to port, in what order, and what not to copy.

---

## 1. Executive summary

| Source | Role in this migration |
| --- | --- |
| **fenzhi** | **Primary port target.** Go daemon owns ACP lifecycle, domain conversation model, Chat service/controller, HTTP API, SQLite durability, CDC updates, and desktop chat UI. SDK: `github.com/coder/acp-go-sdk`. |
| **AllBeingsFuture (ABF)** | **Capability and contract reference.** Normalized streaming UX concepts, permission mediation, package-resolve heuristics, test matrices, and docs about ACP v1 mapping. **Do not** lift ABF’s Electron-main ACP transport into AO product. |
| **AO main today** | TUI/terminal agent sessions only. No `ports.Chat*`, no `chatdriver`, no conversation tables, no conversation HTTP routes, no chat renderer surface. |

**Design decision (settled):** Prefer **fenzhi’s Go backend ACP stack** over porting ABF’s TypeScript Electron ACP adapter as-is. Map ABF product capabilities into AO ports/events; keep daemon protocol logic out of the Electron renderer.

---

## 2. Architecture mapping table

Status key for **main today**:

- **absent** — not present on main  
- **partial** — related surface exists but Chat/ACP is missing  
- **present (fenzhi only)** — exists fully in fenzhi; copy path is known  

| ABF component | AO (fenzhi) component | Status on main | Migration action |
| --- | --- | --- | --- |
| Electron main `@agentclientprotocol/sdk` + `electron/bridge/adapters/acp.ts` | `backend/internal/adapters/chatdriver/acp/*` + `github.com/coder/acp-go-sdk` | **absent** | Port fenzhi ACP package; do not port Node SDK into product daemon |
| `electron/bridge/acp-package-resolve.ts` | Provider binding probe/launch (`claudeacp`, `nativeacp`, …) + existing agent plugins’ `ResolveBinary` | **partial** (agent plugins exist; no Chat binding) | Port fenzhi bindings; optionally reuse ABF **heuristics** only if a binding needs path discovery AO plugins lack |
| `BridgeManager` + adapter registry | `chatdriver/registry` + daemon wiring of `ChatDriverRegistry` | **absent** | Port registry + wire in `daemon` |
| `BridgeEvent` (adapter-internal) | `ports.ChatEvent` + domain activity/message projection | **absent** | Port fenzhi port + projector; ABF BridgeEvent is conceptual only |
| `StreamNormalizer` → sequenced `AgentStreamEvent` | Chat **controller** projects provider events → durable rows; clients get snapshot + CDC (not IPC stream of raw deltas) | **absent** | Port fenzhi service/controller + storage; do **not** reintroduce ABF IPC sequence protocol as product wire format |
| `agent:stream` IPC envelope (`sessionId`, `sequence`, …) | Loopback HTTP conversation snapshot + SQLite CDC change_log (existing AO pattern) | **partial** (CDC exists; no conversation entities) | Extend CDC/triggers for conversation tables; frontend consumes daemon API |
| `agent:permission:respond` IPC | `POST .../conversation/approvals/{requestId}/resolve` | **absent** | Port HTTP + service path |
| `ProcessService.StopProcess` cancel | `POST .../conversation/interrupt` + driver `session/cancel` | **partial** (session kill exists; not Chat interrupt) | Port Chat interrupt; keep session terminate separate |
| Renderer `agentStreamCore` / `agentStreamTypes.ts` | `frontend/.../components/chat/*` + `hooks/useConversation.ts` + domain-aligned TS types from OpenAPI | **absent** | Port fenzhi chat UI; map ABF UX ideas (permission card, plan, tool status) into fenzhi components—not ABF CSS/layout wholesale |
| Legacy CLI parsers (`electron/parser/*`) | **Out of Chat path.** AO TUI mode already uses terminal adapters | **present** (TUI) | Non-goal for Chat; TUI remains default session mode |
| ABF provider profiles (`acp`, `claude-sdk`, `codex-appserver`, …) | Harness + `SessionMode` (`tui` \| `chat`) + driver registry | **partial** (harnesses exist; no mode column) | Add `SessionMode`; Chat drivers for selected harnesses |
| ABF SQLite chat messages in Electron | `conversations` / `conversation_turns` / `messages` / `activities` (+ later migrations) | **absent** | Port fenzhi migrations (re-numbered after main head) |
| ABF clean-room ACP v1 docs | This plan + optional `docs/` architecture note after ship | **absent** | Keep product docs AO-native; cite public ACP schema only |

### 2.1 Layer ownership (target AO)

```text
Renderer (Electron)
  SessionChatSurface · ChatComposer · approvals/plans/tools UI
  useConversation → HTTP + CDC
  NEVER imports acp-go-sdk / Node ACP SDK / provider wire DTOs
        │  loopback HTTP (127.0.0.1, unauthenticated)
        ▼
Daemon (Go)
  httpd/controllers/conversations*.go
  service/chat (Service + Controller)
  ports.ChatDriver / ChatConversation / ChatEvent
  adapters/chatdriver/{acp,claudeacp,nativeacp,droidacp,opencodeacp,codexappserver,registry}
  storage/sqlite conversation* + CDC triggers
        │  stdio NDJSON JSON-RPC (or Codex app-server)
        ▼
Provider process (user-installed CLI / packaged bridge only where fenzhi already does)
```

Hard rules from `AGENTS.md` remain binding: loopback unauthenticated; CLI thin HTTP client; no daemon protocol in renderer; `~/.ao` only for app state.

---

## 3. Capability gap analysis

### 3.1 ABF capability → fenzhi coverage

| Capability | ABF | fenzhi design | Gap vs main | Notes for AO port |
| --- | --- | --- | --- | --- |
| Stable ACP v1 stdio client | Yes (TS SDK) | Yes (Go SDK `acp-go-sdk` v0.13.5 in fenzhi) | Main missing | Pin SDK version in `backend/go.mod` when porting |
| `initialize` / protocolVersion gate | Yes | Yes | Main missing | Reject non-v1; no experimental v2 |
| `session/new` + resume (`session/load` or resume capability) | Yes | Yes (resume required for production floor) | Main missing | Production floor: streaming + approvals + interrupt + resume |
| Prompt turn + streaming text | Yes | `message.delta` / `message.completed` | Main missing | Durable message rows + in-place delta mutation |
| Thinking / reasoning | Yes (`thinking_update`) | `reasoning.delta` + `ActivityKindReasoning` | Main missing | Hideable reasoning |
| Tool calls | Yes | activities (`command`, `mcp_tool`, …) | Main missing | Prefer typed activities over free-form tool blobs |
| Plans | Yes | `turn.plan` + plan activity | Main missing | Full snapshot replace semantics (ABF + fenzhi agree) |
| Permissions / approvals | Yes | `approval.requested` / resolve API | Main missing | Provider-offered decision options only (`ErrChatDecisionNotOffered`) |
| Cancel in-flight turn | Yes | interrupt | Main missing | Map late stop → `ErrChatNoActiveTurn` (ordinary, not 500) |
| Legacy + native dual path | Yes (explicit) | Chat vs TUI session modes | TUI only on main | Keep TUI default; Chat opt-in per session |
| Sequenced live stream IPC | Yes | **Different:** durable sequence + CDC | Main has CDC only | Do not clone ABF IPC sequence as API; follow fenzhi |
| Compaction | Weak / optional | First-class capability + API | Main missing | Later phase OK |
| Steer mid-turn | No (ABF) | `ChatSteerer` + API | Main missing | Codex-first; optional for ACP agents |
| Config options / models / skills | Partial status messages in ABF docs | First-class list/set APIs | Main missing | Phase after core chat |
| Usage / rate limits / diffs / MCP reload | Partial | Full port surfaces in fenzhi | Main missing | Phase after core chat |
| Nested agents / elicitation / images | Partial product | Capabilities modeled in ports | Main missing | Capability-gated; do not block MVP |
| Package resolve for packaged ACP adapters | Yes (Node) | `frontend/acp-runtime` + `claudeacp` runtime resolve | Main missing | Port fenzhi packaging, not ABF resolve wholesale |
| Fake ACP agent tests | Yes (`fixtures/fake-acp-agent.ts`) | Go unit tests + e2e chat suite | Main missing | Prefer fenzhi Go tests; ABF fixture ideas only |

### 3.2 What ABF has that fenzhi already covers (port fenzhi, not ABF code)

- Provider-neutral streaming UX (text, thinking, tools, plan, permissions, terminal turn states).
- Permission request/response mediation with cancel-on-stop.
- Native ACP process lifecycle (init → session → prompt → cancel → teardown).
- MCP server injection into session setup (stdio/http/sse negotiation).
- Separation of renderer from ACP SDK.

### 3.3 What ABF has that is still product/design work on top of fenzhi

- ABF-specific supervisor/child mission product model (out of scope for Chat MVP).
- ABF proprietary conversation UI (layout, stickers, virtualization details)—**do not wholesale copy**.
- ABF package-resolve edge cases for multi-layout Electron packaging—audit against AO forge packaging only if Claude ACP runtime packaging fails.
- ABF dual “legacy adapter still emits BridgeEvent” path—AO already has TUI mode; no need for a second legacy chat normalizer in process.

### 3.4 What fenzhi has that ABF does not (bring intentionally)

- Separate **Chat port** from Agent/Runtime (no keystroke “send”).
- Durable conversation model (messages ≠ activities; conversation-scoped immutable sequence).
- Production capability floor for mutating workspace Chat sessions.
- Steer, compaction, rollback, fork, rename, config options, skills, MCP reload, usage/rate limits as first-class optional interfaces.
- Codex **app-server** driver (`codexappserver`) as a non-ACP machine protocol beside ACP.
- Full HTTP OpenAPI surface under `/api/v1/sessions/{sessionId}/conversation/*`.
- Backend e2e suite (`backend/e2e/chat_*.go`).

---

## 4. Main baseline (facts to preserve)

As of this plan’s research against the worktree’s then-current main lineage:

| Area | Main state |
| --- | --- |
| `backend/internal/ports/` | No `chat.go` / `chat_steer.go` |
| `backend/internal/adapters/chatdriver/` | **Does not exist** |
| `backend/internal/service/chat/` | **Does not exist** |
| `backend/internal/domain/conversation.go` / `sessionmode.go` | **Do not exist** |
| SQLite migrations | Head around `0042_review_run_unique_per_harness.sql` (no conversation migrations) |
| HTTP DTOs / OpenAPI | No conversation operations |
| Frontend | No `renderer/components/chat/` |
| Agent plugins | TUI launch/auth already exist for many harnesses (reuse for Chat probe/launch) |
| CDC | Present for sessions etc.; extend for conversation tables via triggers |

fenzhi conversation migrations start at `0041_chat_session_mode.sql` through `0051_...`. On main they must be **re-numbered** after the live head (never edit already-merged migrations).

---

## 5. File-level port list

### 5.1 Primary port from fenzhi (authoritative)

Port in dependency order. Paths are relative to repo root; source tree is fenzhi.

#### Phase A — domain + ports (no process I/O)

| fenzhi path | Notes |
| --- | --- |
| `backend/internal/domain/sessionmode.go` (+ test) | `tui` / `chat`; default `tui` |
| `backend/internal/domain/conversation.go` | Durable model + plan types |
| `backend/internal/ports/chat.go` | ChatDriver, events, capabilities, errors |
| `backend/internal/ports/chat_steer.go` | Optional steerer |

#### Phase B — storage

| fenzhi path | Notes |
| --- | --- |
| `backend/internal/storage/sqlite/migrations/0041_chat_session_mode.sql` … `0051_*.sql` | Re-number as `00NN+` on main |
| `backend/internal/storage/sqlite/queries/conversations.sql` (+ session column queries) | sqlc source |
| `backend/internal/storage/sqlite/store/conversation_store.go` (+ history store tests) | |
| Generated `gen/*` via `npm run sqlc` only | Do not hand-edit gen |

#### Phase C — chatdriver adapters

| fenzhi path | Notes |
| --- | --- |
| `backend/internal/adapters/chatdriver/acp/*.go` | Lifecycle + mapping; owns ACP |
| `backend/internal/adapters/chatdriver/registry/*` | |
| `backend/internal/adapters/chatdriver/claudeacp/*` | Claude via packaged ACP runtime + `CLAUDE_CODE_EXECUTABLE` |
| `backend/internal/adapters/chatdriver/nativeacp/*` | Shared native binding helper |
| `backend/internal/adapters/chatdriver/droidacp/*` | |
| `backend/internal/adapters/chatdriver/opencodeacp/*` | |
| `backend/internal/adapters/chatdriver/codexappserver/*` | Non-ACP; keep as parallel driver |

#### Phase D — service + session manager hooks

| fenzhi path | Notes |
| --- | --- |
| `backend/internal/service/chat/*` | Service, controller, history, steer, skills |
| `backend/internal/session_manager/chat_spawn.go` (+ tests, attachments) | Spawn path for Chat mode |
| Session status derivation updates that treat Chat activity | e.g. fenzhi `service/session/status.go` Chat exemption patterns |
| Daemon wiring of registry + chat service | Follow fenzhi `daemon` patterns |

#### Phase E — HTTP + OpenAPI + CLI (if any)

| fenzhi path | Notes |
| --- | --- |
| `backend/internal/httpd/controllers/conversations*.go` (+ tests) | |
| `backend/internal/httpd/controllers/dto.go` conversation DTOs | |
| `backend/internal/httpd/apispec/specgen/build.go` operations | Then `npm run api` |
| CLI only if fenzhi exposes chat commands still desired | Thin HTTP; mirror DTOs; table tests |

#### Phase F — frontend

| fenzhi path | Notes |
| --- | --- |
| `frontend/src/renderer/components/chat/**` | AO design system / DESIGN.md |
| `frontend/src/renderer/hooks/useConversation.ts` (+ test) | |
| `frontend/src/renderer/types/conversation.ts` | Prefer OpenAPI-generated types where possible |
| Session surface integration (mode toggle / chat panel entry) | Surgical; do not restyle board |
| `frontend/acp-runtime/**` + `frontend/scripts/build-acp-runtime.mjs` | Packaged Claude ACP adapter runtime only |

#### Phase G — tests & packaging

| fenzhi path | Notes |
| --- | --- |
| `backend/e2e/chat_*.go` + `harness_test.go` | Bring after API stable |
| Unit tests colocated with adapters/service | Port with code |
| `backend/go.mod` / `go.sum` | Add `github.com/coder/acp-go-sdk` |

### 5.2 Selective concepts from ABF (not wholesale file ports)

Use as **requirements and test ideas**, re-implement inside fenzhi shapes:

| ABF path | Extract | Re-home in AO |
| --- | --- | --- |
| `docs/acp-architecture.md` | Lifecycle diagram, security notes, capability honesty (no fs/terminal client caps until implemented) | This plan + future `docs/` architecture section |
| `frontend/docs/acp-renderer-streaming.md` | Event semantics (append-only deltas, plan replace, terminal events) | Verify fenzhi projector + UI match; do not invent ABF IPC on daemon |
| `electron/bridge/adapters/acp.ts` | Mapping table ACP v1 → UI concepts; permission cancel-on-destroy; MCP capability assert | Cross-check `chatdriver/acp/client.go` + conversation mapping |
| `electron/bridge/types.ts` | BridgeEvent kind inventory for gap checklist | Already covered by `ports.ChatEventKind` |
| `frontend/src/types/agentStreamTypes.ts` | Product UX event set | Ensure fenzhi UI covers parity items needed for MVP |
| `electron/bridge/acp-package-resolve.ts` | Candidate node_modules roots / unpack heuristics | Only if AO desktop packaging of `acp-runtime` needs it |
| `electron/tests/acp-*.ts` | Cases: handshake fail, permission respond, cancel, package resolve | Port as Go tests / e2e assertions |
| `electron/services/agent-stream-normalizer.ts` | Diff tool_call_update replacement content into deltas | Confirm fenzhi activity projection does equivalent |

**Explicit non-ports from ABF:** `electron/parser/*` legacy log parsers for Chat; proprietary mission/team UI; stickers; ABF Zustand stores; ABF IPC channel names.

---

## 6. Phased PR breakdown

Keep **one concern per PR**. Conventional commits. Each PR should leave main green.

### PR-0 — Docs (this document)

- **Scope:** `docs/plans/acp-migration-from-abf-fenzhi.md` only  
- **Exit:** Team agrees architecture (fenzhi primary, ABF concepts only)

### PR-1 — Backend core: domain, ports, schema foundation

- Add `SessionMode`, conversation domain types, `ports.Chat*`  
- Migration(s) for: `sessions.mode`, `provider_conversation_id`, core `conversations` / turns / messages / activities tables + CDC triggers  
- Store interfaces + sqlc  
- **No** live provider process required  
- **Tests:** domain pure tests; store tests with sqlite  
- **Success:** can create Chat-mode session row + empty conversation snapshot in tests

### PR-2 — Chat service/controller (fake driver)

- `service/chat` with in-memory/fake `ChatDriver`  
- Project events to durable rows; approvals; interrupt  
- Session manager spawn hook for Chat (still fake driver)  
- **Tests:** controller unit tests from fenzhi (trimmed)  
- **Success:** send message → deltas persist → interrupt → approval resolve against fake

### PR-3 — Provider-neutral ACP driver + registry

- Port `chatdriver/acp` + registry  
- Wire daemon  
- Fake ACP agent or recorded pipes in unit tests  
- **Success:** ACP handshake + turn + permission + cancel against fake process

### PR-4 — Provider bindings (split if needed)

Recommended sub-order:

1. **codexappserver** (often highest product value; non-ACP) **or** **claudeacp** (ACP + packaged runtime)—product owner picks first ship harness  
2. `nativeacp` + `opencodeacp` + `droidacp`  
3. Packaging: `frontend/acp-runtime` for Claude bridge  

Each binding reuses existing agent plugin `ResolveBinary` / `AuthStatus`.

**Success per binding:** `Probe` works; Start/Resume/SendTurn/Interrupt/approvals green in unit or gated live tests.

### PR-5 — HTTP API + OpenAPI + typed client

- Controllers + DTOs  
- `npm run api` → commit `openapi.yaml` + `frontend/src/api/schema.ts`  
- Map port errors to stable API error codes  
- Optional thin CLI conversation commands if product wants them  
- **Tests:** httptest controller tests; api drift tests  

### PR-6 — Frontend chat surface

- Port fenzhi chat components + `useConversation`  
- Session inspector / workbench entry for Chat mode  
- Approvals, plans, tools, interrupt, composer  
- Follow `DESIGN.md` / agent-orchestrator look; no ABF skin  
- **Tests:** component tests; smoke e2e if feasible  

### PR-7 — Hardening: advanced capabilities + e2e

- Compaction, steer, models/config options, skills, usage, diffs, MCP reload as prioritized  
- Port fenzhi `backend/e2e/chat_*.go`  
- Docs: architecture note + STATUS.md  

### Suggested dependency graph

```text
PR-0 docs
  └─▶ PR-1 domain/schema
        └─▶ PR-2 service (fake)
              ├─▶ PR-3 acp core
              │     └─▶ PR-4 bindings (+ packaging)
              └─▶ PR-5 HTTP/OpenAPI ──▶ PR-6 frontend
                                        └─▶ PR-7 e2e/advanced
```

PR-3 and PR-5 can partially parallelize after PR-2 if API contracts are frozen from fenzhi DTOs early—prefer freezing OpenAPI from fenzhi shapes in PR-5 only after service methods stabilize.

---

## 7. Event / API contract mapping (ABF stream → AO Chat)

Implementers should treat the **right-hand column** as product truth.

| ABF `AgentStreamEvent` | AO `ports.ChatEvent` / domain | HTTP / UI effect |
| --- | --- | --- |
| `text_delta` | `message.delta` | Mutate assistant message in place |
| `thinking_update` | `reasoning.delta` / reasoning activity | Collapsible reasoning |
| `tool_call` / `tool_update` | `activity.started` / `activity.completed` (+ command output deltas) | Tool/command cards |
| `plan` | `turn.plan` | Replace plan UI |
| `permission_request` | `approval.requested` | Approval card; resolve via POST |
| `status` | `controller.state` + turn state | Banners / busy |
| `done` / `cancelled` / `error` | `turn.completed` + `TurnState*` / `error` | Finalize turn |
| IPC `sequence` | Conversation `sequence` on rows + CDC | Client applies by sequence; no ABF IPC |

---

## 8. Risks

1. **Schema renumbering / migration collision** — fenzhi `0041+` collides with main’s non-chat migrations; must resequence and retest empty + upgrade DBs.  
2. **SDK version skew** — `acp-go-sdk` vs ABF Node SDK vs provider agents; negotiate only stable v1; pin and test handshake failures.  
3. **Resume semantics** — silent new conversation after daemon restart is forbidden (`ErrChatResumeFailed`); UI must force recovery choice.  
4. **Dual mode confusion** — Chat vs TUI on same harness; mode immutable per session; status derivation and “send” paths must not cross.  
5. **Packaging Claude ACP runtime** — Node bridge packaging (`acp-runtime`) can break desktop updates if not integrated into forge build.  
6. **Permission consent bugs** — inventing decision options or auto-allow-always without policy is a security defect.  
7. **Scope creep from ABF UI** — copying ABF conversation chrome violates AO design system and delays ship.  
8. **Codex app-server vs ACP** — two machine protocols; keep separate packages; do not force Codex through ACP if fenzhi uses app-server.  
9. **CDC lag / projector races** — deferred turn start (fenzhi `ChatDeferredTurnStarter`) must be preserved to avoid event loss.  
10. **Live provider flakiness** — gate live tests; keep fake/unit coverage as merge gate.

---

## 9. Non-goals

- Porting ABF Electron-main ACP TypeScript stack as AO’s product transport.  
- Putting ACP SDK or provider wire parsing in the renderer.  
- Adopting experimental ACP v2 / remote HTTP-WS ACP in the first ship.  
- Replacing TUI mode or forcing all harnesses to Chat.  
- Wholesale ABF UI, mission/team/sticker product surfaces.  
- Auto-accept permissions by default.  
- Advertising client `fs` / `terminal` ACP capabilities until AO implements them safely (fenzhi deliberately refuses).  
- Editing already-merged SQLite migrations.  
- npm-as-primary distribution changes.  
- Implementing the full stack in the planning session (this PR).

---

## 10. Success criteria

### MVP (after PR-1…PR-6 for at least one harness)

- [ ] Session can be created with `mode=chat` for a supported harness; default remains `tui`.  
- [ ] Daemon owns provider process; renderer only uses loopback HTTP + CDC.  
- [ ] User can send a message, see streaming assistant text, tools/activities, and plans.  
- [ ] User can resolve a permission request with only provider-offered options.  
- [ ] User can interrupt a turn; late interrupt is a soft error, not a crash.  
- [ ] Daemon restart resumes provider conversation or surfaces resume failure—never silent empty thread.  
- [ ] Production floor capabilities enforced before workspace-mutating Chat.  
- [ ] OpenAPI + `schema.ts` committed and drift-clean.  
- [ ] `go test` for touched packages and relevant e2e/unit gates green.  
- [ ] No ACP protocol logic in Electron renderer; no `~/Library/Application Support` state.

### Full fenzhi parity (PR-7+)

- [ ] Codex app-server + Claude ACP + at least one native ACP harness.  
- [ ] Steer/compaction/config options/skills/usage as capability-gated UI.  
- [ ] Backend e2e chat suite ported and running in CI where feasible.

---

## 11. Recommended worker spawn order

1. **Backend domain/schema worker** — PR-1  
2. **Backend chat service worker** — PR-2 (depends on 1)  
3. **Backend ACP driver worker** — PR-3 (depends on 2)  
4. **Backend provider binding worker(s)** — PR-4 (depends on 3; can fan out per harness)  
5. **Backend HTTP/OpenAPI worker** — PR-5 (depends on 2; ideally after 3 method freeze)  
6. **Frontend chat UI worker** — PR-6 (depends on 5)  
7. **E2E/hardening worker** — PR-7 (depends on 4+6)

Do **not** start frontend before OpenAPI exists. Do **not** start provider live tests before fake-driver controller is green.

---

## 12. Explicit next actions for implementer workers

1. Confirm product **first ship harness** (Claude ACP vs Codex app-server).  
2. Diff fenzhi vs main for session spawn/status/daemon wiring and list exact merge conflicts expected (main has moved past some fenzhi bases).  
3. Land PR-1 with renumbered migrations; run `npm run sqlc`.  
4. Port `ports/chat.go` verbatim in spirit (keep comments that encode rules).  
5. Introduce fake driver before real ACP process code.  
6. Port `chatdriver/acp` with `acp-go-sdk`; refuse client fs/terminal caps.  
7. Wire registry in daemon; keep loopback bind unchanged.  
8. Generate API; only then port fenzhi chat UI.  
9. Add packaging for `acp-runtime` if Claude is first ship.  
10. Track STATUS.md once MVP merges.

---

## 13. Reference inventory (read-only sources)

### fenzhi

- `backend/internal/ports/chat.go`, `chat_steer.go`  
- `backend/internal/adapters/chatdriver/**`  
- `backend/internal/service/chat/**`  
- `backend/internal/domain/conversation.go`, `sessionmode.go`  
- `backend/internal/httpd/controllers/conversations*.go`  
- `backend/internal/storage/sqlite/migrations/0041_chat_session_mode.sql` … `0051_*`  
- `frontend/src/renderer/components/chat/**`, `hooks/useConversation.ts`  
- `frontend/acp-runtime/package.json`  
- `backend/e2e/chat_*.go`  
- `backend/go.mod` → `github.com/coder/acp-go-sdk`

### AllBeingsFuture

- `docs/acp-architecture.md`  
- `frontend/docs/acp-renderer-streaming.md`  
- `electron/bridge/adapters/acp.ts`  
- `electron/bridge/acp-package-resolve.ts`  
- `electron/bridge/types.ts`  
- `frontend/src/types/agentStreamTypes.ts`  
- `electron/tests/acp-*.ts`

### Public ACP

- Stable schema: https://github.com/agentclientprotocol/agent-client-protocol (`schema/v1`)  
- Go SDK: `github.com/coder/acp-go-sdk`  
- Do not use experimental v2 product paths

---

## 14. Open decisions (need product/orchestrator input)

| Decision | Options | Recommendation |
| --- | --- | --- |
| First Chat harness | Claude ACP / Codex app-server / OpenCode native | Codex if app-server stability is known in fenzhi; else Claude if desktop packaging ready |
| Default mode for new sessions | Always `tui` / opt-in Chat / harness-default | Keep **default `tui`** (fenzhi) |
| CLI conversation commands | HTTP-only first / add `ao chat` subset | HTTP-only first; CLI later if needed |
| How much of fenzhi advanced capabilities in MVP | Core stream+approve+interrupt+resume only / full parity | **Core first**; advanced in PR-7 |

---

*End of plan. Implementation must follow `AGENTS.md` hard rules and keep changes surgical per PR.*
