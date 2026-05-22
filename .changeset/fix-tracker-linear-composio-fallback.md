---
"@aoagents/ao-plugin-tracker-linear": patch
---

fix(tracker-linear): fall back to the direct Linear transport when @composio/core is missing

The Linear tracker selects its transport by sniffing env: if `COMPOSIO_API_KEY` is set it routes through the Composio SDK, otherwise it uses the direct `LINEAR_API_KEY` API. But `@composio/core` is an optional dependency that isn't installed with the plugin, so any user who had `COMPOSIO_API_KEY` exported (commonly set globally for unrelated Composio work) got a hard `"Composio SDK (@composio/core) is not installed"` failure on every tracker call — even when a perfectly valid `LINEAR_API_KEY` was available.

The Composio transport now throws a typed `ComposioSdkMissingError` when the SDK can't be loaded. When that happens and a `LINEAR_API_KEY` is present, the tracker transparently falls back to the direct transport instead of failing. The `tracker.dep_missing` event is emitted only when there is genuinely no fallback (no `LINEAR_API_KEY`), so a successful fallback no longer raises a false error-level event.
