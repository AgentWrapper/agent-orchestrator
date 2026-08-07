# Telemetry

AO uses anonymous telemetry to understand reliability and product usage. The
Electron renderer sends sanitized PostHog events directly, and the Go daemon can
persist allowlisted events locally and fan them out to PostHog when remote
telemetry is enabled.

For cost-control runbooks, including the v2 PostHog event namespace and legacy
ingestion drop rules, see [posthog-cost-controls.md](posthog-cost-controls.md).

## What is collected

- App activation events: `ao.app.active` / `ao.v2.app.active` from the
  renderer and meaningful user-context CLI commands, each capped to one event
  per six-hour UTC slot, or four per day per install/channel
- Renderer load and daily route-surface usage, grouped by coarse surface names
- Project/task/session UI actions, with project identifiers SHA-256 hashed
- Renderer exceptions, reduced to error name and coarse context
- Daemon operational events: CLI invocation, session spawn/failure, waiting-input
  transitions, HTTP 5xx, and daemon panics
- Code review outcomes: `ao.review.triggered`, `ao.review.submitted`,
  `ao.review.cancelled`, and `ao.review.trigger_failed`. These carry the reviewer
  `harness`, the `verdict` (`approved` / `changes_requested`), how long the pass
  took, whether the review reached the provider, and a coarse `error_kind` on
  failure. The review body is never sent: it is reviewer prose about a user's
  source code. The PR URL and target SHA are also withheld, because both identify
  the repository. `ao.review.submitted` fires only on the real running-to-complete
  transition, so a reviewer retrying a submit cannot double-count a verdict
- Desktop update outcomes: `ao.renderer.update_failed`,
  `ao.renderer.update_downloaded`, and `ao.renderer.update_unsupported`. These
  carry a coarse `error_category`, the `phase` (`check` or `download`), whether
  the operation was `automatic` or `manual`, and the target version. The
  updater's raw error message is never sent, because it can contain feed URLs
  and local staging paths; it is bucketed into a category first. Progress is not
  reported, since it fires per percent tick and the UI already shows it.

  These are decided in the **main process**, at the updater's operation
  boundary, and pushed to the renderer on a channel separate from
  `updates:status`. That separation matters: `auto-updater.ts` deliberately
  suppresses the UI status when an *automatic* check fails, and automatic checks
  run hourly. A renderer observer watching statuses would therefore miss the
  silent-failure case these exist to diagnose. Owning it in main also makes
  `phase` and `to_version` authoritative, since only main knows which operation
  was running and what it was fetching
- Agent inventory: `ao.renderer.agents_available`, reported once per app launch
  with `installed_count`, `authorized_count`, `supported_count`, and a sorted list
  of authorized agent ids. Agent ids are a fixed vocabulary from AO's own
  registry, never user input. This exists because `ao.session.spawned` only shows
  which harness *ran*, so an install with six authorized agents that always picks
  one was indistinguishable from an install that only had that one
- AO version context (`app_version` / `ao_version`), platform, and build mode
- Mobile app product events (`client = "mobile"` / `"mobile-web"`), all under the
  `ao.v2.*` namespace and carrying `telemetry_schema_version = 2`:
  `ao.v2.app.active` (once per UTC day), `ao.v2.mobile_app.paired`
  (`method`, `from_onboarding`), `ao.v2.mobile_app.connected` (`trigger`,
  emitted only on the not-open-to-open transition, never per poll tick),
  `ao.v2.mobile_app.onboarding_started` / `_completed` / `_skipped`,
  `ao.v2.mobile_app.notification_opened` (`target`, `cold_start`), and
  `ao.v2.mobile_app.feature_used` (`feature`, `outcome`). Every event carries
  `$process_person_profile: false` (anonymous rate), and the client is built with
  `personProfiles: "never"`, `enableSessionReplay: false`, and
  `captureAppLifecycleEvents: false`. There is no screen recording, no touch or
  screen autocapture, and no free-text property: the allowlist in
  `packages/mobile/lib/telemetry/events.ts` drops any unregistered key, so session
  titles, project names, terminal output, and the connection password cannot
  leave the device. Identity is posthog-react-native's persisted anonymous
  install id, device-based and never IP. Errors are out of scope here and go to
  Sentry, not PostHog. A dev client (`npm start`) constructs no client and sends
  nothing.

