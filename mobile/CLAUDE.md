# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

# AO Mobile — project guide

A phone remote-control for **Agent Orchestrator (AO)**, the monorepo this folder
lives in. It mirrors the AO web dashboard for a phone: a Kanban board of agent
sessions, a live controllable terminal per session, PR review/merge, and
orchestrator launch/open — over LAN or Tailscale.

## Location & tooling

- Lives at `ao-fork/mobile/` **but is a standalone npm + Expo project**, NOT part of
  AO's pnpm workspace (`pnpm-workspace.yaml` only globs `packages/*`). Run
  `npm install` / `npx expo start` **from inside `mobile/`** — never `pnpm` here.
- `.npmrc` has `legacy-peer-deps=true` because `@fressh` pins exact peer versions.
- TypeScript, file-based routing via **expo-router**. Dark-only.

## Expo SDK is pinned to 54 — do not bump

Expo Go supports a **single** SDK at a time. This app is pinned to **SDK 54** to
match the test phone's Expo Go. Symptoms of a mismatch: _"incompatible with this
version of Expo Go."_ Don't change the SDK unless the user's Expo Go updated.
Read **v54** docs (<https://docs.expo.dev/versions/v54.0.0/>) — APIs differ by SDK.
Pinned: `expo 54`, `react 19.1.0`, `react-native 0.81.5`, `expo-router 6`,
`react-native-webview 13.15.0` (react + webview match `@fressh` peers exactly).

## How it connects to AO

AO's web dashboard is `ao-fork/packages/web` (Next.js). This app talks to that
server two ways, configured in the **Settings** tab (`host` + ports, persisted via
AsyncStorage in `lib/config.ts`):

1. **REST API** (`http://<host>:<apiPort>`, default `3000` — but AO often runs on
   **`3001`** when something holds 3000). Client: `lib/api.ts`. Endpoints used:
   - `GET /api/sessions?project=all` → `{ sessions[], orchestrators[], orchestratorId, stats }`
   - `GET /api/projects` → `{ projects[] }`
   - `POST /api/spawn` `{ projectId, prompt?, issueId? }` — new worker
   - `POST /api/orchestrators` `{ projectId, clean? }` — launch/relaunch orchestrator
   - `POST /api/sessions/:id/kill | /restore | /send` `{ message }`
   - `POST /api/prs/:number/merge?owner=&repo=` — squash-merge
2. **Mux WebSocket** (`ws://<host>:<muxPort>/mux`, default `14801`). Client:
   `lib/mux.ts`. One multiplexed socket carries:
   - **Terminal I/O**: `{ch:'terminal', id, type:'open'|'data'|'resize'|'close', projectId?}`
     out; `data`/`opened`/`exited`/`error` in. (`id` = AO session id; `projectId`
     disambiguates across projects.)
   - **Live session snapshots**: `{ch:'subscribe', topics:['sessions','notifications']}`
     → periodic `{ch:'sessions', type:'snapshot', sessions:[SessionPatch]}` (id,
     status, activity, attentionLevel, lastActivityAt).
   - Heartbeat `{ch:'system', type:'ping'}`; auto-reconnect with backoff.

**No auth** — AO's API is unauthenticated; the network (LAN/Tailscale) is the
boundary. `lib/config.ts` builds `http`/`ws` (or `https`/`wss` when the TLS flag is
on) and strips any scheme the user pastes into Host.

The **attention levels** (merge / respond / review / pending / working / done) and
the **Mission Control palette** (bg `#0a0b0d`, blue `#4d8dff` = conductor, orange
`#f59f4c` = working agent, amber/red/green states) mirror AO's `DESIGN.md`.

## Architecture

- **`lib/store.tsx` (`<AppProvider>`)** is the heart: opens **one shared mux socket**
  (live session patches) + a periodic REST poll, merges them (patches are
  authoritative for live fields; snapshot-only sessions are surfaced immediately),
  and exposes everything via `useApp()` plus `useVisibleSessions()` / `usePRs()`.
  All actions (spawn, merge, kill, restore, send, launchConductor) live here. The
  context value is memoized; consumers re-render only on real changes.
- **Screens** consume the store. Board groups by `attentionOf(session)`; the
  Orchestrator tab lists every project's orchestrator (open if a link exists, else
  spawn).
- **Terminal** (`app/session/[id].tsx`) opens its **own** MuxClient for terminal I/O
  (a known duplication vs the store's socket — a deferred refactor).

## The terminal (xterm.js in a WebView) — read before touching

`@fressh/react-native-xtermjs-webview` runs xterm.js inside `react-native-webview`.
Hard-won constraints (don't relearn them the hard way):

- **Keyboard is RN-controlled, not the WebView's.** The injected JS disables the
  WebView's hidden textarea so a tap can't raise a keyboard; a hidden RN
  `<TextInput>` is the real keyboard (focus/blur via the ⌨ button), and `onKeyPress`
  → mux `sendInput`. This is why single-tap doesn't open the keyboard and the
  terminal resizes above the keyboard.
- **Scroll**: inject `.xterm-screen{pointer-events:none}` so drags fall through the
  selection canvas to native momentum scroll. Custom touch-scroll handlers do NOT
  work (xterm's selection auto-scroll is timer-based).
- **Sizing is measured, not guessed**: the WebView's FitAddon fits on container
  resize and reports real cols/rows back through fressh's **`debug → logger.log`**
  channel; RN forwards them to the PTY. **Never** pass `onMessage` via
  `webViewOptions` — fressh spreads user options after its own `onMessage`, so it
  **clobbers the bridge** and breaks the terminal. Use the `logger` prop.
- `window.terminal` / `window.fitAddon` are exposed; injected JS reaches the WebView
  via `webViewOptions.injectedJavaScript`.

## Dev & test workflow

- **Claude verifies the UI on Expo Web** (`npx expo start --web`) with the
  chrome-devtools MCP at a phone viewport. The **terminal does not render on web**
  (native WebView), and browser **CORS blocks REST** to AO — so use a `fetch` shim
  in an `initScript` to mock `/api/*` when checking populated screens.
- **The user tests the terminal + keyboard on a physical iPhone via Expo Go** — only
  they can verify WebView behavior. Don't claim terminal/keyboard fixes are
  verified; ask them to confirm on device.
- After changes: `npx tsc --noEmit` must be clean.

## Conventions

- Match the existing screen structure: `ScreenHeader` (title + AO mascot) → optional
  `ProjectSwitcher` → list/scroll. Reuse `lib/ui.tsx` primitives and `lib/theme.ts`
  helpers (`statusVisual`, `attentionMeta`, `ciVisual`) — don't re-derive colors
  inline. Color is rationed (it always means something); the card is the only
  bordered surface.
