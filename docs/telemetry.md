# Telemetry

AO uses anonymous telemetry to understand reliability and product usage. The
Electron renderer sends sanitized PostHog events directly, and the Go daemon can
persist allowlisted events locally and fan them out to PostHog when remote
telemetry is enabled.

## What is collected

- App activation events: `ao.app.active` from the renderer and CLI, each capped
  at once per UTC day per install
- Renderer load and route views, grouped by coarse surface names
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

`ao.cli.invoked` is capped at once per command path per UTC day per daemon, so
script- or agent-driven polling (`ao status`, `ao session ls`, `ao hooks`
firing on every agent hook event, ...) reports as "this install used this
command today" rather than one event per call. Only commands that never
reflect activity — the supervisor-driven `ao daemon`/`ao start` and the
self-documenting `ao completion`/`ao help` — are excluded outright. `ao hooks`
and `ao pty-host` are deliberately NOT excluded: on a headless or CLI-only
install, agent hook activity may be the only signal that install did anything
that day, and excluding it would silently zero out `ao.app.active` (and DAU)
for that install. The per-command daily cap, not exclusion, is what keeps
their invocation frequency off PostHog.

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