PostHog session recording is disabled in the client via
`disable_session_recording`, so the project-side replay toggle cannot turn it on.
Replay is billed per recording rather than per event, which puts it outside every
rate limit described below, and AO does not watch replays. If a time-boxed
investigation ever needs it, network request names are masked before recording.

Feature flags and surveys are also disabled in the client
(`advanced_disable_flags`, `disable_surveys`). AO reads no flags and ships no
surveys, and `/flags` requests are billed, so those requests were pure cost.

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
false`; the renderer never calls `identify()`). The renderer keeps PostHog SDK
persistence in memory, disables person profiles, and explicitly bootstraps the
AO install ID as anonymous. This prevents legacy PostHog state from restoring
an identified user or replacing the stable AO device ID after an upgrade. The
install ID still deduplicates unique-user counts, but no person profiles are
created — person properties and person-property cohorts are intentionally
unavailable. AO's heartbeat and route reservations continue to use their own
sanitized `localStorage` keys independently of PostHog SDK persistence.

`ao.cli.invoked` is capped at once per actor type and command path per UTC day
per install. Routine successful internal/read-only commands (`ao status`,
`ao session ls`, `ao session get`, `ao project ls`, `ao project get`,
`ao orchestrator ls`, `ao hooks`, and `ao pty-host`) are excluded outright.
Commands that never reflect product activity — the supervisor-driven
`ao daemon`/`ao start`, the self-documenting `ao completion`/`ao help`, and
the internal `ao agent-process` runtime process — are also excluded outright.

CLI invocations are classified by actor:

- `actor_type=user`: a user-context CLI command. These can refresh CLI-channel
  `ao.app.active`.
- `actor_type=agent`: commands run inside an AO-managed agent session
  (`AO_SESSION_ID` is set). These are useful command-adoption signal but do not
  refresh `ao.app.active`, because agents can keep running after the human has
  stopped actively using AO. Routine internal paths such as `ao hooks` are
  dropped on success.
- `actor_type=system`: supervisor/runtime background processes. These are not
  sent as CLI usage.

The per-command daily cap keeps invocation frequency off PostHog, and the CLI
reservation state is persisted under the AO data dir so a daemon restart does
not re-emit every polling command for the same day.

Routine successful internal/read-only commands are not reliability signal by
themselves and should not be reintroduced as success telemetry. For commands
such as `ao status`, `ao session ls`, `ao session get`, `ao project ls`,
`ao project get`, `ao orchestrator ls`, `ao hooks`, and `ao pty-host`, track
only meaningful user-impacting failures through a separate, rate-limited event
such as `ao.v2.cli.failed`. That event should carry safe enum-like fields such
as `command_path`, `actor_type`, `error_category`, and stable `error_code`; it
must not include raw error messages, stack traces, local paths, project names,
repository URLs, prompts, terminal output, tokens, or request payloads.

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

- `ao.app.active` / `ao.v2.app.active`: up to one event per six-hour UTC slot
  per install/account when a human uses the desktop app or runs a meaningful
  user-context CLI command. This powers DAU, WAU, MAU, retention, and churn
  while keeping arbitrary rolling windows from undercounting long-running
  usage. Renderer active events are sent immediately; a slot is released for
  retry when the SDK rejects or throws while capturing the event.
- `ao.projects.created` and `ao.onboarding.first_project_added`: activation
  funnel from install to first project.
- `ao.session.spawned`, `ao.session.spawn_failed`, and
  `ao.onboarding.first_session_spawned`: activation funnel from project to
  first running agent, plus spawn reliability.
- `ao.cli.invoked` / `ao.v2.cli.invoked` with `actor_type=user|agent`:
  command adoption by actor for meaningful non-internal commands, capped by
  command/install/day. Agent-context command usage is product signal, but
  should be analyzed separately from active-user counts.
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
- Persisting the CLI active six-hour slot cap: CLI-channel `ao.app.active`
  drops from 1,403,170 to at most about 7,508 events, saving at least about
  1,395,662 events.
- Daily renderer route-surface capping: `ao.renderer.route_viewed` drops from
  114,940 to about 8,483 events, saving about 106,457 events.

Total projected event-volume savings from those three changes are still roughly
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
personal account. In the renderer it is also the PostHog device ID, and the SDK
is explicitly kept in anonymous mode.

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

The supervisor also passes `AO_TELEMETRY_APP_VERSION` (the Electron app version)
so daemon events carry `app_version`/`ao_version`. The daemon binary has no
version of its own that release tooling sets, so without this every daemon event
arrives unattributable to a release and a failure rate cannot be traced to the
build that caused it.

Local daemon telemetry is retained in SQLite for 30 days.

### Kill switch

`AO_TELEMETRY_DISABLED_EVENTS` is a comma-separated list of event streams that
must never reach PostHog:

```bash
AO_TELEMETRY_DISABLED_EVENTS="ao.v2.app.active, ao.renderer.*"
```

An entry ending in `*` matches by prefix. Matching is case-insensitive and
accepts either the internal name (`ao.app.active`) or the exported PostHog alias
(`ao.v2.app.active`), so the name visible in PostHog works without translation.

The list is enforced in two places, because AO has two producers: the daemon's
billed sink, and the renderer, which talks to PostHog directly. The supervisor
passes the list to the daemon as an environment variable and to the renderer on
the telemetry bootstrap, so denying `ao.v2.app.active` silences both rather than
leaving the renderer sending under the same exported name.

Renderer export is additionally off by default on unpackaged builds, so a
developer's ordinary session does not appear in the production project as a real
install. `AO_TELEMETRY_RENDERER=on` opts a dev build back in for deliberate
testing; `off` opts a packaged build out.

This exists because every other control in this document is compiled into the
build. Silencing a stream previously meant shipping a release and waiting for
users to install it, which took weeks the one time a stream turned out to be
expensive. The denylist is applied by the daemon at startup, so it takes effect
on installs that already exist.

The switch is applied outermost on the remote chain: a silenced stream consumes
no aggregation window, no rate-limit slot, and no export. Local SQLite storage is
deliberately unaffected, so a stream silenced in production stays debuggable
locally. Unrecognized entries are inert rather than fatal, because the switch has
to be usable in a hurry.

## PostHog Retention And Geography Dashboard

Use `ao.v2.app.active` as the current active-user event for DAU, weekly
retention, and country-level active-user maps. During migration, union it with
legacy `ao.app.active` where `channel=renderer` or where `channel=cli` and
`actor_type=user`. AO emits active-user telemetry from:

- `channel=renderer` when the desktop app initializes and at most once per UTC
  six-hour slot while the app stays open
- `channel=cli` when the CLI reports a meaningful user-typed command
  invocation to the local daemon, at most once per UTC six-hour slot per install

Recommended PostHog setup:

1. Enable PostHog GeoIP enrichment for the project.
2. Create an "AO Active Users" dashboard.
3. Add a Trends insight:
   - Event: `ao.v2.app.active`
   - Aggregation: unique users
   - Chart type: world map
   - Breakdown: GeoIP country code, for example `$geoip_country_code`
4. Add a Retention insight:
   - Start event: `ao.v2.app.active`
   - Return event: `ao.v2.app.active`
   - Interval: weekly
   - Range: last 12 weeks
5. Add optional filters or breakdowns for `channel=renderer` and `channel=cli`
   when comparing desktop app and CLI activity.

PostHog references:

- GeoIP enrichment: https://posthog.com/docs/cdp/geoip-enrichment
- Trends insights: https://posthog.com/docs/product-analytics/trends
- Retention insights: https://posthog.com/docs/product-analytics/retention
