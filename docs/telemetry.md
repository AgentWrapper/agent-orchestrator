# Telemetry

AO uses anonymous telemetry to understand reliability and product usage. The
Electron renderer sends sanitized PostHog events directly, and the Go daemon can
persist allowlisted events locally and fan them out to PostHog when remote
telemetry is enabled.

## What is collected

- App activation events: `ao.app.active` from the renderer and user-context
  CLI, each capped at once per UTC day per install
- Renderer load and daily route-surface usage, grouped by coarse surface names
- Project/task/session UI actions, with project identifiers SHA-256 hashed
- Renderer exceptions, reduced to error name and coarse context
- Daemon operational events: CLI invocation, session spawn/failure, waiting-input
  transitions, HTTP 5xx, and daemon panics
- AO version context (`app_version` / `ao_version`), platform, and build mode

PostHog session recording is enabled for the renderer. Network request names are
masked before recording.

## Privacy

Before any renderer event or recording is transmitted:

- Absolute file paths (`/home/...`, `/Users/...`, `C:\...`) are replaced with
  `[redacted-local-path]`
- Local URLs (`file://`, `app://renderer`, `localhost`, `127.0.0.1`, `[::1]`)
  are replaced with `[redacted-local-url]`
- Project IDs are one-way hashed and never sent in plain text

Daemon events use a remote payload allowlist before PostHog export. Project and
session IDs are hashed, and raw location/IP fields are not accepted from AO
payloads. Geographic reporting should use PostHog's GeoIP enrichment only.

Three burst-prone daemon events — `ao.http.5xx`, `ao.daemon.panic`,
`ao.cli.usage_errors` — are aggregated before export: every occurrence in a
rolling one-minute window is folded into a single rollup event carrying
`count`, `window_start`, and `window_end`, instead of exporting one PostHog
event per occurrence. A storm of 10,000 errors and one of 6 both cost the same
one event, and the true magnitude is still visible via `count` rather than
being silently capped away. Only the most recent occurrence's other
properties (path, fingerprint, etc.) are kept on the rollup — if a burst hits
several different endpoints or fingerprints in the same window, the ones
overwritten by later occurrences aren't visible on that rollup. Local SQLite
storage is unaffected: it receives every raw occurrence, unaggregated, for
full-fidelity debugging regardless of what PostHog sees.

Everything reaching PostHog remotely is still bounded per event name: a
5-per-minute burst cap plus a 200-per-day hard ceiling for ordinary events,
or a 1,500-per-day ceiling for the three aggregated names above (since their
per-occurrence cost is already collapsed by aggregation, the daily cap there
is a structural backstop rather than the primary limit). The renderer applies
the same 5-per-minute / 200-per-day shape to its own event and exception
capture path, without the aggregation step.

All events are sent as PostHog anonymous events (`$process_person_profile:
false`; the renderer never calls `identify()`). The install ID still
deduplicates unique-user counts, but no person profiles are created — person
properties and person-property cohorts are intentionally unavailable.

`ao.cli.invoked` is capped at once per command path per UTC day per install, so
script- or agent-driven polling (`ao status`, `ao session ls`, `ao hooks`
firing on every agent hook event, ...) reports as "this install used this
command today" rather than one event per call. Commands that never reflect
product activity — the supervisor-driven `ao daemon`/`ao start`, the
self-documenting `ao completion`/`ao help`, and the internal Windows
`ao pty-host` runtime host — are excluded outright.

CLI invocations are classified by actor:

- `actor_type=user`: a user-context CLI command. These can refresh CLI-channel
  `ao.app.active`.
- `actor_type=agent`: `ao hooks` and commands run inside an AO-managed agent
  session (`AO_SESSION_ID` is set). These are useful agent-activity signal but
  do not refresh `ao.app.active`, because agents can keep running after the
  human has stopped actively using AO.
- `actor_type=system`: supervisor/runtime background processes. These are not
  sent as CLI usage.

