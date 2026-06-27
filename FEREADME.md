# ~/.ao — Agent Orchestrator runtime

Runtime state + logs for the **new** AO install (binary: `~/.local/bin/ao`).
The daemon listens on `127.0.0.1:3001`. The web UI is a separate LAN Vite server on
`http://192.168.1.250:3000` (see "Web UI" below).

## ⚠️ Restarting the daemon — set AO_ALLOWED_ORIGINS or the UI terminals break

Always restart from a **real terminal** (not launchd — see TCC note) with the LAN
origin allowlisted:

```sh
ao stop --timeout 30s && AO_ALLOWED_ORIGINS=http://192.168.1.250:3000 ao start --timeout 30s
```

**Why:** the daemon gates the terminal-attach WebSocket (`GET /mux`) by Origin via
`AO_ALLOWED_ORIGINS`. The browser loads the UI from `http://192.168.1.250:3000`, so that
is the Origin it sends. A bare `ao start` defaults the allowlist to the daemon's own
`127.0.0.1:3001`, so every UI terminal WebSocket upgrade is rejected with **403** and the
UI shows **"terminal disconnected, reattaching"** in an endless loop. The daemon, tmux
sessions, and `ao doctor` all look perfectly healthy in this state — only the env-var
restart fixes it. It does **not** self-heal.

The known-good origin value is documented in the comment block of `lan-web-server.sh`.

### Verify the fix

```sh
# Should print "HTTP/1.1 101 Switching Protocols" (was 403 when broken):
curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: http://192.168.1.250:3000" http://127.0.0.1:3001/mux | head -1

# Fresh status=101 lines after the restart timestamp = UI terminals attaching:
grep 'path=/mux' ~/.ao/daemon.log | grep 'status=101' | tail
```

(A `/api/v1/notifications/stream` request stuck on **"pending"** in the network tab is
normal — it's a long-lived SSE stream, unrelated to the mux issue.)

## Web UI (LAN)

Served by launchd job `dev.agent-orchestrator.lan-web`
(`~/Library/LaunchAgents/dev.agent-orchestrator.lan-web.plist` → `lan-web-server.sh`),
a Vite dev server bound to `0.0.0.0:3000`. launchd KeepAlive supervises it across crashes
and reboots. **This LaunchAgent intentionally does NOT start the daemon** — the
skyvern / skyvern-cloud repos under `~/Desktop` are TCC-blocked for launchd-spawned
processes, so a daemon launched there couldn't read them. Start the daemon from a
terminal (which has Desktop access) instead, per the command above.

## What a daemon restart does to running sessions

`ao stop` tears down the session tmux panes; `ao start` runs restore-all, which
re-checks-out each session's git worktree and relaunches the agent as `claude --resume`:

- **"did not become ready within 10s" is often a false failure** — restore-all's worktree
  checkout on a big repo (skyvern-cloud ~13.5k files) blows past the 10s window. The daemon
  comes up a few seconds later; check `ao status` / the log for a later `daemon listening`
  line before re-running. `--timeout 30s` avoids the spurious non-zero exit.
- **Agents re-park at the `claude --resume` menu** (1. summary / 2. full / 3. don't ask).
  Until a choice is made the agent hasn't started, so `ao session ls` reads `[no_signal]`.
  To preserve a worker's full context pick option 2:
  `tmux send-keys -t <sess> Down; sleep 0.4; tmux send-keys -t <sess> Enter`.
  "Resume from summary" is lossy/irreversible for in-flight work.
- **`[no_signal]` ≠ broken** — it just means no heartbeat received since reboot; it clears
  on the agent's next turn.

## File map

| Path                    | What                                                     |
| ----------------------- | -------------------------------------------------------- |
| `bin/`                  | helper shims (e.g. `gh` wrapper used for git credential) |
| `daemon.log`            | daemon HTTP + lifecycle log                              |
| `data/`                 | sqlite (`ao.db`), worktrees, session state, `hooks.log`  |
| `electron/`             | Electron desktop shell state                             |
| `lan-web-server.sh`     | launchd-run Vite UI launcher (port 3000, LAN)            |
| `lan-web.{out,err}.log` | Vite UI server stdout/stderr                             |
| `running.json`          | live daemon `{pid, port, startedAt}`                     |
| `mandates/`             | session mandate backups                                  |

## Health check

```sh
ao status      # daemon ready / pid / port
ao doctor      # core + tools + harness + GitHub token checks
ao session ls  # active sessions and their states
```
