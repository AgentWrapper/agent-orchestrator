---
"@aoagents/ao-cli": minor
---

Add `ao migrate`: port the legacy project registry and per-project settings into
the new AO (rewrite) daemon. It mirrors the rewrite's own `ao project add` flow
over the daemon's loopback REST API (so the daemon stays the sole writer of its
store) and maps project config per the migration spec (aoagents/ReverbCode#247
sections 1 and 3). Supports `--dry-run` and `--daemon-url`. Sessions are not
migrated by this command.
