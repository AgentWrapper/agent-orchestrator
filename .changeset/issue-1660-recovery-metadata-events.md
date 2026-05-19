---
"@aoagents/ao-cli": patch
"@aoagents/ao-core": minor
---

Wire activity events for the recovery subsystem, metadata-corruption detection, and agent-report apply path. New event kinds: `recovery.session_failed`, `recovery.action_failed`, `metadata.corrupt_detected`, `api.agent_report.session_not_found`, `api.agent_report.transition_rejected`. Adds `"recovery"` to the `ActivityEventSource` union. Lets RCA reconstruct `ao recover` invocations, find every silent metadata overwrite, and audit rejected agent transitions. Adds `ao events list --source` and `--kind` so these forensic event queries are available from the CLI.
