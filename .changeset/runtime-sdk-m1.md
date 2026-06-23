---
"@aoagents/ao-plugin-runtime-sdk": minor
"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
---

feat(runtime-sdk): add SDK-driven runtime plugin (M1)

New `runtime-sdk` runtime plugin drives Claude via `@anthropic-ai/claude-agent-sdk`
instead of a tmux PTY — the first no-terminal, streaming runtime adapter. A
long-lived host process owns the streaming `query()` session (survives
orchestrator restarts, reattaches via the provider `session_id` + `options.resume`),
writes a per-session NDJSON event log, and fans normalized, model-agnostic events
out to live subscribers over a Unix socket / named pipe (snapshot-then-live).
Registered as runtime slot `sdk`; `runtime-tmux` remains the default.
