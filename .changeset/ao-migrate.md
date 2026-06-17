---
"@aoagents/ao-cli": minor
---

Add `ao migrate`: an offline command (run with the rewrite daemon stopped) that
ports the legacy flat-file project registry and each project's single
non-terminated orchestrator session into the rewrite's SQLite database, creating
the DB from vendored goose migrations (pinned to ReverbCode @ 43ae7eb) when
absent. Relocates claude-code orchestrator transcripts so they resume with
context. Idempotent, with `--dry-run` and `--json` for the `ao update` cutover
contract (locked exit codes + summary). Workers are not migrated; they respawn
fresh in the rewrite. Refs #2129.
