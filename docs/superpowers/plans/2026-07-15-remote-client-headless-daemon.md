# Remote Client and Headless Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package a persistent remote-only Electron client that reaches the unchanged AO daemon on `claude` through an authenticated loopback forwarding proxy, then deploy the daemon as a user systemd service and install the client locally.

**Architecture:** The existing daemon runs unchanged under systemd and restores its authenticated `0.0.0.0:3011` LAN listener. A remote-client Electron build stores one server configuration and runs a main-process loopback proxy that injects the existing bearer password while forwarding HTTP, SSE, and WebSocket traffic unchanged; the renderer continues using its existing loopback daemon protocol.

**Tech Stack:** Go 1.25+ cross-compilation, systemd user services, Electron 33, Node HTTP/TCP primitives, React 19, TypeScript 5.6, Vitest 4, Electron Forge 7.

## Global Constraints

- Do not change daemon routes, DTOs, SSE events, WebSocket frames, terminal framing, or backend business services.
- Keep the primary listener on `127.0.0.1`; use only the existing authenticated LAN listener on `0.0.0.0:3011`.
- Keep the default desktop build unchanged; add a separate remote-client build target.
- Store all desktop state beneath `~/.ao/electron` and never persist an unencrypted desktop connection password.
- The remote client must never spawn, supervise, or shut down the remote daemon.
- Use Node built-ins for proxying; add no proxy dependency.

---

## File Map

- Create `frontend/src/main/remote-server-config.ts`: validation plus encrypted atomic persistence.
- Create `frontend/src/main/remote-server-config.test.ts`: storage and validation tests.
- Create `frontend/src/main/remote-forwarder.ts`: loopback HTTP/SSE/WebSocket forwarding.
- Create `frontend/src/main/remote-forwarder.test.ts`: real loopback upstream integration tests.
- Create `frontend/src/main/remote-client-runtime.ts`: proxy lifecycle and candidate configuration validation.
- Create `frontend/src/main/remote-client-runtime.test.ts`: lifecycle tests with injected config/proxy dependencies.
- Create `frontend/src/renderer/components/RemoteServerSettings.tsx`: first-run dialog and settings section.
- Create `frontend/src/renderer/components/RemoteServerSettings.test.tsx`: form behavior tests.
- Modify `frontend/src/preload.ts`: expose remote configuration IPC.
- Modify `frontend/src/main.ts`: remote-build detection, runtime wiring, and IPC registration.
- Modify `frontend/src/shared/daemon-status.ts`: reuse existing `not_configured` and `daemon_unreachable` codes; no wire change.
- Modify `frontend/src/renderer/routes/_shell.tsx`: avoid workspace preload until ready and mount the blocking setup dialog.
- Modify `frontend/src/renderer/components/GlobalSettingsForm.tsx`: render the connection settings section in remote builds.
- Modify `frontend/forge.config.ts`: omit daemon resource and add a remote build marker.
- Modify `frontend/package.json`: add `package:remote` and `make:remote` scripts.

---

### Task 1: Encrypted Remote Server Configuration

**Files:**
- Create: `frontend/src/main/remote-server-config.ts`
- Create: `frontend/src/main/remote-server-config.test.ts`

**Interfaces:**
- Produces: `RemoteServerConfig`, `RemoteServerConfigInput`, `readRemoteServerConfig`, `writeRemoteServerConfig`, `validateRemoteServerConfigInput`.
- Consumes: an injected encrypt/decrypt pair backed by Electron `safeStorage` in production.

- [ ] **Step 1: Write failing validation and persistence tests**

Cover missing host, non-integer/out-of-range port, empty password, encrypted round trip, missing file, corrupt file, and atomic replacement retention. The test encryptor must visibly transform bytes:

```ts
const crypto = {
	encrypt: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
	decrypt: (value: Buffer) => value.toString("utf8").replace(/^sealed:/, ""),
};
```

Assert the stored JSON contains `sealed:` in base64 form and does not contain the plaintext password.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd frontend && npm test -- --run src/main/remote-server-config.test.ts`

Expected: FAIL because `remote-server-config.ts` does not exist.

- [ ] **Step 3: Implement validated encrypted storage**

Define:

```ts
export type RemoteServerConfigInput = { host: string; port: number; password: string };
export type RemoteServerConfig = RemoteServerConfigInput & { updatedAt: string };
export type ConfigCrypto = {
	encrypt(value: string): Buffer;
	decrypt(value: Buffer): string;
};

