# Telemetry

AO uses anonymous telemetry to understand reliability and product usage. The
Electron renderer sends sanitized PostHog events directly, and the Go daemon can
persist allowlisted events locally and fan them out to PostHog when remote
telemetry is enabled.

## What is collected

- App activation events: `ao.app.active` from the renderer and CLI
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
- `channel=cli` when the CLI reports a command invocation to the local daemon

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
