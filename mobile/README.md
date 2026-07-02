# AO Mobile

A phone remote-control for **Agent Orchestrator (AO)** — the project this folder
lives inside. Triage your fleet on a Kanban board, open a **live terminal** for any
session and drive it, review and merge PRs, and launch/open orchestrators — from
your phone, over your LAN or Tailscale.

This is an [Expo](https://expo.dev) (React Native) app. It lives in the AO monorepo
at `mobile/` but is a **standalone npm project** — it is _not_ part of AO's pnpm
workspace. Run all commands below from inside `mobile/`.

## Requirements — Expo Go is pinned to SDK 54

> [!IMPORTANT]
> **The Expo Go app supports only ONE Expo SDK at a time** (whatever the latest
> store build targets). This project is **pinned to Expo SDK 54** to match the
> Expo Go currently installed on the test phone. If your Expo Go shows
> _"Project is incompatible with this version of Expo Go"_, your Expo Go and this
> project's SDK don't match.
>
> - **Don't bump the Expo SDK** unless your Expo Go has updated to that SDK. When
>   you do upgrade, run `npx expo install expo@^<new> && npx expo install --fix`.
> - When writing code, read the **v54** docs: <https://docs.expo.dev/versions/v54.0.0/>
>   (the API changes between SDKs — don't trust older/newer snippets).

Pinned versions: `expo 54`, `react 19.1.0`, `react-native 0.81.5`,
`expo-router 6`, `react-native-webview 13.15.0`. `react`/`react-native-webview`
are pinned exactly to `@fressh`'s peer requirements (see `.npmrc`:
`legacy-peer-deps=true`).

## Run it (Expo Go)

```bash
cd mobile
npm install
npx expo start
```

Scan the QR with **Expo Go** (Android: scan in the app; iOS: scan with the Camera
app). Phone and PC must be on the same Wi-Fi. If they aren't, use
`npx expo start --tunnel`. Edits hot-reload on the device.

### Preview the UI in a browser (no phone)

```bash
npx expo start --web
```

Every screen renders in the browser **except the terminal** (it's a native
WebView — device only). Note: browser **CORS** blocks the cross-origin REST calls
to AO, so the web preview shows empty/"couldn't reach server" data — that's a
browser-only limit; on a real device (native fetch, no CORS) the data loads.

## First-run setup

Open the **Settings** tab and enter your AO server:

- **Host** — your PC's LAN IP (e.g. `192.168.x.x`) or Tailscale name / `100.x`.
- **API port** — AO's dashboard (Next.js). Default `3000`, but AO often runs on
  **`3001`** when another app holds `3000`.
- **Terminal port** — AO's mux/terminal WebSocket, `14801`.
- **Use TLS** — leave **off** for plain LAN/Tailscale (AO serves http/ws). Only
  turn on if AO is behind HTTPS (proxy / Tailscale funnel).

Tap **Test connection**, then **Save**.

## Server side (AO) checklist

- The terminal WebSocket (`:14801`) already binds all interfaces — reachable over
  LAN/Tailscale out of the box.
- The REST API must be reachable too. If a connection test fails, start AO's web
  server bound to all interfaces (`HOSTNAME=0.0.0.0`) and confirm phone + PC are on
  the same network/tailnet.
- AO's API has **no auth** — your network (LAN/Tailscale) is the boundary. Don't
  expose these ports to the public internet.

## What's inside

```
app/
  _layout.tsx            Root Stack: tabs + pushed terminal + spawn modal; wraps <AppProvider>
  (tabs)/
    _layout.tsx          Bottom tab bar (Kanban · PRs · Orchestrator · Settings)
    index.tsx            Kanban board — sessions grouped by AO attention level
    prs.tsx              Pull requests — filter, merge, open
    orchestrator.tsx     Per-project orchestrator: status, worker zones, open/spawn
    settings.tsx         Server config + projects list
  session/[id].tsx       Live terminal (xterm.js in a WebView) + keys + send + Kill
  spawn.tsx              New-agent modal (pick project + optional task)
lib/
  config.ts              Server config (AsyncStorage), http/ws URL builders, TLS flag
  api.ts                 AO REST client (sessions, spawn, merge, kill, restore, send)
  mux.ts                 AO mux WebSocket client (terminal I/O + live session snapshots)
  store.tsx              <AppProvider> — one shared mux socket + REST, app-wide state
  theme.ts               AO "Mission Control" palette + status/attention helpers
  ui.tsx                 Shared primitives (Dot, Chip, Pill, Card, Button, ScreenHeader…)
  SessionCard.tsx        A session card for the board
  ProjectSwitcher.tsx    Multi-project pill switcher
assets/                  App icon / splash / favicon / header mascot (AO brand)
```

Terminal rendering uses
[`@fressh/react-native-xtermjs-webview`](https://www.npmjs.com/package/@fressh/react-native-xtermjs-webview)
(MIT). Design language mirrors AO's `DESIGN.md`.