The per-command daily cap keeps invocation frequency off PostHog, and the CLI
reservation state is persisted under the AO data dir so a daemon restart does
not re-emit every polling command for the same day.

`ao.renderer.route_viewed` is capped at once per coarse surface per UTC day per
renderer install. This preserves surface adoption and retention signal while
dropping repeated navigation churn inside the same surface.

## Product Metrics Model

AO currently has a stable install ID, not a signed-in account user ID. That
means today's DAU/MAU can accurately represent active installs, but not unique
people across multiple machines. True user-level new/churn/journey metrics
require an explicit stable user identity from a login, license, or workspace
account system. That identity should be sent as a first-party AO user ID (or a
one-way hash of it) only when the user has authenticated or explicitly enabled
account-level telemetry; it should not be inferred from machine fingerprints,
paths, git remotes, emails in repo config, or other local data.

The minimum signals for accurate usage analytics are:

- `ao.app.active`: one event per UTC day per install/account when a human uses
  the desktop app or runs a user-context CLI command. This powers DAU, WAU, MAU,
  retention, and churn.
- `ao.projects.created` and `ao.onboarding.first_project_added`: activation
  funnel from install to first project.
- `ao.session.spawned`, `ao.session.spawn_failed`, and
  `ao.onboarding.first_session_spawned`: activation funnel from project to
  first running agent, plus spawn reliability.
- `ao.cli.invoked` with `actor_type=user|agent`: command adoption by actor,
  capped by command/install/day. Agent-context command usage is product signal,
  but should be analyzed separately from active-user counts.
- `ao.session.waiting_input_entered/exited`: whether agents are making progress
  or waiting on the human, with dwell time.
- Renderer and daemon error/crash events: reliability and support signal.

Signals that should not drive active-user metrics:

- Internal runtime hosts such as `ao pty-host`.
- Supervisor startup/control commands such as `ao daemon` and `ao start`.
- Agent hook callbacks and other CLI commands run with `AO_SESSION_ID`, except
  as separate agent-activity or command-adoption metrics.
- Raw polling frequency for read-only state commands.

## Volume Investigation: 2026-07-21

Read-only HogQL queries against PostHog project `475752` over the trailing
30-day window found 3,203,364 total events. The dominant event names were:

| Event                              |     Count | Installs | Events/install |
| ---------------------------------- | --------: | -------: | -------------: |
| `ao.cli.invoked`                   | 1,508,888 |      870 |       1,734.35 |
| `ao.app.active`                    | 1,411,807 |    1,434 |         984.52 |
| `ao.renderer.route_viewed`         |   114,940 |    1,388 |          82.81 |
| `ao.renderer.api_error`            |    18,634 |      662 |          28.15 |
| `ao.session.waiting_input_entered` |    17,583 |      377 |          46.64 |
| `$exception`                       |    16,563 |      681 |          24.32 |
| `ao.cli.usage_errors`              |    15,349 |      215 |          71.39 |
| `ao.session.waiting_input_exited`  |    15,343 |      339 |          45.26 |
| `$set`                             |    13,211 |    1,137 |          11.62 |
| `ao.session.spawned`               |    11,439 |      887 |          12.90 |

The top two events were almost entirely CLI-sourced and moved together:
`ao.cli.invoked` had 1,508,888 events and CLI-channel `ao.app.active` had
1,403,170 events. The largest command paths were polling/hook paths:

| Command path         | `ao.cli.invoked` count | Install-days | Projected events saved by persistent daily cap |
| -------------------- | ---------------------: | -----------: | ---------------------------------------------: |
| `ao hooks`           |                589,338 |        1,624 |                                        587,714 |
| `ao session ls`      |                270,977 |          764 |                                        270,213 |
| `ao orchestrator ls` |                236,877 |          177 |                                        236,700 |
| `ao status`          |                220,436 |          524 |                                        219,912 |
| `ao session get`     |                 75,946 |          603 |                                         75,343 |
| `ao project ls`      |                 40,435 |          462 |                                         39,973 |
| `ao project get`     |                 31,048 |          356 |                                         30,692 |
| `ao send`            |                 19,104 |          536 |                                         18,568 |

