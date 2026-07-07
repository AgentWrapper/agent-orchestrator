# Agent health/auth monitor (GH #91) — implementation plan

**Goal:** ao continuously verifies every configured agent/harness is functional
(installed + authenticated) and @mentions Nick immediately when one breaks
(login expiring / auth failure), plus a recovery notice. Surface per-harness
health in `ao doctor`, a status endpoint, and the UI.

## Architecture decision — why NOT the notifications table

The `notifications` table (`0011_notifications.sql`) is hard-scoped:
`session_id`/`project_id` are `NOT NULL REFERENCES …` and `type` is a closed
CHECK. Agent health is **global**, not tied to a session or PR, so routing it
through that table means making the FKs nullable + widening the CHECK + a new
dedupe key — invasive surgery on a session-notification model that upstream
would reject. Instead we use the split the issue points at:

- **Backend (upstream-shaped, small):** a periodic health monitor + a read-only
  `GET /api/v1/agents/health` endpoint. Detection + state live here.
- **Ops notifier (OURS):** `ao-slack-notifier` polls the health endpoint and
  @mentions Nick on transition — reusing the existing `alertUnhealthy`
  @mention precedent already in `ops/ao-slack-notifier.mjs` for daemon health.
- **UI (OURS):** a per-harness health indicator in Settings.

Documented as a follow-up option: if we later want the dashboard bell +
durability, widen the notifications model then.

## Phases

- **P1 — Backend monitor + endpoint (core).**
  - `backend/internal/service/agenthealth`: `Monitor` with per-harness health
    state, transition tracking, `Check(ctx)` one-cycle, `Snapshot()`. States:
    healthy / unauthorized / missing / unknown, each with reason + remedy.
    Injected `Prober` + `HarnessLister` + clock. Logs transitions
    (WARN unhealthy / INFO recovery). TDD.
  - `service/agent`: add `HarnessHealth(ctx, ids)` reusing `probeAgent`. TDD.
  - `GET /api/v1/agents/health` controller + route + apispec. TDD.
  - `config`: `AO_AGENT_HEALTH_INTERVAL` (default 5m; 0 disables).
  - Daemon wiring (`daemon/agent_health_wiring.go`) via `observe.StartPollLoop`;
    `HarnessLister` = default AO_AGENT ∪ per-project harnesses (recomputed each
    tick), fallback to core three. **Sensitive path → autonomous merge PARKS.**
  - Async, bounded, never blocks readiness.
- **P2 — `ao doctor` per-harness health.** Surface auth per harness (query the
  daemon health endpoint when up; else PATH-only as today).
- **P3 — Ops Slack alert (the @mention).** Extend `ao-slack-notifier` (or
  sibling) to poll `/agents/health`, persist last-alerted health per harness,
  @mention on transition to unhealthy (agent + reason + remedy) and on recovery.
  Restart-safe: dedup on health-value change, not timestamps. Alert only on
  {unauthorized, missing}; ignore unknown. TDD (node test file pattern).
- **P4 — UI indicator (ours).** Settings agent-health panel consuming the
  endpoint: per harness healthy / unauthorized / missing + reason + remedy.
- **P5 — Verify end-to-end.** Force a codex auth failure → alert; restore →
  recovery. Docs.

## Acceptance criteria mapping

1. Periodic check, interval configurable → P1.
2. Transition→unhealthy immediate deduped @mention (agent+reason+remedy) +
   recovery → P3 (backend detects P1; endpoint reflects instantly; notifier
   poll near-immediate).
3. `ao doctor` / status endpoint + UI → P1 endpoint + P2 doctor + P4 UI.
4. Verified codex fail→alert, restore→recovery → P5.
5. Non-blocking async bounded probe → P1 (StartPollLoop
   first-poll-in-goroutine; per-probe timeouts already 2s/10s).
