# ACP Renderer Streaming Contract (Agent Orchestrator)

## Scope and compatibility

This renderer slice targets the stable Agent Client Protocol (ACP) wire protocol version `1` **on the daemon side only**. The Electron renderer:

- does **not** depend on `@agentclientprotocol/sdk`
- does **not** speak raw ACP JSON-RPC
- consumes **normalized** `AgentStreamEvent` envelopes over daemon HTTP/SSE

Source of truth for TypeScript shapes:

- `frontend/src/renderer/types/agentStreamTypes.ts`
- `frontend/src/renderer/types/streamMessages.ts` (reducer output rows)
- pure reduce/batch: `frontend/src/renderer/lib/agent-stream/`

Semantics are adapted from AllBeingsFuture’s `acp-renderer-streaming.md` and `agentStreamCore` / `agentStreamBatch`.

## Backend → renderer

Provisional SSE route (not yet on `main` OpenAPI):

```http
GET /api/v1/sessions/{sessionId}/agent-stream
```

Recommended frame:

```text
event: agent_stream
data: {"type":"text_delta","sessionId":"...","sequence":1,"itemId":"...","delta":"..."}
```

Default `message` events with the same JSON body are also accepted.

Envelope requirements:

| Field | Rule |
| --- | --- |
| `sessionId` | string; if omitted on the wire, the transport fills from the path |
| `sequence` | required, non-negative, strictly increasing per session |
| `timestamp` | optional ISO string |
| `source` | optional `{ kind: 'native-acp-v1' \| 'legacy-adapter', provider? }` |

Event types (see `AgentStreamEvent`):

- `text_delta` — append-only assistant text (`delta` is a fragment, never the full buffer)
- `thinking_update` — `mode: 'delta' \| 'replace'`
- `tool_call` / `tool_update` — tool lifecycle; progressive `resultDelta` / `output` are append-only
- `plan` — full plan replacement
- `status` — `starting` \| `running` \| `waiting` \| `idle`
- `permission_request` — options with `optionId`, `label`, `kind`
- `done` / `error` / `cancelled` — terminal for the current turn

The reducer ignores `sequence <= lastSequence` so retransmission is safe.

## Renderer → backend

Permission choice (provisional):

```http
POST /api/v1/sessions/{sessionId}/agent-stream/permissions/{requestId}
Content-Type: application/json

{ "optionId": "allow_once" }
```

Implemented in `respondToAgentPermission`. A non-2xx response leaves the permission UI open and surfaces the error.

Cancellation continues through existing session stop / interrupt APIs once wired; the stream state enters `cancelling` via `requestAgentStreamCancellation` optimistically.

## Batching

High-frequency events (`text_delta`, progressive `thinking_update`, in-progress `tool_update`) are coalesced per animation frame (`createAgentStreamBatcher`) so React does not re-render on every token. Terminal events flush immediately.

## UI surface

Minimal AO-styled components (not a wholesale ABF ConversationView port):

- `AgentStreamTimeline` — text / thinking / tool cards
- `AgentActivityPanel` — plan + permission
- `AgentStreamSurface` — header + timeline + activity
- `useAgentStream` — batcher + optional SSE + permission POST

## Backend status

As of this frontend PR, the provisional routes above are **not** present on `main` OpenAPI. The pure reducer, batcher, parser, and UI work offline via `pushEvents`. Live SSE stays `connection: unavailable` until the daemon implements the contract.

## Clean-room / dependency note

- No `@agentclientprotocol/sdk` in the renderer
- No Electron IPC `agent:stream` / `agent:permission:respond` channels (ABF); AO uses loopback daemon HTTP/SSE
