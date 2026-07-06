# ao standup — how this deployment was stood up

Record of the actual standup of this ao 0.10x deployment on `mirrorborn`
(2026-07-05/06), per the plan in `docs/0.10x-adoption-report.md` §5. Everything
below was done with **vanilla ao** — no patches beyond the tracked
upstream-shaped deltas noted at the end. All commands and unit contents were
verified against the live host at write time.

## Topology

One always-on Go daemon under one OS account (`orchestrator`), per decision
D-a in the adoption report. The daemon is loopback-only HTTP on port 3001
(`~/.ao/running.json` is the PID/port handshake); the CLI is a thin HTTP
client; the primary UI is the **web renderer over Tailscale**, not Electron
(decision D-b). Slack is the notification surface, via a small read-only
SSE consumer (also D-b).

## 1. Build and install the binary

The `ao` CLI/daemon is the Go tree under `backend/`:

```bash
cd ~/agent-orchestrator/backend
go build -o ~/.local/bin/ao ./cmd/ao
```

Two subcommands matter here and are easy to confuse:

- **`ao daemon`** — the hidden subcommand that runs the daemon headless in the
  foreground. This is the entrypoint the systemd unit uses.
- **`ao start`** — NOT a daemon starter: it fetches the Electron desktop app
  from GitHub Releases and opens it (see
  `docs/ao-start-bootstrapper-and-npm-deprecation.md`). On a headless server
  it is the wrong command.

## 2. systemd user units + linger

Three user units under `~/.config/systemd/user/`, all `WantedBy=default.target`.
`loginctl enable-linger orchestrator` keeps the user manager (and therefore
the fleet) alive without an interactive login; verified `Linger=yes`.

- **`ao.service`** — `ExecStart=%h/.local/bin/ao daemon`, `Restart=on-failure`,
  `RestartSec=5`. `Environment=PATH=%h/.local/bin:…` so spawned sessions and
  the daemon's own `ao hooks` calls resolve the binary.
- **`ao-web.service`** — `After=ao.service`;
  `WorkingDirectory=%h/agent-orchestrator/frontend`;
  `ExecStart=/usr/bin/npm run dev:web`; `Environment=VITE_AO_API_BASE_URL=`
  (empty — see below). `RestartSec=10`. A drop-in
  (`ao-web.service.d/override.conf`) adds two host-side requirements found
  during standup — see §3.
- **`ao-slack-notifier.service`** — `After=ao.service`;
  `ExecStart=/usr/bin/node %h/agent-orchestrator/ops/ao-slack-notifier.mjs`;
  `RestartSec=15`.

Enable with `systemctl --user enable --now ao ao-web ao-slack-notifier`.

## 3. Web UI: tailscale serve → vite dev:web

Per adoption report §4 R17 this is the 0.9x arrangement minus the loopback
patch (loopback is now ao's hardcoded default). The vite dev server proxies
`/api` and `/mux` to the daemon (`frontend/vite.renderer.config.ts`), and
Tailscale fronts the vite port on the default HTTPS port:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:5173
```

Live URL: `https://mirrorborn.<tailnet>.ts.net/` → `127.0.0.1:5173`.

Two host-side requirements, discovered as a live 502/403 during standup and
now carried in the `ao-web.service.d/override.conf` drop-in:

- **vite must bind `127.0.0.1`, not `::1`.** Node resolves `localhost` to
  `::1`, so plain `npm run dev:web` listens on IPv6 loopback only while
  tailscale serve dials `127.0.0.1` — every proxied request 502s. The drop-in
  runs `npm run dev:web -- --host 127.0.0.1`.
- **vite must allow the tailnet Host header.** Vite's `server.allowedHosts`
  rejects non-localhost hosts with a 403. The drop-in sets vite's
  escape-hatch env var
  (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=mirrorborn.<tailnet>.ts.net`) —
  a host-side setting, so the tree needs no per-host hostname baked in.
  (Since the 2026-07-06 ownership split the browser-mode frontend is ours to
  change, so `server.allowedHosts` in the vite config is a legitimate
  alternative if a repo-side fix is ever preferred.)

Note vite auto-increments its port when the default is busy — if the UI
vanishes after a restart, check which port vite actually took before
touching the tailscale config.

What the browser gets is the **preview-mode renderer**: `npm run dev:web`
itself sets `VITE_NO_ELECTRON=1` (see `frontend/package.json`), which flips
renderer hooks to preview behavior — mock workspace data and mock
per-session PR summaries instead of live ones. That degradation is
deliberate and accepted for
this deployment for now; a first-class real-data browser mode is adoption
report §7 filing 6, and since the 2026-07-06 ownership split the browser
experience is ours to build in-tree rather than waiting on upstream. `VITE_AO_API_BASE_URL` is set to the empty
string in the unit — empty means same-origin, so REST goes through the vite
proxy instead of parking on "daemon not ready".

Caveats that remain by design: it is a dev-server arrangement, there is no
auth (the tailnet is the security boundary; `/mux` skips origin checks), and
Electron-only surfaces (daemon supervision, native notifications, updates)
are stubbed in browser mode.

## 4. Project registration and config

```bash
ao project add --path ~/agent-orchestrator   # etc. per project
ao project set-config agent-orchestrator \
  --default-branch main \
  --session-prefix ao \
  --worker-agent claude-code \
  --orchestrator-agent claude-code \
  --permission bypass-permissions \
  --env POLYPOWERS_AUTOMERGE=1 \
  --env POLYPOWERS_REPO=polymath-ventures/agent-orchestrator
```

**`set-config` REPLACES the entire config blob — it does not merge.** Pass
every flag every time; a call that "just updates one env var" silently drops
the rest of the config. The command above is the full live config — the
`POLYPOWERS_*` env grants workers the autonomous merge+deploy loop (decisions
D-c/D-e), `bypass-permissions` keeps unattended workers from stalling on
prompts. Omitting any of those flags on a later `set-config` call deletes
that piece of config.

Registered projects at standup: `agent-orchestrator` (prefix `ao`),
`coachclaw` (prefix `cc`). Adding a project in the UI spawns its orchestrator
immediately; thereafter the daemon ensures one exists (ensure-on-load).

## 5. Slack notifier

`ops/ao-slack-notifier.mjs` — read-only glue per decision D-b: consumes the
daemon's SSE stream (`GET /api/v1/events`) and posts `needs_input`,
`ready_to_merge`, `pr_merged`, and park events to Slack. It reads ao and
changes nothing; no workflow logic lives in it.

Configuration comes from the environment or
`~/agent-orchestrator/.env`: **`SLACK_BOT_TOKEN` + `SLACK_CHANNEL`**
(preferred, `chat.postMessage`) or `SLACK_WEBHOOK_URL` (fallback). The Slack
_app_ credentials alone cannot post — without one of those sinks the service
exits at startup with a pointed error.

## 6. Tracked deltas from upstream (the vanilla rule)

The ao backend is never patched ad hoc; each delta is an issue here plus an
upstream filing (see the ownership split and vanilla rule in `CLAUDE.md` and
adoption report §7 — since 2026-07-06 the browser-mode frontend is exempt,
we own that surface):

- **Per-session `--model` on `ao spawn`** — landed as PR #2 (issue #1).
  Precedence: `--model` > role `agentConfig.model` > project > adapter
  default. This is what makes the cheap (haiku) deploy pool possible.
- **codex-fugu adapter** — issue #3, **pending**. Until it lands, fugu's share
  of the worker mix is expressed by instructing workers to delegate
  deep-reasoning/review phases to the `codex-fugu` binary.

`oldao/` is reference-only history; nothing here was resurrected from it.
