# Observability Signals

This document describes runtime observability emitted by Agent Orchestrator.

## Goals

- Structured, low-noise telemetry for session lifecycle and operator workflows.
- Correlated traces across core services, API routes, SSE, and websocket terminal health.
- Clear failure reasons and current health surfaces for fast diagnosis.

## Emission Model

- **Structured logs**: JSON lines on stderr, controlled by `AO_LOG_LEVEL`.
  - Supported levels: `debug`, `info`, `warn`, `error`.
  - Default level: `warn` (production-safe, avoids high-volume info logs).
- **Durable snapshots**: process-local JSON snapshots under:
  - `~/.agent-orchestrator/{config-hash}-observability/processes/*.json`
- **Aggregated view**: merged by project via:
  - `GET /api/observability`

## Correlation

- API routes accept `x-correlation-id`; when absent, AO generates one.
- Responses include `x-correlation-id` for traceability from UI or CLI.
- SSE snapshots include `correlationId` and `emittedAt`.

## Metrics

Counters are emitted per project and operation:

- `spawn` (`session.spawn`)
- `restore` (`session.restore`)
- `kill` (`session.kill`)
- `claim_pr` (`session.claim_pr`)
- `cleanup` (`session.cleanup`)
- `send` (`session.send`)
- `lifecycle_poll` (`lifecycle.poll`, `lifecycle.transition`)
- `lifecycle_poll` (`lifecycle.merge_cleanup.completed`) — auto-cleanup ran after a PR was detected as merged; session runtime + worktree + metadata were torn down
- `lifecycle_poll` (`lifecycle.merge_cleanup.deferred`) — auto-cleanup is waiting for the agent to idle (or for the `mergeCleanupIdleGraceMs` window to elapse) before tearing down
- `lifecycle_poll` (`lifecycle.merge_cleanup.failed`) — auto-cleanup threw during `sessionManager.kill()`; the session stays in `merged` so the next poll retries
- `api_request` (web API routes)
- `sse_connect`, `sse_snapshot`, `sse_disconnect`
- `websocket_connect`, `websocket_disconnect`, `websocket_error` (websocket servers)

Each metric counter tracks:

- `total`, `success`, `failure`
- `lastAt`, `lastSuccessAt`, `lastFailureAt`
- `lastFailureReason`

## Trace Fields

Recent traces keep operation-level diagnostics:

- `id`
- `timestamp`
- `component`
- `operation`
- `outcome`
- `correlationId`
- `projectId`
- `sessionId`
- `path`
- `reason`
- `durationMs`
- `data`

## Health Surfaces

Health records provide current status and failure context per surface:

- `surface` (for example: `lifecycle.worker`, `sse.events`)
- `status` (`ok`, `warn`, `error`)
- `updatedAt`
- `component`
- `projectId`
- `correlationId`
- `reason`
- `details`

## Operator-Facing Diagnostics

- **Dashboard**: use **Copy debug info** in the hero toolbar (desktop) to copy `/api/observability` plus page URL, project scope, and correlation id to the clipboard for issue reports. The observability banner shows overall status, SSE stream state, last correlation id, and latest failure reason.
- **API**: `/api/observability` returns merged per-project diagnostics (`overallStatus`, metrics, health, recent traces, session state).
- **Terminal websocket health**: `/health` endpoints include active sessions and websocket/terminal health counters with last error/disconnect reasons.

## Rollout Notes

1. Deploy with default `AO_LOG_LEVEL=warn` to avoid noisy logs.
2. Validate `/api/observability` and dashboard banner in a canary environment.
3. If deeper triage is needed, temporarily raise `AO_LOG_LEVEL=info` (or `debug`), then revert to `warn`.
4. Monitor `lastFailureReason` and surface-level `reason` fields before enabling broader rollout.
