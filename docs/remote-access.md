# Remote Access

Access the Agent Orchestrator (AO) dashboard — including the in-browser terminal — from another device on your network or from your phone.

> **TL;DR (Tailscale):**
>
> ```bash
> # 1. Discover the terminal WebSocket port (it can vary across dev instances)
> curl -s http://localhost:3000/api/runtime/terminal
> # → {"terminalPort":"14800","directTerminalPort":"14801","proxyWsPath":null}
>
> # 2. Expose the dashboard and the terminal WS — substitute directTerminalPort below
> sudo tailscale serve --bg --set-path=/                  http://localhost:3000
> sudo tailscale serve --bg --set-path=/ao-terminal-mux   http://localhost:14801/mux
> ```
>
> (Drop `sudo` on Windows; keep it on Linux/macOS.) Then open `https://<machine>.<tailnet>.ts.net/` on your phone.
>
> Then open `https://<machine>.<tailnet>.ts.net/` on your phone. Done.

---

## Why this needs setup

AO runs **two** servers on different ports:

| Server | Default port | What it serves |
|---|---|---|
| Next.js dashboard | `3000` | HTML, API routes, SSE event stream |
| Direct terminal WS (`direct-terminal-ws`) | `14801` | The xterm.js WebSocket at path `/mux` |

Your browser opens both. If your tunnel/proxy only exposes the dashboard port, the dashboard loads but the terminal sits on **"Connecting…"** forever — its WebSocket can't reach `:14801`.

```
                       ┌──────────────────────┐
                       │   Browser (phone)    │
                       └──────────┬───────────┘
                                  │ https://host.ts.net
                                  ▼
                       ┌──────────────────────┐
                       │  Reverse proxy /     │
                       │  Tailscale serve     │
                       └─┬──────────────────┬─┘
                /        │                  │ /ao-terminal-mux
                ▼        │                  ▼
        localhost:3000   │      localhost:14801/mux
        (Next.js)        │      (terminal WebSocket)
                         │
```

You need the proxy to forward **both** paths. The rest of this doc shows three ways to do it.

---

## Discovering the right ports

The terminal port is configurable and may differ from the default when you run multiple `pnpm dev` instances. Ask the dashboard directly:

```bash
curl -s http://localhost:3000/api/runtime/terminal
# {"terminalPort":"14800","directTerminalPort":"14801","proxyWsPath":null}
```

Use the `directTerminalPort` value. (`terminalPort` is a legacy field — ignore it.)

---

## Recipe 1 — Tailscale (recommended)

Tailscale gives you HTTPS automatically, which AO needs for PWA install on iOS/Android and for clipboard support. The `tailscale` CLI works the same on Linux, macOS, and Windows; commands below assume Linux/macOS — on Windows, drop `sudo` and run from an elevated shell.

```bash
# Dashboard at the root
sudo tailscale serve --bg --set-path=/                  http://localhost:3000

# Terminal WebSocket — note the /mux suffix on the backend URL
sudo tailscale serve --bg --set-path=/ao-terminal-mux   http://localhost:14801/mux

# Confirm both mounts
tailscale serve status
```

The trailing `/mux` on the backend URL is required: Tailscale strips the `--set-path` prefix before forwarding, so without it the request would hit `:14801/?session=...` and 404.

Then open `https://<your-machine>.<tailnet>.ts.net/` on any device signed into your tailnet.

> Skipped the discovery step in the TL;DR? Run `curl -s http://localhost:3000/api/runtime/terminal` to confirm `directTerminalPort` matches what you exposed (it can differ from `14801` when you have multiple `pnpm dev` instances). See [Discovering the right ports](#discovering-the-right-ports).

To tear down: `sudo tailscale serve reset`.

---

## Recipe 2 — Caddy

```caddyfile
ao.example.com {
    reverse_proxy /ao-terminal-mux* localhost:14801 {
        rewrite /mux
    }
    reverse_proxy localhost:3000
}
```

Caddy handles HTTPS automatically and upgrades WebSockets without extra config.

---

## Recipe 3 — nginx

```nginx
server {
    listen 443 ssl http2;
    server_name ao.example.com;
    # ssl_certificate / ssl_certificate_key here

    # Terminal WebSocket — must declare its own location for the upgrade headers
    location /ao-terminal-mux {
        proxy_pass http://127.0.0.1:14801/mux;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    # Everything else → Next.js
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
```

The `Upgrade` / `Connection` headers are mandatory for WebSocket — without them the connection silently fails.

---

## Mobile tips

### Install AO as a home-screen app (PWA)

AO ships a web manifest and service worker, so you can install it as a standalone app:

- **iOS Safari:** Share → *Add to Home Screen*
- **Android Chrome:** ⋮ → *Install app*

This gives you a fullscreen, app-like experience and an offline page when the tunnel drops. The install prompt only appears over **HTTPS** — Tailscale serve provides this for free.

### Keep your Mac awake

AO suppresses sleep while running. See [README.md → "Keep machine awake while running"](../README.md#remote-access). For travel with the lid closed, use [clamshell mode](https://support.apple.com/en-us/102505).

---

## Security

> ⚠️ **Neither the dashboard nor the terminal WebSocket has built-in authentication.** Anything that can reach AO can spawn agents and run arbitrary commands in your worktrees.

- **Do not expose AO on the public internet.**
- Use **Tailscale ACLs**, a VPN, or place a reverse proxy with auth (basic auth, OAuth proxy, Cloudflare Access) in front.
- Tailscale Funnel makes AO publicly reachable — **avoid it** unless you have an auth layer in front.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard loads but terminal stays on "Connecting…" | `/ao-terminal-mux` not proxied | Add the second proxy mount; reload the page |
| Terminal WS request returns `404` | Forwarding to `:14801/` instead of `:14801/mux` | Append `/mux` to the backend URL |
| Terminal WS request returns `400` or hangs | Reverse proxy not forwarding `Upgrade` / `Connection` headers | Add the WebSocket headers (see nginx recipe) |
| Works on laptop, fails on phone | Backend bound to `127.0.0.1`, or page loaded over HTTP on a non-standard port (client falls into direct-port mode and can't reach `:14801` through the tunnel) | Use a reverse proxy on standard ports (80/443) so the client uses the same-origin path |
| Multiple dev instances, wrong port in use | Dynamic port allocation | Re-check `curl /api/runtime/terminal` for the right `directTerminalPort` |
| Terminal disconnects every few seconds | Reverse proxy idle timeout too short | Raise `proxy_read_timeout` (nginx) or equivalent to at least an hour |

### Verifying a WebSocket route by hand

```bash
# Should return HTTP/1.1 101 Switching Protocols
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  https://<your-host>/ao-terminal-mux
```

A `101` means the proxy chain works end to end. `404`/`400`/`502` tells you which hop is misconfigured.
