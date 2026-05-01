---
"@aoagents/ao-core": minor
"@aoagents/ao-cli": patch
---

Remove the `Terminal` plugin slot. It had no non-test consumers: the dashboard uses `DirectTerminal.tsx` + WebSocket directly, and `ao open` shells out to `open-iterm-tab`. The `terminal-iterm2` and `terminal-web` plugin packages are deleted along with the `Terminal` interface, slot registration, and related scaffolding. The plugin system now exposes 6 slots: runtime, agent, workspace, tracker, scm, notifier.
