# Agent Orchestrator - Mobile

Expo (expo-router) mobile supervisor for Agent Orchestrator. Four tabs - Kanban,
PRs, Orchestrator, Settings - plus a spawn flow and a session screen. It talks to
your AO server's HTTP API over your LAN or Tailscale.

## Run

```bash
cd packages/mobile
npm install
npm start          # then press i (iOS), a (Android), w (web), or scan the QR in Expo Go
```

## Web

The app also runs in a browser (a quick look without a device):

```bash
npm run web        # expo start --web, then open http://localhost:8081
```

Connect it to a daemon reachable from the browser - on the same machine that is
Host `localhost` + the API port (see below). Caveat: the in-app **terminal** and
the **static preview browser** use `react-native-webview`, which has no web
implementation, so those two screens do not render on web - use a device or
simulator for them.

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