export function validateRemoteServerConfigInput(input: RemoteServerConfigInput): RemoteServerConfigInput;
export async function readRemoteServerConfig(stateDir: string, crypto: ConfigCrypto): Promise<RemoteServerConfig | null>;
export async function writeRemoteServerConfig(
	stateDir: string,
	input: RemoteServerConfigInput,
	crypto: ConfigCrypto,
): Promise<RemoteServerConfig>;
```

Normalize `host.trim()`, require port `1..65535`, require a non-empty password, serialize `encryptedPassword` as base64, create the directory with mode `0700`, write a mode `0600` temporary file, and atomically rename it to `remote-server.json`.

- [ ] **Step 4: Run focused tests**

Run: `cd frontend && npm test -- --run src/main/remote-server-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the configuration unit**

```bash
git add frontend/src/main/remote-server-config.ts frontend/src/main/remote-server-config.test.ts
git commit -m "feat: persist encrypted remote server config"
```

### Task 2: Authenticated Loopback Forwarder

**Files:**
- Create: `frontend/src/main/remote-forwarder.ts`
- Create: `frontend/src/main/remote-forwarder.test.ts`

**Interfaces:**
- Consumes: `RemoteServerConfigInput` from Task 1.
- Produces: `startRemoteForwarder(config): Promise<RemoteForwarder>` where `RemoteForwarder` exposes `port` and `close()`.

- [ ] **Step 1: Write failing HTTP and SSE tests**

Start a real loopback upstream server. Assert a forwarded POST preserves path, query, body, and `Origin`, rewrites `Host`, and sets:

```ts
expect(request.headers.authorization).toBe("Bearer test-password");
```

For SSE, write one event, wait for the client to receive it before ending the upstream response, and prove the proxy did not buffer the stream.

- [ ] **Step 2: Write a failing WebSocket upgrade test**

Use a raw `net.Socket` client and upstream `http.Server` `upgrade` handler. Assert the upstream receives `Authorization: Bearer test-password`, returns `101 Switching Protocols`, and bytes flow in both directions after upgrade.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd frontend && npm test -- --run src/main/remote-forwarder.test.ts`

Expected: FAIL because `remote-forwarder.ts` does not exist.

- [ ] **Step 4: Implement the forwarder with Node built-ins**

Define:

```ts
export type RemoteForwarder = { port: number; close(): Promise<void> };
export async function startRemoteForwarder(config: RemoteServerConfigInput): Promise<RemoteForwarder>;
```

Use `http.createServer` and `http.request` for HTTP/SSE. Copy incoming headers, replace `host`, set `authorization`, pipe both bodies, and return JSON `502` on upstream connection failure before headers are sent. Handle `server.on("upgrade")` with an upstream `net.connect`, write the original upgrade request with replaced `Host` and injected `Authorization`, forward `head`, and pipe sockets bidirectionally. Bind with `server.listen(0, "127.0.0.1")`.

- [ ] **Step 5: Run focused tests**

Run: `cd frontend && npm test -- --run src/main/remote-forwarder.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the proxy unit**

```bash
git add frontend/src/main/remote-forwarder.ts frontend/src/main/remote-forwarder.test.ts
git commit -m "feat: add authenticated remote daemon forwarder"
```

### Task 3: Remote Client Runtime and Electron IPC

**Files:**
- Create: `frontend/src/main/remote-client-runtime.ts`
- Create: `frontend/src/main/remote-client-runtime.test.ts`
- Modify: `frontend/src/preload.ts`
- Modify: `frontend/src/main.ts`

**Interfaces:**
- Consumes: configuration storage from Task 1 and `startRemoteForwarder` from Task 2.
- Produces: `RemoteClientRuntime.start`, `getStatus`, `saveConfig`, `getConfig`, and `stop` plus preload `remoteServer.get/save/isRemoteClient`.

- [ ] **Step 1: Write failing runtime lifecycle tests**

Inject fake read/write, proxy start, and probe functions. Cover:

```ts
await runtime.start(); // missing config -> { state: "error", code: "not_configured" }
await runtime.saveConfig(candidate); // probe succeeds -> persist, swap proxy, ready status
await runtime.saveConfig(badCandidate); // probe fails -> old proxy/config remain active
await runtime.stop(); // closes local proxy only
```

Assert status listeners receive the ready proxy port and no method exposes the stored password.

- [ ] **Step 2: Run focused test and verify failure**

Run: `cd frontend && npm test -- --run src/main/remote-client-runtime.test.ts`

Expected: FAIL because the runtime module does not exist.

