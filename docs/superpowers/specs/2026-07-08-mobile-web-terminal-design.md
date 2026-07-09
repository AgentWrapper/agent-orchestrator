# Mobile web terminal — design

**Date:** 2026-07-08
**Status:** Draft for review
**Scope:** Give the `packages/mobile` Expo app a real, interactive terminal on its **web** target (react-native-web), replacing the "phone-only" placeholder panel. Full desktop-parity terminal surface + a remote-access proxy so a browser on a different machine than the daemon can connect.

---

## 1. Problem

`packages/mobile/app/session/[id].tsx` renders the session terminal with
`@fressh/react-native-xtermjs-webview` (xterm.js **inside** a `react-native-webview`).
On the web target Metro resolves `react-native-webview` to a stub whose entire render is
the string *"React Native WebView does not support this platform."*
(`node_modules/react-native-webview/lib/WebView.js`). So the web build shows that error
instead of a terminal.

An interim fix already landed: on web the screen shows a graceful "Terminal is phone-only"
panel and the preview uses a real `<iframe>` (`[id].tsx`, the `isWeb` branch). This spec
**replaces that panel with a working terminal.**

## 2. Why this is feasible (context)

- **Transport already exists and is platform-neutral.** `packages/mobile/lib/mux.ts` is a
  plain `WebSocket` client (`MuxClient`), already instantiated and wired in `[id].tsx`. It
  is not WebView-bound.
- **Protocol matches the daemon exactly.** Daemon mux is Go: `backend/internal/terminal/protocol.go`
  (`clientMsg` `ch/id/type/data/cols/rows`; `serverMsg` `ch/id/type/data/error`),
  dispatched in `backend/internal/terminal/manager.go` (`open`→openTerminal, `data`→base64
  StdEncoding decode→PTY, `resize`, `close`; emits `opened`/`data`/`exited`/`error`).
  `mux.ts` sends/reads all of these correctly. **No protocol work.**
  - Minor: the daemon ignores `projectId` (not a `clientMsg` field) — harmless, panes are
    keyed by `id`.
  - Minor: on reconnect `mux.ts` sends `open` without cols/rows; always follow `open` with a
    `resize` (the Electron client does this). Our wiring does.
- **A hardened browser reference exists.** `frontend/src/renderer/components/XtermTerminal.tsx`
  is a 595-line xterm.js surface running in Electron's Chromium DOM against this same daemon,
  bound to the mux by `frontend/src/renderer/hooks/useTerminalSession.ts`. This is the port
  source. (There is **no** lan-web app; the Electron renderer is the only browser terminal.)
- **xterm deps are vetted in-repo** at `frontend/package.json`: `@xterm/xterm ^5.5.0` plus
  addons `addon-fit ^0.10.0`, `addon-webgl ^0.19.0`, `addon-canvas ^0.7.0`,
  `addon-unicode11 ^0.9.0`, `addon-search ^0.15.0`, `addon-web-links ^0.11.0`.
- **Expo web is Metro** (`app.json` → `web.bundler: "metro"`), which supports global CSS
  imports, so `import "@xterm/xterm/css/xterm.css"` works. Web deps
  (`react-native-web@0.21.2`, `react-dom@19.1.0`, `@expo/metro-runtime@6.1.2`) are already
  installed (currently unlisted in `package.json`).

## 3. The Origin constraint (the crux of remote access)

The daemon guards **every** route, including the `/mux` WS upgrade, with
`corsMiddleware` (`backend/internal/httpd/cors.go`, registered `router.go:53`):

1. No `Origin` header → pass (why RN `fetch`, which sends none, works).
2. `Origin` present AND (in `AO_ALLOWED_ORIGINS` allowlist OR `isLoopbackOrigin`) → pass,
   echoes `Access-Control-Allow-Origin`.
3. Otherwise → **403 `ORIGIN_FORBIDDEN`**.

`isLoopbackOrigin` = scheme http/https with host `localhost` / `127.0.0.1` / `::1`.
`AO_ALLOWED_ORIGINS` replaces the default (`app://renderer`), comma-separated, **no wildcard**.

Consequences for a browser (browsers always send `Origin` on WS upgrades and cannot spoof it —
the `Origin: http://localhost` pin in `mux.ts:132` is inert in a browser):

