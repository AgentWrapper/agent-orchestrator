# PostHog Cost Controls

This page is the runbook for cutting AO PostHog spend while preserving active
usage and reliability observability.

## Current finding

Read-only HogQL on 2026-07-29 against PostHog project `475752` found
5,598,610 events in the trailing 30 days and 2,435,110 events in the trailing
7 days. The volume is concentrated in legacy CLI telemetry:

| Window | `ao.cli.invoked` | `ao.app.active` | `ao.renderer.route_viewed` |
| --- | ---: | ---: | ---: |
| 30 days | 2,667,927 | 2,553,297 | 150,586 |
| 7 days | 1,167,224 | 1,151,190 | 45,710 |

In the trailing 7-day window, legacy `ao hooks` alone produced 962,837
`ao.cli.invoked` events and 947,731 CLI-channel `ao.app.active` events. Those
events had `actor_type = null` and no `$process_person_profile = false`, which
identifies them as old uncapped clients. Current builds emit bounded, anonymous
telemetry, but old installs cannot be forced to upgrade.

Current code emits v2 PostHog event names for streams with noisy legacy
producers:

| Internal/local event | PostHog event |
| --- | --- |
| `ao.app.active` | `ao.v2.app.active` |
| `ao.cli.invoked` | `ao.v2.cli.invoked` |
| `ao.renderer.route_viewed` | `ao.v2.renderer.route_viewed` |
| `ao.renderer.loaded` | `ao.v2.renderer.loaded` |
| `ao.renderer.api_error` | `ao.v2.renderer.api_error` |
| `ao.renderer.daemon_failure` | `ao.v2.renderer.daemon_failure` |

The original event name is retained as `legacy_event_name` when the daemon
renames an event during PostHog export. All current daemon and renderer events
include `telemetry_schema_version = 2`.

## Ingestion Rules

Configure PostHog ingestion controls for project `475752` in this order.

1. Keep all `ao.v2.*` events.
2. Drop legacy CLI firehose events where `event = 'ao.cli.invoked'` and
   `actor_type` is missing or null.
3. Drop legacy active-user firehose events where `event = 'ao.app.active'`,
   `channel = 'cli'`, `actor_type` is missing or null, and `command_path` is in:
   - `ao hooks`
   - `ao session ls`
   - `ao session get`
   - `ao orchestrator ls`
   - `ao status`
   - `ao project ls`
   - `ao project get`
   - `ao pty-host`
4. Keep legacy `ao.app.active` where `channel = 'renderer'` so old desktop-only
   installs still contribute to DAU until they update.
5. Keep low-volume reliability events such as `ao.session.spawned`,
   `ao.session.spawn_failed`, `ao.session.waiting_input_entered`,
   `ao.session.waiting_input_exited`, `ao.http.5xx`, and `ao.daemon.panic`.
6. Drop `$web_vitals` unless a time-boxed performance investigation needs it.

The 7-day estimate from these rules is a reduction from roughly 2.4M total
events to well under 250k, before organic adoption of current builds. That is a
10x+ reduction while keeping renderer DAU, current v2 CLI DAU, current v2
command adoption, and reliability events.

## Follow-up: Failure-only Internal CLI Telemetry

Successful background polling commands are not useful enough to justify
billable PostHog volume. Do not track routine successful executions for
internal/read-only commands such as:

- `ao status`
- `ao session ls`
- `ao session get`
- `ao project ls`
- `ao project get`
- `ao orchestrator ls`
- `ao hooks`
- `ao pty-host`

Keep meaningful failures, because they are reliability signal. A future
failure-only event should use a separate v2 name such as `ao.v2.cli.failed`
instead of reusing `ao.v2.cli.invoked`.

Safe properties:

- `command_path`, for example `ao session ls`
- `actor_type`, for example `renderer`, `user`, `agent`, or `system`
- `error_category`, for example `daemon_unavailable`, `timeout`, or
  `backend_5xx`
- `error_code`, when it is a stable code such as `CONNECTION_REFUSED`
- `app_version` / `ao_version`
- `telemetry_schema_version`

Do not send raw error messages, stack traces, local paths, project names,
repository URLs, prompts, terminal output, access tokens, request payloads, or
other user content.

Do not treat expected outcomes as serious telemetry failures: user-cancelled
operations, dialogs closed by the user, already-removed projects, transient
polling failures while AO is starting, intentionally deleted resources, and
commands that succeed after automatic retry.

Repeated failures from polling should be deduplicated. Emit the same
`ao.v2.cli.failed` shape at most once per install and time window, then include
`occurrence_count`, `window_start`, and `window_end` so 48 identical failures
cost one event while still showing the true magnitude.

The rule of thumb is: drop successful background polling events, but preserve
meaningful user-impacting failures as safe, rate-limited error telemetry.

