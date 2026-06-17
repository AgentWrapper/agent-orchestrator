---
"@aoagents/ao-cli": minor
---

Teach `ao update` to perform the legacy-to-rewrite cutover (bridge 0.9.6).

When a rewrite build is published under the npm `next` dist-tag (or `AO_CUTOVER_VERSION` is set) and the current install is still legacy (`major.minor < 0.10`), `ao update` now migrates the user's data via `ao migrate` (issue #2129) and installs the rewrite at the exact pinned version instead of running the normal channel update.

The cutover flow: refuse if any active worker session is running (the orchestrator's own state never blocks), require a terminal confirmation (never auto-confirm a dashboard/api-invoked spawn), stop the daemon without restoring, run migration before the install replaces the legacy binary, install the rewrite, verify the new version, and finish without restarting the legacy daemon. `--check` now also reports `cutoverAvailable` and `cutoverTarget`.

When no `next` build exists (the common case), `ao update` behaves exactly as before across all install methods.
