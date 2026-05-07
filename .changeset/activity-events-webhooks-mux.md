---
"@aoagents/ao-core": minor
"@aoagents/ao-web": minor
---

Wire activity events into webhook ingress and the mux WebSocket terminal server (sub-issue of #1511, follows #1620).

- `api.webhook_unverified` (warn) — signature verification failed; data includes `slug`, `remoteAddr`, `candidateCount` (never the failed signature)
- `api.webhook_rejected` (warn) — payload exceeded `maxBodyBytes`; data includes counts and `maxBodyBytes` (never the body)
- `api.webhook_received` (info|warn) — accepted webhook; data includes `projectIds`, `matchedSessions`, `parseErrorCount`, `lifecycleErrorCount` (never the body)
- `api.webhook_failed` (error) — outer pipeline crash with `errorMessage`
- `ui.terminal_connected` / `ui.terminal_disconnected` — one event per mux WS connection lifecycle
- `ui.terminal_heartbeat_lost` (warn) — fires once on 3 missed pongs (was console-only)
- `ui.terminal_pty_lost` (warn) — fires when PTY exits with subscribers attached (distinguishes "PTY died" from "user closed browser")
- `ui.terminal_protocol_error` (warn) — invalid mux client message
- `ui.session_broadcast_failed` (warn) — emitted on the healthy→failing transition only (re-arms after a successful poll), so a long outage produces one event, not 20/min

`api.webhook_unverified` is the security-audit event; treat 401s on webhooks as a signal worth retaining for the full 7-day window.
