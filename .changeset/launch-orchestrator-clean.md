---
"@aoagents/ao-core": minor
"@aoagents/ao-web": minor
---

feat: "Launch Orchestrator (clean context)" action on the orchestrator session page

Adds a `Relaunch (clean)` action on the orchestrator session page that replaces the project's canonical orchestrator with a fresh one — killing the existing orchestrator, deleting its metadata, and spawning a new session with no carryover state. Backed by a new `SessionManager.relaunchOrchestrator(config)` method that ignores `orchestratorSessionStrategy`. Removes the now-redundant Orchestrator Selector page (`/orchestrators?project=X`) — there is only ever one orchestrator per project, so a selector page is no longer meaningful. Closes #1900 and #1080.
