---
"@aoagents/ao-plugin-runtime-tmux": patch
"@aoagents/ao-web": patch
---

Tmux sessions no longer die when the agent process inside them exits. When you Ctrl-C the agent in a web terminal, the pane now drops to an interactive `$SHELL` in the workspace dir instead of nuking the tmux session and leaving the dashboard in a phantom "runtime lost" state. The lifecycle manager still detects the agent exit (via `agent.isProcessRunning`) and transitions the session to `agent_process_exited`, but the runtime stays usable so you can run shell commands or manually re-launch the agent.

Also: the mux-websocket re-attach loop now checks `tmux has-session` before retrying after a PTY exit. When the tmux session is genuinely gone (e.g. `ao stop`), it skips the three doomed `attach-session` spawns from #1640 and notifies the dashboard immediately. (#1756)
