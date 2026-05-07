---
"@aoagents/ao-core": patch
---

fix(core): disambiguate tmux session names by project path to avoid cross-config collisions (#1705)

Two `agent-orchestrator.yaml` checkouts on the same machine that share a `sessionPrefix` (e.g. two clones of the same repo) previously collided when both tried to call `tmux new-session -d -s {prefix}-{num}`, since tmux session names are global per user. The persisted `sessionId` and metadata still use the bare `{prefix}-{num}` form; only the tmux name now carries an 8-hex hash of the project path (e.g. `c13a01d4-int-1`). `parseTmuxName` accepts both the new 8-hex form and the legacy pre-v0.4.0 12-hex `{storageKey}-{prefix}-{num}` form for back-compat.