Using `ao.session.spawned` as the AO-session denominator, the 30-day window had
11,439 spawned sessions, 131.91 `ao.cli.invoked` events per spawned session,
and 10.05 `ao.renderer.route_viewed` events per spawned session. Looking only
at renderer/PostHog browser sessions, there were 211,532 renderer SDK events
across 6,988 PostHog sessions, or 30.27 events per PostHog session. Route
views were the largest renderer contributor at 17.67 events per PostHog
session.

Projected 30-day reduction from the implemented changes, using the observed
install-day cardinalities:

- Persisting the CLI command daily cap: `ao.cli.invoked` drops from 1,508,888
  to about 8,416 events, saving about 1,500,472 events.
- Persisting the CLI active daily cap: CLI-channel `ao.app.active` drops from
  1,403,170 to about 1,877 events, saving about 1,401,293 events.
- Daily renderer route-surface capping: `ao.renderer.route_viewed` drops from
  114,940 to about 8,483 events, saving about 106,457 events.

Total projected event-volume savings from those three changes are roughly
3.0M events per trailing 30 days before adoption effects.

Anonymous-vs-identified check: all events had a `person_id` in HogQL, but the
event-level profile-processing property showed renderer exceptions as the
remaining identified-risk path: 16,534 of 16,563 `$exception` events carried
`$process_person_profile=true`, while only 29 carried `false`. Renderer
captures now force `$process_person_profile=false` on the event properties, and
Web Vitals capture is disabled because the 7,017 `$web_vitals` events in the
window were diagnostic noise rather than activation, feature usage, or
crash/error signal.

## Install ID

On first run, a random install identifier is generated and stored at
`~/.ao/data/telemetry_install_id` (or `$AO_DATA_DIR/telemetry_install_id`). The
renderer and daemon both use this ID as the PostHog distinct ID so activity is
deduplicated across app launches and CLI invocations. It is not linked to any
personal account.

## Configuration

Renderer PostHog key and host are baked in at build time. To point a build at
another PostHog project, set these environment variables before building:

```bash
VITE_AO_POSTHOG_KEY=phc_yourkey
VITE_AO_POSTHOG_HOST=https://your-posthog-host.com
```

Daemon event capture is off by default when the daemon is launched directly. The
Electron supervisor starts the daemon with these defaults unless the environment
already provides explicit values:

```bash
AO_TELEMETRY_EVENTS=on
AO_TELEMETRY_REMOTE=posthog
AO_TELEMETRY_POSTHOG_KEY=phc_yourkey
AO_TELEMETRY_POSTHOG_HOST=https://us.i.posthog.com
```

Local daemon telemetry is retained in SQLite for 30 days.

## PostHog Retention And Geography Dashboard

Use `ao.app.active` as the active-user event for DAU, weekly retention, and
country-level active-user maps. AO emits it from:

- `channel=renderer` when the desktop app initializes and at most once per UTC
  day while the app stays open
- `channel=cli` when the CLI reports a user-typed command invocation to the
  local daemon, at most once per UTC day per daemon

Recommended PostHog setup:

1. Enable PostHog GeoIP enrichment for the project.
2. Create an "AO Active Users" dashboard.
3. Add a Trends insight:
   - Event: `ao.app.active`
   - Aggregation: unique users
   - Chart type: world map
   - Breakdown: GeoIP country code, for example `$geoip_country_code`
4. Add a Retention insight:
   - Start event: `ao.app.active`
   - Return event: `ao.app.active`
   - Interval: weekly
   - Range: last 12 weeks
5. Add optional filters or breakdowns for `channel=renderer` and `channel=cli`
   when comparing desktop app and CLI activity.

PostHog references:

- GeoIP enrichment: https://posthog.com/docs/cdp/geoip-enrichment
- Trends insights: https://posthog.com/docs/product-analytics/trends
- Retention insights: https://posthog.com/docs/product-analytics/retention