- **Browser + daemon on the same machine** (web dev server at `http://localhost:8081`) →
  loopback → **works with zero daemon config.** Primary local path.
- **Browser on a different machine** (LAN IP / Tailscale host origin) → **403** unless that
  exact origin is in `AO_ALLOWED_ORIGINS`. `ao-phone-proxy` today is a raw TCP pipe and
  forwards the real Origin unchanged, so it does not help. **This is what the remote-access
  proxy (§6) solves.**

## 4. Architecture overview

Three independent pieces:

| Part | File(s) | Purpose |
|------|---------|---------|
| A. Web terminal surface | `lib/WebTerminal.web.tsx` (new), `lib/WebTerminal.native.tsx` (new stub) | xterm.js in the browser DOM, ported from the renderer |
| B. Screen wiring | `app/session/[id].tsx` (edit) | Route the existing mux I/O to the web terminal on web |
| C. Remote-access proxy | `packages/mobile/scripts/ao-phone-proxy.js` (rework) + README | HTTP-aware reverse proxy that rewrites Origin/CORS so a remote browser passes the daemon guard |

A and B make the terminal work **locally with zero config**. C is only needed for a remote
browser and is transport-level (no app change). They can be built and shipped independently.

## 5. Part A + B — the terminal

### A. `lib/WebTerminal.web.tsx` (port of `XtermTerminal.tsx`)

A React component that owns an xterm instance mounted into a real `<div>` (react-native-web
renders DOM; we use a plain `<div ref>` as we already do for the preview `<iframe>`). It
exposes an imperative handle and callbacks — the mux stays in `[id].tsx`.

Port the renderer's surface **at full parity**, adapting three Electron-isms:

- **Clipboard:** renderer uses `aoBridge.clipboard` (Electron IPC). Replace with the browser
  `navigator.clipboard` (`readText`/`writeText`) for copy-on-select and paste. Guard for
  absence (non-secure context) by falling back to the `ClipboardEvent` data already handled.
- **Link open:** renderer routes `window.open` through Electron's main process. In a browser
  `window.open(uri, "_blank", "noopener")` is native — keep the WebLinksAddon, drop the
  Electron routing comment.
- **Theme:** renderer pulls light/dark from `terminal-themes.ts` + `ui-store`. The mobile app
  is dark-only (`app.json userInterfaceStyle: "dark"`). Build **one** xterm theme from mobile
  tokens (`lib/theme.ts`: background `theme.term`, foreground `theme.textPrimary`, cursor
  `theme.orange`), matching the existing native `xtermOptions` in `[id].tsx`.

Keep at parity (mirror `XtermTerminal.tsx` closely):

- **Construction:** `allowProposedApi`, `cursorBlink`, `fontFamily` from `--font-mono`/mobile
  mono token, `fontSize` (prop), `lineHeight`, `drawBoldTextInBrightColors:false`,
  `minimumContrastRatio:4.5`, **`scrollback: 0`**. Rationale: the daemon panes are tmux-attach
  alt-buffer apps that own their own scrollback (renderer comment, lines 261-267); scrolling is
  driven by wheel→SGR/copy-mode, not xterm's local buffer. This is why parity ≠ the native
  mobile terminal's `scrollback:5000`.
- **Renderer:** WebGL addon with canvas fallback (`loadRenderer`), for correct box-drawing.
- **Addons:** `FitAddon`, `Unicode11Addon` (activeVersion "11"), `WebLinksAddon`, `SearchAddon`.
- **Fit machinery:** rAF + settle timeouts `[50,250,600,1200]` + `document.fonts.ready` +
  `ResizeObserver` + the `onRender` convergence loop + `window` resize. (Load-bearing on web:
  WebGL atlas and font metrics settle async.)
- **Input (NOT `term.onData`):** `term.onKey` for keystrokes, plus explicit paste,
  composition, wheel, and shortcut emitters, funneled through an `onUserInput` listener set —
  exactly as the renderer does, because raw `onData` leaks control-response bytes into the PTY
  and corrupts the TUI (renderer comment, lines 472-479).
