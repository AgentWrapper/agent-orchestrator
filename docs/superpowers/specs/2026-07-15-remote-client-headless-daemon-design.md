# Remote Client and Headless Daemon Design

Date: 2026-07-15
Status: Approved for implementation

## Goal

Run the existing AO daemon persistently on the internal-network host available as
`ssh claude`, while installing a desktop client on the local Mac that connects to
that daemon through configurable host, port, and connection-password settings. The
remote client must browse and select project directories on the daemon host instead
of opening a local filesystem picker. Closing or powering off the local Mac must not
stop the remote daemon or its agent sessions.

The change must preserve the existing daemon REST, SSE, WebSocket, terminal, session,
agent, workspace, storage, and mobile implementations except for one additive,
read-only directory-listing route. The desktop renderer must continue to communicate
with what it sees as a loopback daemon.

## Non-goals

- Do not change existing daemon API routes, DTOs, SSE events, WebSocket frames, or
  terminal framing. Add only the directory-listing route defined below.
- Do not change session, agent, Git worktree, preview, SQLite, or mobile behavior.
- Do not add TLS, users, roles, device management, file upload, file content access,
  preview proxying, or client/server version negotiation.
- Do not expose the unauthenticated primary listener beyond `127.0.0.1`.
- Do not change the default desktop release build. Add a separate remote-client build.

## Architecture

The remote daemon keeps both existing listeners:

```text
claude server
  127.0.0.1:3001  existing unauthenticated control and CLI listener
  0.0.0.0:3011    existing authenticated Connect Mobile LAN listener
```

The remote desktop build runs a forwarding proxy inside the Electron main process:

```text
existing Electron renderer
  -> http://127.0.0.1:<ephemeral-proxy-port>
  -> Electron main-process forwarding proxy
  -> http://<configured-host>:<configured-port>
  -> existing LAN listener
```

The proxy injects the configured connection password as the existing
`Authorization: Bearer <password>` header. It forwards normal HTTP responses, SSE
streams, and WebSocket upgrades without interpreting or changing their AO payloads.

The renderer continues receiving an existing `DaemonStatus` containing a loopback
proxy port. Existing API rebasing, SSE, terminal mux, query invalidation, and xterm
code therefore remain unchanged.

## Remote Daemon Deployment

The current `ao daemon` command already supports headless execution. Its supervisor
only arms after a frontend supervisor connection has been accepted. A daemon started
directly by systemd receives no such connection and does not stop merely because a
desktop client disconnects.

Deployment performs these operations:

1. Cross-compile the current Go `ao` binary for Linux x86-64 on the local Mac.
2. Upload it to `/home/claude/.local/bin/ao`.
3. Install a user-level `ao-daemon.service` that executes `ao daemon`, restarts on
   failure, and uses `/home/claude/.ao` for state.
4. Start the service and call the existing loopback
   `POST /api/v1/mobile/enable` endpoint once. The existing bridge service generates
   and persists the connection password and enables `0.0.0.0:3011`.
5. Record the returned password for initial desktop configuration without committing
   or logging it into repository files.

The remote account already has systemd user services and lingering enabled, so the
service survives SSH logout. The service unit does not depend on a graphical login.

## Remote Desktop Build

Add a separate remote-client build target. The normal desktop build and distribution
remain unchanged. The remote target:

- does not build or package the Go daemon resource;
- starts only the Electron-local forwarding proxy;
- never spawns a daemon process;
- never opens a daemon supervisor link;
- never calls the remote `/shutdown` route when the app exits; and
- keeps local-only Electron features such as updates, notifications, clipboard,
  external links, and BrowserView behavior.

The remote mode is selected at build time, not by an end-user runtime toggle. The Mac
installed for this task is built with remote mode enabled.

## Connection Configuration

The remote client stores one server configuration under Electron's existing AO-owned
user-data directory, which resolves beneath `~/.ao/electron`:

```text
host
port
encrypted connection password
updated timestamp
```

Host and port are stored as ordinary JSON values. The password is encrypted with
Electron `safeStorage` before serialization. If secure storage is unavailable, the
save operation fails instead of writing a new plaintext desktop credential.

Writes use a temporary file and atomic rename. The configuration is loaded on every
app start. A valid saved configuration starts the proxy and connects automatically,
so the user does not re-enter it.

When no configuration exists, the renderer presents a blocking connection dialog.
The same form is available from global settings for later changes. It contains host,
port, and connection password fields. Saving first tests the candidate through a
temporary proxy. Only a successful authenticated health request replaces the active
and persisted configuration.

Invalid input, an unreachable server, `401`, and `429` remain distinct errors. A
failed edit does not overwrite the last working configuration.

## Forwarding Proxy

The proxy binds only to `127.0.0.1` on an OS-assigned port. It uses Node's built-in
HTTP and networking primitives; no general public proxy listener is created.

For HTTP and SSE requests, it:

