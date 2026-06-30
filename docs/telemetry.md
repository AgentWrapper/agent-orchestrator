# Telemetry

The Electron renderer sends anonymous usage events to PostHog automatically. The daemon is not involved.

## What is collected

- App activation and renderer load events
- Route views (home, project board, session detail, etc.)
- Project add / remove actions (project path is SHA-256 hashed before transmission)
- Unhandled renderer exceptions (error name and surface only)

PostHog session recording is also enabled. Network request names are masked before recording.

## Privacy

Before any event or recording is transmitted:

- Absolute file paths (`/home/…`, `/Users/…`, `C:\…`) are replaced with `[redacted-local-path]`
- Local URLs (`file://`, `app://renderer`, `localhost`, `127.0.0.1`, `[::1]`) are replaced with `[redacted-local-url]`
- Project IDs are one-way hashed (SHA-256) and never sent in plain text

## Install ID

On first run, a random install identifier is generated and stored at `~/.ao/data/telemetry_install_id` (or `$AO_DATA_DIR/telemetry_install_id`). This ID is used to deduplicate events across sessions. It is not linked to any personal account.

## Overriding the PostHog endpoint or key

The key and host are baked in at build time. To point at your own PostHog instance, set these environment variables before building:

```
VITE_AO_POSTHOG_KEY=phc_yourkey
VITE_AO_POSTHOG_HOST=https://your-posthog-host.com
```

Setting `VITE_AO_POSTHOG_KEY` to an empty string disables transmission entirely.
