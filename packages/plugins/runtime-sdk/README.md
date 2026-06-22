# @aoagents/ao-plugin-runtime-sdk

Runtime plugin that drives **Claude via [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/overview)** instead of a tmux PTY. It is the **first streaming runtime adapter** for AO: **no terminal**, token-level events, and a live, subscribable normalized-event stream that a real-time chat UI (Maestro) connects to directly.

`runtime-tmux` stays the default; select this runtime with `defaults.runtime: sdk` (or `runtime: sdk` per session).

## Authentication

The SDK bundles the Claude Code binary, which reads the user's existing Claude login (`~/.claude`, macOS keychain / OAuth). **No `ANTHROPIC_API_KEY` is required** — a subscription login works. The plugin never reads or sets an API key; it resolves auth from the existing login exactly like Claude Code does. (Confirmed: a real `query()` runs with `ANTHROPIC_API_KEY` unset and reports `apiKeySource: "none"`.)

## Architecture

```
ao Lifecycle ─create()─▶ index.ts (client)  ──spawn detached──▶  sdk-host.js (HOST, long-lived)
                              │                                       │ owns query() streaming session
   sendMessage / isAlive /    │  Unix socket / named pipe (NDJSON)    │ writes events.ndjson
   getOutput / destroy  ◀─────┘◀──────────────────────────────────────┤ fans out normalized events
                                                                       │
   Maestro UI ──subscribeSession()──▶ snapshot + live event stream ◀───┘
```

The **host** is spawned `detached` so it survives orchestrator/Maestro restarts. It owns the streaming `query()` session, normalizes every SDK message into the model-agnostic schema below, appends each event to an on-disk NDJSON log (durable history + resume), and broadcasts events to any connected subscribers. The plugin (`index.ts`) is the client side; it implements the ao `Runtime` interface.

`getAttachInfo` is intentionally **omitted** — there is no terminal to attach a human to. UIs subscribe to the live event stream instead.

## Normalized event schema (the provider seam)

Model-agnostic NDJSON — one JSON object per line, on disk and on the wire. `runtime-sdk` _translates_ Agent-SDK messages into this; a future adapter for another provider (an OpenAI-compatible / Codex / other driver) emits the **same** events so the UI renders them unchanged. See `src/event-schema.ts` (types) and `src/sdk-translator.ts` (the Claude adapter — the only file that knows Agent-SDK field names).

**Common envelope** (every event):

| field | type | meaning |
|-------|------|---------|
| `v` | number | schema version (`1`) |
| `seq` | number | monotonic per-session sequence, from `0`, `+1` per event |
| `ts` | string | ISO-8601 UTC emit time |
| `session_id` | string \| null | provider session id; `null` until `session/init` (deferred to first turn) |
| `turn` | number | 1-based user-turn index; `0` for pre-first-turn lifecycle events |
| `type` | string | discriminator (below) |

**Core event types**

| `type` | extra fields |
|--------|--------------|
| `text-delta` | `block:number`, `text:string` — streaming assistant answer |
| `reasoning` | `block:number`, `text:string` — streaming thinking |
| `tool_use` | `block:number`, `id:string`, `name:string`, `input:object` |
| `tool_result` | `tool_use_id:string`, `is_error:boolean`, `content:string` |
| `result` | `subtype:string`, `is_error:boolean`, `text:string`, `num_turns:number`, `duration_ms:number` |
| `usage` | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `total_cost_usd`, `model` |
| `permission_request` | `request_id:string`, `tool_name:string`, `input:object`, `suggestions?:array` |

**Lifecycle / control types** (model-agnostic, beyond the 7 core):

| `type` | extra fields |
|--------|--------------|
| `session` | `subtype:"init"\|"resumed"\|"end"`, `session_id:string`, `model?`, `cwd?`, `permission_mode?`, `tools?:string[]` |
| `permission_resolved` | `request_id:string`, `behavior:"allow"\|"deny"`, `message?` |
| `error` | `message:string`, `fatal:boolean` |

`block` is the content-block index within the current assistant message (groups consecutive `text-delta` / `reasoning` into one bubble). Note: in streaming-input mode the SDK emits one `session/init` per turn — `session_id` is stable, so consumers may treat repeats as turn boundaries.

