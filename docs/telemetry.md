# Telemetry

Agent Orchestrator includes telemetry for understanding product usage, reliability, and failure modes. Telemetry is implemented as **best-effort structured events** and is controlled by environment variables.

## What We Collect

Telemetry events are structured records that capture:

- **Event Name** — The type of event (e.g., session lifecycle events, daemon operations, errors)
- **Source** — The component that emitted the event
- **Timestamp** — When the event occurred
- **Level** — Severity level (Debug, Info, Warn, Error)
- **Context** — Project ID, Session ID, and Request ID when applicable
- **Payload** — Event-specific metadata

**We do not collect:**

- Code from your repositories
- File contents or workspace data
- Authentication credentials or API keys
- Personal information beyond what is necessary for operational analytics

## Storage and Transmission

### Local Storage (Default)

By default, all telemetry events are stored locally in a SQLite database at:

```
~/.ao/data/telemetry.db
```

No data leaves your machine unless you explicitly configure remote telemetry.

### Remote Telemetry (Opt-In)

You may optionally configure remote telemetry via PostHog by setting the `POSTHOG_API_KEY` environment variable. When configured:

- Events are transmitted to PostHog for aggregate analytics
- Transmission is best-effort — failures do not affect daemon operation
- Events are batched to minimize network overhead

## Configuration

Telemetry behavior is controlled by these environment variables:

| Variable             | Default                   | Purpose                                                |
| -------------------- | ------------------------- | ------------------------------------------------------ |
| `AO_TELEMETRY_LEVEL` | `info`                    | Minimum event level to emit (debug, info, warn, error) |
| `POSTHOG_API_KEY`    | unset                     | PostHog API key for remote telemetry                   |
| `POSTHOG_HOST`       | `https://app.posthog.com` | PostHog host endpoint                                  |
| `AO_DATA_DIR`        | `~/.ao/data`              | Directory for local telemetry database                 |

## Disabling Telemetry

To completely disable telemetry:

```bash
export AO_TELEMETRY_LEVEL=none
```

This prevents both local storage and any remote transmission of telemetry events.

## Event Examples

Typical telemetry events include:

- Session spawned, terminated, or restored
- Daemon started or stopped
- Agent harness lifecycle events
- HTTP request errors
- Runtime failures
- SCM observation errors

These events help us understand:

- How agents are being used
- Where failures occur
- How to improve reliability
- Which features need attention

## Privacy Commitment

- Local telemetry is stored on your machine only
- Remote telemetry is opt-in via explicit environment variable configuration
- We do not collect code, file contents, or credentials
- Events are designed for aggregate product analytics, not individual surveillance
- PostHog configuration respects your privacy settings and data retention policies

For questions or concerns about telemetry, please open an issue on GitHub or join our Discord community.
