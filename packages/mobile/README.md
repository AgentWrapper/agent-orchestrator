# Agent Orchestrator - Mobile

Expo (expo-router) mobile supervisor for Agent Orchestrator. Four tabs - Kanban,
PRs, Orchestrator, Settings - plus a spawn flow and a session screen. It talks to
your AO server's HTTP API over your LAN or Tailscale.

## Run

```bash
cd packages/mobile
npm install
npm start          # then press i (iOS), a (Android), or scan the QR in Expo Go
```

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
