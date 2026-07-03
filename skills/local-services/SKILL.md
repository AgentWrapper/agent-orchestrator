---
name: local-services
description: Use when starting, stopping, restarting, or debugging the local AO daemon or LAN web UI, editing scripts/ service wrappers, deploying a rebuilt ao binary, or when the UI on :3000 is down, terminals loop "disconnected, reattaching" (403 on /mux), or lan-web logs show EADDRNOTAVAIL.
trigger: Anything involving the launchd jobs dev.agent-orchestrator.daemon / .lan-web, scripts/*.sh, ao-svc, or "is the daemon/UI up?"
---

# Local Services

Two launchd LaunchAgents run AO on this machine. Repo `scripts/` is the source
of truth; launchd runs **copies** under `~/.ao/`. Deep runbook: `~/.ao/FEREADME.md`.

| Job (gui/$(id -u)/…)             | Runs                      | Serves                                    |
| -------------------------------- | ------------------------- | ----------------------------------------- |
| `dev.agent-orchestrator.daemon`  | `~/.ao/ao-daemon.sh`      | `~/.ao/bin/ao daemon` on `127.0.0.1:3001` |
| `dev.agent-orchestrator.lan-web` | `~/.ao/lan-web-server.sh` | Vite renderer UI on `0.0.0.0:3000` (LAN)  |

Plists: `~/Library/LaunchAgents/dev.agent-orchestrator.{daemon,lan-web}.plist`.
`~/.ao/ao-svc {up|down|status}` manages **lan-web only**; drive the daemon job
with raw `launchctl`.

## Health check

```sh
ao status && ao session ls                       # daemon ready? sessions?
launchctl list | grep agent-orchestrator        # which jobs are loaded
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/   # 200 = UI up
tail -5 ~/.ao/lan-web.err.log ~/.ao/daemon.err.log
```

## Common operations

```sh
# Fresh machine (or drifted install) — full reproducible setup from the repo:
scripts/dev-setup.sh                             # idempotent; never restarts loaded jobs

# UI down / EADDRNOTAVAIL in lan-web.err.log (LAN IP drifted or job unloaded):
~/.ao/ao-svc up                                  # or: launchctl kickstart -k "gui/$(id -u)/dev.agent-orchestrator.lan-web"

# Deploy edited scripts (edit in repo scripts/, then):
cp -f scripts/{ao-svc,ao-daemon.sh,lan-web-server.sh} ~/.ao/
# …then kickstart the affected job.

# Deploy a rebuilt daemon (launchd runs ~/.ao/bin/ao, NOT the PATH install):
scripts/daemon-build.sh
cp -f ~/.cache/aoagents/agent-orchestrator/bin/ao ~/.ao/bin/ao
launchctl kickstart -k "gui/$(id -u)/dev.agent-orchestrator.daemon"   # daemon only — sessions survive
```

## Daemon restart ≠ agent relaunch (verified 2026-07-02)

`kickstart -k` cycles only the daemon process; tmux panes are independent, so
the new daemon **reattaches** to live sessions — zero disruption, but running
agents keep their old argv (new flags/config do NOT apply to them). To actually
relaunch agents with fresh argv (`ao session ls` first — they re-park at the
`claude --resume` menu; pick option 2 for full context):

```sh
ao stop --timeout 30s                            # all: panes torn down; KeepAlive respawns daemon → restore-all
ao session kill <id> && ao session restore <id>  # one session, surgical
```

## Gotchas

- **Terminals loop "disconnected, reattaching" (403 on `GET /mux`)** — Origin
  mismatch. Both wrappers derive the current LAN IP at start so
  `AO_ALLOWED_ORIGINS` and the UI's API base agree; a restart of both jobs fixes
  drift. It never self-heals. Verify: the curl handshake in `~/.ao/FEREADME.md`
  should print `101`.
- **TCC**: a launchd-spawned daemon cannot read repos under `~/Desktop`. For
  sessions needing those: `launchctl bootout gui/$(id -u)/dev.agent-orchestrator.daemon`,
  then from a real terminal `AO_ALLOWED_ORIGINS=http://<lan-ip>:3000 ao start`.
- **Two `ao` binaries**: PATH `ao` (`~/.local/bin` → `~/.cache/aoagents/...`) vs
  the daemon's `~/.ao/bin/ao`. Rebuilding via `daemon-build.sh` does **not**
  update the running daemon until you copy + kickstart.
- **"did not become ready within 10s"** on restart is usually false — restore-all
  worktree checkouts blow the window. Use `--timeout 30s`, check `ao status`.
- **`running.json`** (`~/.ao/running.json`) is regenerated every start. Never
  commit a copy (gitignored as `scripts/running.json`).
