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

- **`ao.service`** — tracked in `ops/ao.service`; `ExecStart=%h/.local/bin/ao
daemon`, `Restart=on-failure`, `RestartSec=5`. `Environment=PATH=%h/.local/bin:…`
  so spawned sessions and the daemon's own `ao hooks` calls resolve the binary.
  `KillMode=mixed` keeps systemd from sending the daemon's restart SIGTERM to
  tmux-backed agent sessions, and `TimeoutStopSec=60s` gives the daemon's
  background workers enough room to drain before any cgroup-level SIGKILL.
- **`ao-web.service`** — `After=ao.service`;
  `WorkingDirectory=%h/agent-orchestrator`;
  `Environment=VITE_AO_API_BASE_URL=` makes the browser bundle use same-origin
  API calls; `ExecStartPre=/usr/bin/npm --prefix frontend run build:web` builds
  the browser-mode renderer; `ExecStart=/usr/bin/node ops/ao-web-server.mjs`
  serves the built bundle on `127.0.0.1:5173` and proxies `/api`, `/healthz`,
  `/readyz`, and `/mux` to the daemon on `127.0.0.1:3001`. `RestartSec=10`.
  The drop-in (`ao-web.service.d/override.conf`) records the public tailnet URL
  for logs — see §3.
- **`ao-slack-notifier.service`** — `After=ao.service`;
  `ExecStart=/usr/bin/node %h/agent-orchestrator/ops/ao-slack-notifier.mjs`;
  `RestartSec=15`.

Enable with `systemctl --user enable --now ao ao-web ao-slack-notifier`.

## 3. Web UI: tailscale serve → production static server

Per adoption report §4 R17 this is the 0.9x arrangement minus the loopback
patch (loopback is now ao's hardcoded default). The browser renderer is built
with `VITE_NO_ELECTRON=1` and an empty `VITE_AO_API_BASE_URL` via
`npm --prefix frontend run build:web`, then served by `ops/ao-web-server.mjs`.
The server is intentionally small: static files come from `frontend/dist`,
unknown non-API paths fall back to `index.html`, and same-origin `/api`,
`/healthz`, `/readyz`, and `/mux` requests are proxied to the daemon on
`127.0.0.1:3001` so browser terminal WebSocket attach keeps working without
the vite dev server.

Tailscale fronts the production web port on the default HTTPS port:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:5173
```

Live URL: `https://mirrorborn.<tailnet>.ts.net/` → `127.0.0.1:5173`.

The live `ao-web.service.d/override.conf` drop-in contains only:

```ini
[Service]
# Host-specific public URL for operator logs. Tailscale serve remains the
# security boundary and should continue forwarding 443 to 127.0.0.1:5173.
Environment=AO_WEB_PUBLIC_URL=https://mirrorborn.tailc1fd9.ts.net/
```

There is no repo-side auth layer yet; the tailnet remains the security
boundary. The production server accepts proxied API/mux requests only from
loopback or `AO_WEB_PUBLIC_URL`, then strips the browser `Origin` header before
forwarding to the loopback daemon. Electron-only surfaces (daemon supervision,
native notifications, updates, and native BrowserView preview) are still
stubbed or hidden in browser mode.

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

## 5a. Two-way attention system (issue #82)

The one-way `ao-slack-notifier` above is complemented by the **two-way
attention system** — outbound alerts Nick can trust plus an inbound
reply-to-unblock path — all in the ops/nickify layer (vanilla rule: reads ao's
public HTTP API + shells `ao send`; no ao core change). The two share work by
disjoint ownership (session-derived attention here; PR/merge events stay on the
legacy notifier). See `docs/attention-system.md` for the full design. Summary:

- **`ops/attention-notifier.mjs`** (`ao-attention-notifier.service`) polls the
  authoritative `GET /api/v1/sessions` surface, @mentions Nick on every new
  attention transition (`needs_input`, `blocked`, parked sensitive merge, dead
  orchestrator, daemon unhealthy), **dedupes** unchanged states, keeps a single
  edited-in-place **"what needs me"** Slack digest, and self-alerts if it loses
  the daemon (silence never means healthy).
- **`ops/attention-reply-listener.mjs`** (`ao-attention-reply.service`) is a
  loopback Slack Events API endpoint: a signed, Nick-authored threaded reply
  (or `send <session> <msg>`) is verified and routed back to the originating
  session via `ao send`.
- **`ops/what-needs-me.mjs`** is the terminal equivalent of the digest.
- **`ops/install-attention.sh`** is the nickify/deploy wiring — it installs the
  units and checks that `SLACK_MEMBER_ID`, `SLACK_SIGNING_SECRET`, and a Slack
  sink are present in the env layer. `ops/deploy.sh` runs it whenever `ops/`
  changes. The notifier reads **`SLACK_MEMBER_ID` natively** (the legacy
  `SLACK_MENTION_USER_ID` alias is only a fallback), closing the config bug
  that made #6 inert.

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
