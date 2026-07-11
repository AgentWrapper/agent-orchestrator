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
  the browser-mode renderer from already-installed npm lockfile dependencies;
  `ops/deploy.sh` runs `npm ci` first whenever `frontend/package.json` or
  `frontend/package-lock.json` changed in the deploy range, aborting before
  restart if installation fails. `ExecStart=/usr/bin/node ops/ao-web-server.mjs`
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
The frontend is npm-lockfile-managed: `frontend/package-lock.json` is the
authoritative dependency graph, and the deploy path runs
`npm --prefix frontend ci` before restarting web whenever the package metadata
changed.
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
config="$(ao project get agent-orchestrator --json \
  | jq -c '.project.config
      | .defaultBranch = "main"
      | .projectPrefix = "ao"
      | .worker = ((.worker // {}) | .agent = "claude-code")
      | .orchestrator = ((.orchestrator // {}) | .agent = "claude-code")
      | .agentConfig = ((.agentConfig // {}) | .permissions = "bypass-permissions")
      | .autonomousMerge = true
      | .env = ((.env // {})
          | .POLYPOWERS_REPO = "polymath-ventures/agent-orchestrator")')"
ao project set-config agent-orchestrator --config-json "$config"
```

**`set-config` REPLACES the entire config blob — it does not merge.** Pass
the whole current object every time; a call that "just updates one env var"
drops the rest of the config. Before editing, GET the current config, apply the
intended change, then send the full replacement with `--config-json`. The
command above edits the current live config in place so keys such as
`trackerIntake`, `workerMix`, and `reviewers` survive. `autonomousMerge`
grants workers the autonomous merge+deploy loop (decisions D-c/D-e), while
`POLYPOWERS_REPO` pins the GitHub repo for skills that need it.
`bypass-permissions` keeps unattended workers from stalling on prompts.

Disabling issue intake is protected: if `trackerIntake` is enabled, a
replacement payload that merely omits `trackerIntake` is rejected. Use the
first-class pause/resume control for intentional fleet pauses when available;
for a config-level disable, merge `trackerIntake.enabled=false` into the full
current config and send that full replacement JSON. Do not send a one-field
`{"trackerIntake":{"enabled":false}}` replacement unless clearing every other
config key is also intended.

Registered projects at standup: `agent-orchestrator` (prefix `ao`),
`coachclaw` (prefix `cc`). Adding a project in the UI spawns its orchestrator
immediately; thereafter the daemon ensures one exists (ensure-on-load).

## 5. Slack notifier

`ops/ao-slack-notifier.mjs` — read-only glue per decision D-b: catches up unread
daemon notifications, follows `GET /api/v1/notifications/stream`, and polls
`GET /api/v1/sessions` for blocked/no-signal/dead-orchestrator attention. It
posts `needs_input`, sensitive `ready_to_merge`, `blocked`,
`orchestrator_dead`, worker `no_signal`, daemon-unhealthy, merge, close, and
"what needs me" digest messages to Slack. With bot-token delivery, the digest is
updated in place; webhook fallback reposts it when the content changes. It reads
ao and changes nothing except marking daemon notifications read after a
successful Slack delivery; no workflow logic lives in it.

Configuration comes from the environment or
`~/agent-orchestrator/.env`: **`SLACK_BOT_TOKEN` + `SLACK_CHANNEL`**
(preferred, `chat.postMessage`) or `SLACK_WEBHOOK_URL` (fallback). The Slack
_app_ credentials alone cannot post — without one of those sinks the service
exits at startup with a pointed error.

## 5a. Two-way attention system (issue #82)

The one-way `ao-slack-notifier` above is now the single outbound notifier. The
remaining **two-way attention system** piece is the inbound reply-to-unblock
path, still in the ops/nickify layer (vanilla rule: shells `ao send`; no ao core
change). See `docs/attention-system.md` for the full design. Summary:

- **`ops/attention-notifier.mjs`** (`ao-attention-notifier.service`) is retired
  as an outbound service. `ops/install-attention.sh` disables any leftover unit
  and removes the retired `~/.ao/attention-state.json` file so it cannot
  duplicate pages or preserve frozen ghost attention records.
- **`ops/attention-reply-listener.mjs`** (`ao-attention-reply.service`) is a
  loopback Slack Events API endpoint: a signed, Nick-authored explicit send
  command is verified and routed via `ao send`. Threaded replies still work only
  for legacy thread→session bindings; the current Slack notifier does not create
  new bindings.
- **`ops/what-needs-me.mjs`** is the terminal view of current session-derived
  attention.
- **`ops/install-attention.sh`** is the nickify/deploy wiring — it installs the
  reply unit, disables the retired outbound attention notifier, and checks that
  `SLACK_MEMBER_ID`, `SLACK_SIGNING_SECRET`, and a Slack sink are present in the
  env layer. `ops/deploy.sh` runs it whenever `ops/` changes. The notifier reads
  **`SLACK_MEMBER_ID` natively** (the legacy `SLACK_MENTION_USER_ID` alias is
  only a fallback), closing the config bug that made #6 inert.

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
