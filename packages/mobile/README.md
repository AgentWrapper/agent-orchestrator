# Agent Orchestrator - Mobile

Expo (expo-router) mobile supervisor for Agent Orchestrator. Four tabs - Kanban,
PRs, Orchestrator, Settings - plus a spawn flow and a session screen. It talks to
your AO server's HTTP API over your LAN or Tailscale.

## Run

```bash
cd packages/mobile
npm install
npm start          # then press i (iOS), a (Android), w (web), or scan the QR in Expo Go
npm run web        # real terminal in a desktop browser (http://localhost:8081)
```

## Web

`npm run web` serves the same app to a desktop browser via react-native-web.
The session screen renders a real xterm.js terminal (`lib/WebTerminal.web.tsx`,
a port of the desktop renderer's terminal) against the daemon's `/mux` socket -
keyboard, paste, copy-on-select, wheel scroll (SGR reports into the pane),
zoom, and Restore all work.

- **Browser on the same machine as the daemon:** set Host `localhost`, API
  Port `3001` in Settings. Zero daemon config - the CORS guard allows
  loopback origins.
- **Browser on a different machine:** the daemon 403s non-loopback browser
  Origins. Either run the Origin-rewriting bridge (`scripts/README.md`) and
  point Settings at `<machine>:3011`, or start the daemon with
  `AO_ALLOWED_ORIGINS=http://<web-host>:8081`.

## Connect

Open **Settings** and set:

- **Host** - your PC's Tailscale name / `100.x` address, or its LAN IP on the same Wi-Fi.
- **API Port** - the AO server HTTP API port.
- **Terminal Port** - legacy setting kept for older configs. The Go daemon serves REST and terminal mux on the API port.
- **Use TLS** - on only if AO is served over HTTPS (e.g. a Tailscale funnel).

Tap **Test connection**, then **Save**.

## Status

The board, PR list, orchestrator controls, spawn flow, settings, in-app terminal,
restore flow, and static preview browser are live against the Go daemon API.

## Verify

```bash
npm run typecheck   # tsc --noEmit
```
