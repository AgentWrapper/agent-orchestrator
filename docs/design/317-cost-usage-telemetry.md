# Cost/Usage Telemetry Producer

Issue: #317

## Decision

AO will produce cost/usage telemetry through the existing harness hook callback path.
Native Stop-hook payloads may include usage fields. The `ao hooks <agent> stop`
CLI extracts only the allowlisted numeric cost fields and forwards them as
optional fields on the existing activity POST. The daemon then emits a separate
`ao.session.usage` telemetry event after the lifecycle reducer accepts the
activity signal.

The emitted telemetry payload uses the existing metrics contract:

- `input_tokens`
- `output_tokens`
- `total_tokens`
- `cost_usd`
- `harness`

The telemetry row uses the accepted activity signal's session id and the stored
session's project id. Hook payloads are not trusted to supply project identity.

## Rationale

The metrics consumer already aggregates telemetry rows with these payload keys.
The missing piece is a producer, not another read model. Extending the hook path
keeps production local to the harness turn boundary and matches the existing
adapter design that derives session identity/activity from hooks instead of
transcript or cache scans.

Transcript scanning is deferred because it would add filesystem coupling,
session-cache format assumptions, and duplicate event suppression problems. OTEL
ingest is also deferred because it requires a new external producer contract.

## Compatibility

The activity request fields are optional. Old hook CLIs keep sending state-only
activity requests. Native Stop-hook payloads without usage fields produce no
cost event. Usage fields on non-Stop hooks are ignored so tool-level payloads or
duplicated intermediate callbacks cannot double-count a turn. Payloads with
invalid, negative, non-finite, or implausibly large numeric usage values are
ignored for cost emission rather than poisoning fleet metrics.

## Coverage

The hook extractor is harness-token agnostic, so the same allowlist applies to
`claude-code`, `codex`, and `codex-fugu`. Adapter-specific coverage verifies
that Codex and Codex Fugu both launch with the hook token that the CLI forwards
as the telemetry `harness`.
