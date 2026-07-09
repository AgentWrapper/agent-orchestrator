---
name: machine-setup
description: Use when setting up AO on a fresh or rebuilt macOS machine, migrating machines, or repairing a drifted install (missing plists, stale ~/.ao scripts, ao not on PATH, lan-web won't start after reinstall).
trigger: User wants AO running on a new machine, or the local install no longer matches the repo.
---

# Machine Setup

Bootstrap the full local AO stack (daemon + LAN web UI under launchd) from this
repo on a fresh macOS machine. `scripts/dev-setup.sh` does the repo-owned parts;
this skill covers the whole path. Day-2 operations: see the `local-services`
skill (`skills/local-services/SKILL.md`).

## 1. Prerequisites (install once, not scripted)

| Tool           | Why                                            | Check              |
| -------------- | ---------------------------------------------- | ------------------ |
| go             | builds the `ao` daemon/CLI                     | `go version`       |
| node via nvm   | lan-web resolves node from `~/.nvm` explicitly | `nvm ls`           |
| tmux           | session runtime — spawn fails fast without it  | `tmux -V`          |
| claude         | default agent harness                          | `claude --version` |
| gh (logged in) | git credential for HTTPS remotes + PR tooling  | `gh auth status`   |

## 2. Bootstrap

```sh
git clone https://github.com/AronPerez/agent-orchestrator.git ~/dev/agent-orchestrator
cd ~/dev/agent-orchestrator
(cd frontend && npm install)     # vite — lan-web needs it
scripts/dev-setup.sh             # build ao, deploy ~/.ao scripts, generate plists, load jobs
```

The script is idempotent and prints a `.zshrc` alias line if missing
(`alias ao-svc="$HOME/.ao/ao-svc"`). Clone path is free — dev-setup links
`~/dev/ag-orc` at whatever checkout it runs from.

## 3. Register projects

State does **not** migrate — `~/.ao/data` (sessions, projects DB) starts fresh
by design. Re-register:

```sh
ao project add <path-to-repo>
# Per-project config: set-config REPLACES the whole config — pass full JSON,
# never a single flag, or you wipe branch/prefix/agents:
ao project set-config <id> --config-json '{...full config...}'
```

Keep project repos out of `~/Desktop`/`~/Documents` — macOS TCC blocks
launchd-spawned daemons from reading them (terminal-start override in
`~/.ao/FEREADME.md` if unavoidable).

## 4. Verify

```sh
ao status && ao doctor                            # daemon ready, tools found
launchctl list | grep agent-orchestrator          # both jobs loaded
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/   # 200
```

Then open `http://<lan-ip>:3000` (both wrappers derive the LAN IP themselves —
no hardcoding, survives DHCP drift).

## Pitfalls

- **`ao` resolves but wrong port** — another AO install shadows it; `which -a ao`,
  expect `~/.local/bin/ao` → port 3001.
- **lan-web crash-loops** — `frontend/node_modules` missing (step 2) or no nvm
  node; check `~/.ao/lan-web.err.log`.
- **Never `ao start`** to launch the daemon here — it fetches the release
  desktop app; the daemon runs via its launchd job (dev-setup loads it).