- [ ] **Step 3: Implement the runtime**

The candidate probe calls `http://127.0.0.1:<candidate-proxy-port>/healthz` with a five-second timeout and validates the existing AO `service` identity. Start and validate a replacement before closing the old proxy. Map missing config to `not_configured`, connection/probe errors to `daemon_unreachable`, and successful validation to `{ state: "ready", port: proxy.port }`.

- [ ] **Step 4: Add preload IPC types**

Expose:

```ts
remoteServer: {
	isRemoteClient: () => ipcRenderer.invoke("remoteServer:isRemoteClient") as Promise<boolean>,
	get: () => ipcRenderer.invoke("remoteServer:get") as Promise<{ host: string; port: number } | null>,
	save: (input: RemoteServerConfigInput) =>
		ipcRenderer.invoke("remoteServer:save", input) as Promise<DaemonStatus>,
}
```

Do not return the saved password from `get`.

- [ ] **Step 5: Wire remote mode in Electron main**

When the packaged remote marker exists or `AO_REMOTE_CLIENT=1` is set in development:

- construct `RemoteClientRuntime` with `safeStorage.encryptString/decryptString`;
- route `daemon:getStatus`, `daemon:start`, and `daemon:stop` to the runtime;
- register `remoteServer:*` IPC handlers;
- skip bundled daemon resolution, spawning, supervisor linking, and exit-time daemon killing; and
- stop only the local proxy during app shutdown.

Keep the existing local daemon branch byte-for-byte operational for normal builds.

- [ ] **Step 6: Run focused and main-process tests**

Run: `cd frontend && npm test -- --run src/main/remote-client-runtime.test.ts src/main/daemon-owner.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit runtime wiring**

```bash
git add frontend/src/main/remote-client-runtime.ts frontend/src/main/remote-client-runtime.test.ts frontend/src/preload.ts frontend/src/main.ts
git commit -m "feat: wire remote client daemon runtime"
```

### Task 4: Persistent Connection UI

**Files:**
- Create: `frontend/src/renderer/components/RemoteServerSettings.tsx`
- Create: `frontend/src/renderer/components/RemoteServerSettings.test.tsx`
- Modify: `frontend/src/renderer/lib/bridge.ts`
- Modify: `frontend/src/renderer/routes/_shell.tsx`
- Modify: `frontend/src/renderer/components/GlobalSettingsForm.tsx`

**Interfaces:**
- Consumes: preload `remoteServer` API from Task 3 and existing daemon status notifications.
- Produces: a blocking first-run dialog and an editable global-settings section.

- [ ] **Step 1: Write failing component tests**

Test that remote mode with no config opens a non-dismissible dialog, validates host/port/password, submits all three fields, displays a rejected save error, and closes after a ready result. Test that the settings variant loads saved host/port, leaves password blank, and requires password only when saving a changed configuration.

- [ ] **Step 2: Run focused component tests and verify failure**

Run: `cd frontend && npm test -- --run src/renderer/components/RemoteServerSettings.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the connection form**

Use existing `Dialog`, `Input`, `Label`, and `Button` primitives. Fields are `Server IP or hostname`, `Port`, and `Connection password`. The submit handler calls `aoBridge.remoteServer.save`; it renders `status.message` for non-ready responses and clears the password field after success.

- [ ] **Step 4: Mount first-run and settings surfaces**

In `_shell.tsx`, make the loader call `refreshDaemonStatus()` and fetch workspace data only when status is ready. Mount the blocking form when remote mode is true and status code is `not_configured`. In `GlobalSettingsForm`, render the settings variant only for remote builds. Add the browser-preview fallback methods in `bridge.ts` so tests remain typed.

- [ ] **Step 5: Run focused renderer tests**