## Paths (per session)

```
base = <AO_SDK_HOME>/<aoSessionId>/
  AO_SDK_HOME = $AO_SDK_HOME || ($AO_HOME || ~/.agent-orchestrator)/runtime-sdk
  aoSessionId = ao RuntimeCreateConfig.sessionId  (validated /^[A-Za-z0-9_-]+$/)
```

| file | purpose |
|------|---------|
| `<base>/events.ndjson` | append-only event log (full history incl. resumes) |
| `<base>/session.json` | `{ aoSessionId, sdkSessionId, model, hostPid, startedAt, resumedFrom }` |
| `<base>/host.sock` (POSIX) · `\\.\pipe\ao-sdk-<aoSessionId>` (Windows) | live event socket |

Paths key off the **ao session id** (known at `create()`), not the provider `session_id` (unknown until the first turn produces `init`). The SDK's own resume transcript lives separately at `~/.claude/projects/<encoded-cwd>/<sdkSessionId>.jsonl`; resume passes `options.resume = sdkSessionId`.

## Subscription protocol

Line-delimited JSON (NDJSON) over the socket / pipe, UTF-8, `\n`-terminated, bidirectional. On connect the host pushes, in order:

1. `{ type:"hello", role:"host", session_id, seq_head }`
2. replay of every buffered event so far (one line each) — the **snapshot** (incl. the in-progress turn, so late subscribers miss nothing)
3. `{ type:"snapshot-complete", seq }` — everything after is **live**
4. live events forever

Client → host control lines (a pure subscriber sends none):

| line | effect |
|------|--------|
| `{ cmd:"send", text }` | push a user turn into the streaming input |
| `{ cmd:"status" }` | → `{ type:"status", alive, session_id, seq, turns }` |
| `{ cmd:"output", lines }` | → `{ type:"output", text }` (rendered tail) |
| `{ cmd:"permission", request_id, behavior, message? }` | answer a `permission_request` |
| `{ cmd:"kill" }` | graceful host shutdown |

`src/sdk-client.ts` provides `subscribeSession()`, `hostSend()`, `hostStatus()`, `hostGetOutput()`, `hostResolvePermission()`, `hostKill()`.

## Permissions

Managed/autonomous sessions default to **`bypassPermissions`** (equivalent to today's `--dangerously-skip-permissions`) — no prompts, no `canUseTool`. Any non-bypass mode wires `canUseTool`: it emits a `permission_request` event and awaits an answer delivered over the socket (`{ cmd:"permission", ... }`), emitting `permission_resolved` once decided. With `AO_SDK_PERMISSION_TIMEOUT_MS > 0` an unanswered request defaults to deny. The UI side lands in M3.

## Configuration (host env)

| env | default | meaning |
|-----|---------|---------|
| `AO_SDK_PERMISSION_MODE` | `bypassPermissions` | `default` / `acceptEdits` / `bypassPermissions` / `dontAsk` / `plan` / `auto` |
| `AO_SDK_INITIAL_PROMPT` | — | optional first user turn pushed at start |
| `AO_SDK_RESUME` | — | provider `session_id` to resume |
| `AO_SDK_MODEL` | — | model id override |
| `AO_SDK_CWD` | workspace path | working dir for the session |
| `AO_SDK_HOME` / `AO_HOME` | `~/.agent-orchestrator` | state root |
| `AO_SDK_PERMISSION_TIMEOUT_MS` | `0` (wait) | deny timeout for unanswered approvals |
| `AO_SDK_HOST_SCRIPT` | bundled `dist/sdk-host.js` | override host script path (tests/dev) |

## Demo & tests

```bash
pnpm --filter @aoagents/ao-plugin-runtime-sdk build
node packages/plugins/runtime-sdk/demo/demo.mjs          # real 2-turn session + resume by id

pnpm --filter @aoagents/ao-plugin-runtime-sdk test       # unit tests (SDK mocked)
AO_SDK_INTEGRATION=1 pnpm --filter @aoagents/ao-plugin-runtime-sdk test   # + live smoke (needs Claude login)
```
