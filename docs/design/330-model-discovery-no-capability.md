# Issue 330: Model Discovery No-Capability Verdict

## Decision

AO will keep `status: "unknown"` for "no provider verdict" and add a
machine-readable reason code:

```text
reasonCode: "no-capability"
```

This avoids API enum churn while making "this harness has no discovery
capability" distinct from probe failures and ordinary unprobed catalog rows.
`unreachable` continues to mean the provider/account rejected the model.

The no-capability state is informational and fail-open. It must not block a
project config save, spawn, or worker-mix capacity calculation.

## Harness Capability Assessment

`codex` and `codex-fugu` already implement `ports.AgentModelValidator` through
the bounded `codex exec --model ...` probe. No catalog implementation is
available for them today, so AO continues to use the static known-set plus
configured pins as candidates.

`claude-code` supports a non-interactive print mode and launch-time model flag:
`claude --print --model <model>`. This can support a bounded
`AgentModelValidator` without provider API integration, provided the adapter
classifies CLI usage errors, timeouts, startup failures, and non-verdict
failures as `ProbeUnavailableError`.

`opencode` is no-capability for now. The current adapter does not pass AO model
pins at launch, so AO has no adapter-level model-specific validation path for it
today.

Other registered harnesses expose neither `AgentModelCatalog` nor
`AgentModelValidator` in their AO adapters. They are treated as no-capability.

## Reason Codes

`not-probed` marks catalog rows AO listed but did not live-validate.

`probe-unavailable` marks a probe path that failed to render a provider verdict:
cancelled context, timeout, unsupported probe flags, missing binary, or similar.

`no-capability` marks a configured pin for a harness whose adapter exposes no
catalog or validator capability. Operator-facing text for this state is neutral:

```text
This harness has no model discovery capability; configured pins are accepted without live validation.
```

The settings-page layout and richer rendering are intentionally left to the
sibling settings-unification issue.

## Implementation Plan

1. Add `ModelReasonCode` and the `reasonCode` JSON field to model availability.
2. Return `unknown` + `reasonCode: "no-capability"` for configured pins on
   harnesses with no validator.
3. Keep probe failures as `unknown` + `reasonCode: "probe-unavailable"` and
   provider rejections as `unreachable`.
4. Implement a bounded Claude Code validator using `claude --print --model`.
5. Regenerate the OpenAPI document and frontend API type.
6. Cover catalog, validator-only, no-capability, and probe-unavailable versus
   provider-rejection classifications in tests.