Run: `cd frontend && npm test -- --run src/renderer/components/RemoteServerSettings.test.tsx src/renderer/hooks/useDaemonStatus.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the UI**

```bash
git add frontend/src/renderer/components/RemoteServerSettings.tsx frontend/src/renderer/components/RemoteServerSettings.test.tsx frontend/src/renderer/lib/bridge.ts frontend/src/renderer/routes/_shell.tsx frontend/src/renderer/components/GlobalSettingsForm.tsx
git commit -m "feat: add persistent remote server settings"
```

### Task 5: Remote-only Package Flavor

**Files:**
- Modify: `frontend/forge.config.ts`
- Modify: `frontend/package.json`
- Test: `frontend/forge.config.test.ts` if configuration extraction is needed for deterministic assertions.

**Interfaces:**
- Consumes: `AO_REMOTE_CLIENT=1` at package time.
- Produces: an app bundle containing `remote-client.json` and no `Resources/daemon` directory.

- [ ] **Step 1: Add remote package scripts**

Add:

```json
"package:remote": "AO_REMOTE_CLIENT=1 electron-forge package",
"make:remote": "AO_REMOTE_CLIENT=1 electron-forge make"
```

These scripts deliberately bypass the existing `prepackage`/`premake` daemon build lifecycle because their names have distinct npm pre-hooks.

- [ ] **Step 2: Make Forge resources conditional**

When `AO_REMOTE_CLIENT === "1"`, generate `remote-client.json` in `prePackage`, omit `daemon` from `extraResource`, and include the marker. For normal builds, remove any stale marker before packaging and retain the current resource list unchanged.

- [ ] **Step 3: Run typecheck and package the remote app**

Run:

```bash
cd frontend
npm run typecheck
npm run package:remote
```

Expected: typecheck passes and Forge creates `out/Agent Orchestrator-darwin-arm64/Agent Orchestrator.app`.

- [ ] **Step 4: Verify package contents**

Run:

```bash
test -f "frontend/out/Agent Orchestrator-darwin-arm64/Agent Orchestrator.app/Contents/Resources/remote-client.json"
test ! -e "frontend/out/Agent Orchestrator-darwin-arm64/Agent Orchestrator.app/Contents/Resources/daemon"
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit package flavor**

```bash
git add frontend/forge.config.ts frontend/package.json
git commit -m "build: add remote-only desktop package"
```

### Task 6: Full Verification, Remote Deployment, and Local Installation

**Files:**
- No repository files. Deployment artifacts and secrets remain outside Git.

**Interfaces:**
- Consumes: tested source tree and remote package from Tasks 1-5.
- Produces: persistent service on `claude` and installed remote client on the local Mac.

- [ ] **Step 1: Run repository verification**

Run:

```bash
npm run lint
npm run frontend:typecheck
cd frontend && npm test && npm run package:remote
```

Expected: all commands pass.

- [ ] **Step 2: Cross-compile and upload the daemon**

Run from `backend/`:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/ao-linux-amd64 ./cmd/ao
ssh claude 'mkdir -p ~/.local/bin'
scp /tmp/ao-linux-amd64 claude:/home/claude/.local/bin/ao.new
ssh claude 'chmod 0755 ~/.local/bin/ao.new && mv ~/.local/bin/ao.new ~/.local/bin/ao'
```

Expected: `ssh claude '~/.local/bin/ao version'` runs the uploaded Linux binary.

- [ ] **Step 3: Install and start the user systemd service**

Install `~/.config/systemd/user/ao-daemon.service` with:

```ini
[Unit]
Description=Agent Orchestrator daemon
After=network-online.target

[Service]
Type=simple
ExecStart=/home/claude/.local/bin/ao daemon
Restart=on-failure
RestartSec=2
Environment=AO_DATA_DIR=/home/claude/.ao

[Install]
WantedBy=default.target
```

Then run `systemctl --user daemon-reload && systemctl --user enable --now ao-daemon.service`.

- [ ] **Step 4: Enable and verify the existing LAN listener**

From the remote host, call:

```bash
curl -fsS -X POST http://127.0.0.1:3001/api/v1/mobile/enable
```

Capture the returned connection password for local configuration without printing it in the final response. Verify `ss -ltn` shows `0.0.0.0:3011`, an unauthenticated `GET /api/v1/sessions` returns `401`, and the same request with the password returns `200`.

- [ ] **Step 5: Install the verified Mac application**

Quit the current app, move the current `/Applications/Agent Orchestrator.app` to a timestamped backup under `/Users/czg/.ao/staging`, copy the verified remote app into `/Applications`, and launch it with `open -a "Agent Orchestrator"`.

- [ ] **Step 6: Configure and verify end to end**

Enter `192.168.2.29`, port `3011`, and the generated password. Verify project/session REST data loads, the SSE connection reports connected, and a session terminal attaches over `/mux`. Quit and reopen the app; verify it reconnects without asking for configuration.

- [ ] **Step 7: Prove daemon persistence**

Quit the desktop app, wait longer than the existing five-second supervisor grace, and run:

```bash
ssh claude 'systemctl --user is-active ao-daemon.service && curl -fsS http://127.0.0.1:3001/healthz'
```

Expected: service is `active` and health returns the AO daemon identity.