- **Wheel → scroll:** `attachCustomWheelEventHandler` producing SGR wheel reports
  (`\x1b[<64/65;1;1M`) or PageUp/PageDown for `paneScrollsByKeyboard`, mirroring `deltaMode`
  handling. Ctrl/Cmd-wheel left for the font-size zoom.
- **Selection & copy:** `forceSelectionMode`, copy-on-select (deduped) via `navigator.clipboard`,
  copy/paste keyboard shortcuts (`isTerminalCopyShortcut`/`isTerminalPasteShortcut`), bracketed
  paste.

**Handle exposed** (via `useImperativeHandle` / `onReady`, adapting `AttachableTerminal`):
`write(bytes: Uint8Array)`, `writeln`, `clear`, live `cols`/`rows` getters,
`onUserInput(listener)`, `onResize(listener)`. `write(Uint8Array)` matches how `[id].tsx`
already calls `xtermRef.current?.write(bytes)`.

### `lib/WebTerminal.native.tsx` (stub)

`export default () => null` (+ the same handle type). Metro resolves `.native.tsx` on
iOS/Android, so **xterm and its DOM-only addons are never bundled into the native app**. Native
keeps `XtermJsWebView` unchanged.

### B. `app/session/[id].tsx` wiring

Adapt the binding `useTerminalSession.ts` performs, but using the existing `MuxClient`:

- Replace the web `isWeb` "phone-only" panel with `<WebTerminal>` behind a ref.
- **Output:** in the mux `onTerminalData` handler, route bytes to the web terminal's
  `write` on web (else `xtermRef` as today). Platform.OS is constant, so a simple
  `(isWeb ? webTermRef : xtermRef).current?.write(bytes)` is safe.
- **Ready/open:** WebTerminal `onReady(handle)` → `muxRef.current?.openTerminal(id, projectId)`
  then an immediate `resize` with the handle's cols/rows (mirrors native `onInitialized`).
- **Input:** `handle.onUserInput((data) => muxRef.current?.sendInput(id, data, projectId))`.
- **Resize:** `handle.onResize(({cols,rows}) => muxRef.current?.resize(id, cols, rows, projectId))`,
  debounced (as the renderer does, ~lines 239-248).
- **Re-enable** the dead/Restore overlay on web (revert the interim `!isWeb && dead` back to
  `dead`) — it is REST/store-based and works on web.
- **Suppress the phone-only keyboard chrome on web:** don't render the hidden RN `TextInput`
  (it would steal focus from xterm) and hide the `⌨` show/hide-keyboard key. The extra-keys
  bar (esc/tab/^C/arrows), compose/send, kill, zoom, and browser-preview toggle all call
  mux/REST and stay.

## 6. Part C — remote-access proxy (Origin/CORS rewrite)

Rework `packages/mobile/scripts/ao-phone-proxy.js` from a raw TCP pipe into an **HTTP-aware
reverse proxy** (Node built-ins only — `http` + `net`; no new deps), preserving its existing
TOFU device-pinning (first remote source IP wins; others rejected).

Behavior (listen `0.0.0.0:<proxyPort>` → upstream `127.0.0.1:<daemonPort>`):

- **REST (`http` request handler):**
  - Rewrite the incoming `Origin` header → `http://localhost` before forwarding upstream, so
    the daemon's guard sees a loopback origin and passes (§3 case 2).
  - Answer CORS **preflight `OPTIONS`** directly at the proxy: `204` with
    `Access-Control-Allow-Origin: <real request Origin>`, `-Allow-Methods`, `-Allow-Headers: *`,
    `-Max-Age`.
  - On the upstream response, **overwrite** `Access-Control-Allow-Origin` to the browser's
    **real** origin (and add `Vary: Origin`). This is required: the daemon echoes ACAO
    = `http://localhost` (the rewritten value), which the browser would reject because it must
    equal the real page origin. The proxy makes ACAO reflect the real origin so the browser
    accepts the response.
  - Stream request/response bodies; pass through method, path, status, other headers.
- **WebSocket `/mux` (`'upgrade'` handler):**
  - Rewrite the `Origin` header on the upgrade request → `http://localhost`, dial upstream,
    replay the modified handshake, then pipe both directions.
  - No ACAO rewrite needed: browsers do **not** apply the CORS response check to WebSocket
    upgrades (WS cross-origin is server-enforced via Origin only).
