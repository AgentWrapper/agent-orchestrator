---
"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
---

Worker sessions now learn how to message the orchestrator that spawned them. When a project has an orchestrator running, the worker's system prompt gains a "Talking to the Orchestrator" section with the literal `ao send <prefix>-orchestrator "<message>"` command (rendered at prompt-build time, no env var, no shell-syntax variants). `ao send` itself now auto-prefixes outgoing messages with `[from $AO_SESSION_ID]` when invoked from inside an AO session, so the receiver always knows who's writing — symmetric across worker→orchestrator, orchestrator→worker, and worker→worker. Humans running `ao send` from a normal terminal stay unprefixed. (#1786)