## Abuse Controls

The PostHog project token is public in shipped desktop apps. Treat it like a
write-only routing key, not as an abuse boundary: an attacker can call
PostHog's capture endpoint directly with that token and bypass every
client-side or daemon-side limiter in AO.

Use layered controls:

1. Set PostHog billing limits for Product Analytics, Error Tracking, and
   Session Replay. This is the hard stop that prevents a surprise bill if a
   token is abused or a new event loops unexpectedly.
2. Keep the ingestion drop rules above enabled. They block the known legacy
   firehose before events are stored or billed.
3. Add a PostHog transformation for emergency abuse filtering. The
   transformation should return `null` for obviously invalid payloads, unknown
   event families, or event names outside AO's allowlist. Dropped events are
   unrecoverable, so do not use this for normal sampling of DAU events.
4. Keep current-client caps in AO:
   - renderer captures are bounded per event name per minute and per day
   - daemon remote exports are bounded per event name per minute and per day
   - burst-prone daemon failures are aggregated before export

Those steps protect cost from normal bugs and known old clients, but they do
not fully protect a public project token from deliberate abuse.

The stronger standard pattern is to send telemetry through an AO-owned
collection proxy instead of sending directly to PostHog:

1. Ship future apps with `VITE_AO_POSTHOG_HOST` and
   `AO_TELEMETRY_POSTHOG_HOST` pointing at an AO telemetry collector, not
   directly at `https://us.i.posthog.com`.
2. Put edge rate limits in front of the collector:
   - per source IP
   - per install ID / `distinct_id`
   - per event name
   - per request body size
3. Validate the event allowlist and required properties at the collector.
4. Drop or sample low-value diagnostic events at the collector before they
   reach PostHog.
5. Forward accepted events to PostHog with the real project token stored only
   in collector configuration.
6. Rotate the PostHog project token after the collector path is live. Keep
   old-token ingestion rules restrictive so old apps can still contribute
   renderer DAU where needed, but cannot burn spend through CLI automation.

Do not rely on IP limiting alone. Many real users can share one NAT or VPN IP,
and one attacker can rotate IPs. IP limits are useful as an edge backstop, but
the primary product-specific limits should be per install ID, per event name,
and per time window.

## Dashboard Migration

For current DAU, use this active-user event set:

```sql
SELECT
    toDate(timestamp) AS day,
    uniqExact(distinct_id) AS active_installs
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
  AND (
    event = 'ao.v2.app.active'
    OR (event = 'ao.app.active' AND properties.channel = 'renderer')
    OR (
      event = 'ao.app.active'
      AND properties.channel = 'cli'
      AND properties.actor_type = 'user'
    )
  )
GROUP BY day
ORDER BY day
```

For historical DAU before v2 rollout, keep existing `ao.app.active` charts but
filter out legacy CLI automation:

```sql
SELECT
    toDate(timestamp) AS day,
    uniqExact(distinct_id) AS active_installs
FROM events
WHERE timestamp >= now() - INTERVAL 90 DAY
  AND event = 'ao.app.active'
  AND NOT (
    properties.channel = 'cli'
    AND (properties.actor_type IS NULL OR properties.actor_type = '')
    AND properties.command_path IN (
      'ao hooks',
      'ao session ls',
      'ao session get',
      'ao orchestrator ls',
      'ao status',
      'ao project ls',
      'ao project get',
      'ao pty-host'
    )
  )
GROUP BY day
ORDER BY day
```

For current command adoption, use `ao.v2.cli.invoked` and group by
`command_path` and `actor_type`. Do not use raw legacy `ao.cli.invoked` for
current dashboards after ingestion filtering is enabled.

For current renderer surface usage, use `ao.v2.renderer.route_viewed`.

For API/UI reliability, union the v2 renderer names with the low-volume daemon
reliability events:

```sql
SELECT event, count() AS events, uniqExact(distinct_id) AS installs
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND event IN (
    'ao.v2.renderer.api_error',
    'ao.v2.renderer.daemon_failure',
    '$exception',
    'ao.session.spawn_failed',
    'ao.http.5xx',
    'ao.daemon.panic'
  )
GROUP BY event
ORDER BY events DESC
```

## Verification Queries

After enabling ingestion rules, this query should show legacy CLI volume
falling quickly while v2 volume remains:

```sql
SELECT event, properties.actor_type, properties.channel, count() AS events
FROM events
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND event IN (
    'ao.cli.invoked',
    'ao.app.active',
    'ao.v2.cli.invoked',
    'ao.v2.app.active'
  )
GROUP BY event, properties.actor_type, properties.channel
ORDER BY events DESC
```

If `ao.cli.invoked` with `actor_type = null` remains above a few hundred events
per day after the rules are enabled, the drop rule is not broad enough.