- **TOFU pinning:** applied on both the request handler and the upgrade socket via
  `remoteAddress`, keeping the current first-IP-wins semantics.

Usage for remote: user runs the proxy on the daemon machine and points the mobile web app's
configured `host:httpPort` at `<machine>:<proxyPort>`. Both REST and mux then traverse the
proxy. **Simpler documented alternative** (no proxy): set
`AO_ALLOWED_ORIGINS=http://<web-origin>` on the daemon. Both will be documented; the proxy is
the zero-daemon-config option this spec builds.

## 7. Dependencies & config

`packages/mobile/package.json`:

- Add: `@xterm/xterm ^5.5.0`, `@xterm/addon-fit ^0.10.0`, `@xterm/addon-webgl ^0.19.0`,
  `@xterm/addon-canvas ^0.7.0`, `@xterm/addon-unicode11 ^0.9.0`, `@xterm/addon-search ^0.15.0`,
  `@xterm/addon-web-links ^0.11.0` (match `frontend/`).
- Add the already-installed web deps for a correct fresh install, via
  `npx expo install react-dom react-native-web @expo/metro-runtime` (Expo picks compatible
  versions; currently `react-dom@19.1.0`, `react-native-web@0.21.2`, `@expo/metro-runtime@6.1.2`).
- Add script: `"web": "expo start --web"`.

No `metro.config.js`/`babel.config.js` changes (Expo defaults; CSS import supported).

## 8. Error handling

- **WebTerminal construction failure** (`new Terminal` throws) → `onError` to the screen,
  which surfaces the existing `banner`. Do not crash the route.
- **Mux disconnected on web** → existing status bar already renders `connecting/live/disconnected`
  from mux state; unchanged. On localhost the guard passes so it reads `live`. On a forbidden
  remote origin without the proxy, it reads `disconnected` (the 403'd upgrade) — the documented
  remote path (proxy or `AO_ALLOWED_ORIGINS`) resolves it.
- **Clipboard unavailable** (insecure context / permissions) → copy/paste degrade to the
  `ClipboardEvent`-based path and a console warning; never throw.
- **Proxy:** on upstream connection error, respond `502` (REST) / destroy the socket (WS);
  log. Rejected TOFU peers get the socket destroyed as today.

## 9. Testing / verification

- **Types:** `npm run typecheck` (tsc) in `packages/mobile`. `.web.tsx` compiles under DOM lib
  (already in `expo/tsconfig.base`).
- **Native unaffected:** confirm `.native.tsx` stub resolves and xterm is absent from a native
  bundle (grep the Metro output or reason via resolution).
- **Local web run:** `expo start --web` against a local daemon (`host: localhost:3001`); open a
  session and confirm: attach (status `live`), agent output renders, keyboard input reaches the
  PTY, box-drawing is crisp (WebGL), wheel scrolls the pane, copy-on-select + paste work, resize
  reflows and reports to the PTY, Restore works on a dead session.
- **Proxy:** run the proxy, point a second machine's browser at it, confirm a remote origin now
  opens the mux (WS) and REST calls succeed (ACAO reflects the real origin). A small Node
  self-check asserts Origin/ACAO rewrite on a mocked upstream.

## 10. Out of scope / deferred

- A dedicated in-terminal **search box UI** (SearchAddon is loaded for parity; wiring a find
  box is separate app chrome).
- Touch/gesture scrolling on web (desktop uses wheel; touch is the native app's concern).
- Auth/TLS changes to the daemon.
- Any change to the native (`XtermJsWebView`) terminal path.

## 11. Risks / open questions

- **`scrollback: 0` + SGR wheel** assumes the daemon panes are tmux-attach alt-buffer (per the
  renderer). If a mobile session ever attaches a plain PTY, wheel scrolling would need the
  `scrollback:5000` fallback. Verify against a live session during implementation.
- **WebGL in react-native-web** should behave (it is a browser canvas/WebGL context), but the
  canvas fallback covers headless/again-unavailable GPU contexts.
- **Proxy HTTP correctness** (keep-alive, chunked bodies, upgrade replay) is the fiddliest part;
  the plan will treat it as its own task with a self-check.