- preserves method, path, query, request body, and safe request headers;
- replaces the upstream `Host` header with the configured target host and port;
- sets the existing bearer `Authorization` header;
- streams request and response bodies without buffering SSE; and
- returns a stable local `502` response when the upstream connection fails.

For WebSocket upgrades, it forwards the original upgrade request and injects the same
bearer header before piping both sockets. It does not inspect WebSocket frames.

The password is held in the Electron main process except while the trusted settings
form is open. The form receives it through IPC, renders it as a masked password, and
offers an explicit reveal control. It is never exposed to query parameters,
telemetry, access logs, local storage, or error messages.

Changing configuration starts and validates a replacement proxy before stopping the
current proxy. App shutdown closes only the proxy and its sockets.

## Existing Feature Behavior

This design deliberately does not reinterpret features that previously assumed the
desktop and daemon shared a filesystem or network namespace. Existing requests and
responses continue unchanged. Features work when their existing server-side paths and
preview addresses are valid from the deployed topology; no new compatibility layer is
added in this task.

Project and workspace creation are the required exception: a remote-client build
replaces the native client folder picker with a server-side directory browser. The
submitted path still uses the existing project API and existing server validation.

## Remote Filesystem Browser

The daemon adds one read-only app route:

```text
GET /api/v1/filesystem/directories?path=<absolute-path>
```

Omitting `path` starts at the daemon process user's home directory. An explicit path
must be absolute and is cleaned before use. The response contains the cleaned current
path, its parent (`null` at the filesystem root), and child directories:

```json
{
  "path": "/home/claude",
  "parent": "/home",
  "directories": [
    { "name": "code", "path": "/home/claude/code" }
  ]
}
```

The route may browse `/` and every directory the daemon process user can access. It
does not impose an application-level root or allowlist, elevate privileges, read file
contents, return regular files, or mutate the filesystem. Hidden directories are
included. Symbolic links that resolve to directories are included and remain expressed
by their visible path. Directory names are sorted case-insensitively with a stable
case-sensitive tie-breaker.

The route returns the standard API error envelope with these codes:

- `ABSOLUTE_PATH_REQUIRED` (`400`) for a non-absolute explicit path;
- `DIRECTORY_PERMISSION_DENIED` (`403`) when the process cannot read the directory;
- `DIRECTORY_NOT_FOUND` (`404`) when the path does not exist;
- `NOT_A_DIRECTORY` (`422`) when the path is not a directory; and
- `DIRECTORY_READ_FAILED` (`500`) for other operating-system failures.

It is a normal app API route, so the existing loopback listener serves it without
authentication and the existing LAN listener serves it only behind `authMiddleware`.
It is not a control route and is not available without the LAN bearer password.

The remote-client dialog keeps an editable absolute-path field and adds a breadcrumb,
an up action, a loading/error state, child-directory rows, and a `Select this folder`
action. Opening the dialog loads the remote home directory. Entering an absolute path
and submitting navigates to it; selecting a child navigates into it. Selecting the
current directory continues through the existing agent-selection and project creation
flow. Local builds continue using the native folder picker unchanged.

The mobile app continues connecting directly to the existing authenticated LAN
listener and is not routed through the desktop proxy.

## Testing

Focused automated tests cover:

- configuration validation, encrypted persistence, reload, and failed-save retention;
- remote build mode never spawning a local daemon or supervisor connection;
- HTTP method/body/header forwarding and bearer injection;
- SSE response streaming without buffering;
- WebSocket upgrade forwarding and bidirectional frames;
- upstream connection failure mapping to the local unavailable state;
- proxy replacement and shutdown behavior;
- masked saved-password display and explicit reveal behavior;
- directory listing for home, root, hidden directories, and symbolic links;
- invalid, missing, non-directory, permission, and unexpected filesystem errors;
- OpenAPI route/spec parity and generated TypeScript contract drift; and
- remote directory navigation and project creation without invoking the native folder picker.

Existing backend and frontend tests, frontend typecheck, lint, OpenAPI drift checks,
and the remote package build must pass.

Deployment verification checks:

1. `ao-daemon.service` is active and enabled for the remote user.
2. `127.0.0.1:3001/healthz` responds on the server.
3. `0.0.0.0:3011` is listening and rejects missing credentials.
4. Authenticated API access succeeds through the installed desktop proxy.
5. REST project/session data, SSE invalidation, and terminal WebSocket attachment work.
6. The authenticated directory API can browse `/`, the daemon user's home, and a
   nested project directory on the remote host.
7. The installed remote client selects a remote directory without opening Finder.
8. The saved configuration reconnects after quitting and reopening the desktop app.
9. The remote service and sessions remain active after the desktop app exits.

## Installation Result

The local Mac receives the packaged remote-client application in `/Applications`.
The prior application is replaced only after the new package builds and passes local
verification. The remote Linux service and its password remain outside the repository.
