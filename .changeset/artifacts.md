---
"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
"@aoagents/ao-web": minor
---

feat: artifacts — structured agent output in the session detail right rail

Agents publish markdown / html artifacts via `ao artifact publish`. The dashboard
renders them as cards in the session detail right rail. Live updates flow over
the existing mux WebSocket.

See `docs/artifacts.md` for the agent-facing contract.
