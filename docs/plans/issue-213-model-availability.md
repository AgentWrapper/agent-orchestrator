# Issue 213: live model availability

## Decisions

The selector will mark unreachable models instead of hiding them. Hiding a
temporarily unavailable configured pin makes config edits destructive because a
save can silently drop the value the operator is trying to repair.

Model catalogs are adapter-supplied when an adapter can provide them. Adapters
without a list capability fall back to the configured pins plus AO's small
known-set for the harness, and each candidate is probed through the existing
typed model validator. A probe infrastructure failure is reported as
inconclusive, not as model rejection.

## Shape

The agent service owns a `ModelAvailability` read model keyed by harness. A
refresh probes candidates concurrently with the existing bounded model-probe
timeout and returns one row per harness/model with one of:

- `reachable`: the model probe reached the provider/account and succeeded.
- `unreachable`: the provider/account rejected the model; the exact failure is
  retained.
- `unknown`: AO could not get a model verdict because the harness has no model
  probe or the probe infrastructure failed.

The HTTP surface exposes this as `GET /api/v1/agents/models`. The request must
not wait for every probe before answering indefinitely: individual probes keep
their adapter timeout, and unavailable probe machinery produces `unknown`
rows.

Project settings and project creation use the same refresh hook. Existing pins
are always included in the option list so the UI can show stale values as
marked rows instead of losing them.

The existing agent-health monitor grows a model-pin pass. Its harness lister
already derives configured harnesses every cycle; the model pass derives every
configured pin from project worker mixes, default role overrides, and
per-harness model overrides. Transitions are deduped in monitor state: newly
unreachable emits once, recovery emits once, and repeated checks with the same
status do not page.

## Tests

Backend coverage:

- Agent service classifies reachable, provider-rejected, and probe-unavailable
  model results.
- Controller returns the model availability envelope.
- Monitor transition logic dedupes model pin unreachable/recovery events.

Frontend coverage:

- Project settings populates model options from the endpoint and marks an
  unreachable configured pin.
- Project create sheet exposes the same refresh and option marking.
