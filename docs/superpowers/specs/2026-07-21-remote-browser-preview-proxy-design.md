# Remote Browser Preview Proxy Design

Date: 2026-07-21
Status: Approved

## Goal

Make the existing Browser panel and page-annotation workflow work when the Electron
Remote client runs on a different machine from the AO daemon and worker sessions.
The result must support:

- workspace HTML and Markdown previews already served by the daemon;
- worker development servers bound to `localhost`, `127.0.0.1`, `0.0.0.0`, or
  loopback IPv6 on the daemon host;
- normal HTTP navigation, same-origin assets, fetch/XHR, forms, redirects, and
  WebSocket upgrades used by development-server HMR; and
- the existing element-selection annotation flow and message delivery to the worker.

The implementation reuses the current authenticated Remote connection. Users do not
configure SSH, expose development ports on the LAN, or enter another credential.

## Non-goals

- Do not change existing REST DTOs, SSE events, terminal WebSocket frames, session
  persistence, or browser-annotation message formatting.
- Do not proxy arbitrary LAN or internet addresses through the daemon.
- Do not turn the preview proxy into a general-purpose TCP tunnel.
- Do not change the independent Reviews tab or reviewer runtime.
- Do not add a new listener or expose the unauthenticated primary listener beyond
  `127.0.0.1`.

## Current Failure

The Remote client forwards renderer API traffic through a local ephemeral port to the
authenticated LAN listener, but Browser previews bypass that forwarder. A preview URL
stored as `http://127.0.0.1:3001/...` or `http://localhost:5173` is loaded directly by
the Mac Electron `WebContentsView`, so loopback names refer to the Mac instead of the
daemon host. A `file:///home/ubuntu/...` URL similarly refers to the Mac filesystem.

The annotation transport itself is already remote-safe: after an element is selected,
the renderer posts the formatted message through the normal session send API. The
missing boundary is preview content transport.

## Architecture

The Remote client continues to expose one ephemeral loopback forwarder. It gains a
preview-routing mode in addition to its existing transparent daemon API mode.

For each Browser navigation, Electron main classifies the target:

1. Public or LAN-reachable `http` and `https` URLs remain unchanged.
2. Loopback HTTP(S) targets and daemon-generated loopback preview-file URLs are
   registered with the local forwarder and rewritten to an opaque per-session
   `*.ao-preview.localhost` origin on the same ephemeral port.
3. `file` targets are registered the same way, but the daemon accepts them only when
   the selected file is inside that session's workspace.
4. The normal desktop build keeps its current direct-navigation behavior.

Using a dedicated local hostname, instead of a path prefix, preserves root-relative
asset URLs and gives each preview an isolated browser origin. Requests such as
`/assets/app.js`, fetch calls, form submissions, and WebSocket connections therefore
return to the local forwarder without application-specific HTML rewriting.

The local forwarder keeps an in-memory mapping from an unguessable preview hostname to
the session ID and normalized target. It never places the raw target or connection
password in the browser URL. For preview traffic it:

- rewrites the upstream path to the daemon's additive preview-proxy route;
- overwrites internal target/session headers from its own mapping;
- injects the existing LAN bearer password exactly as it does for daemon API traffic;
- forwards HTTP request bodies and response streams without buffering;
- preserves WebSocket upgrade and bidirectional frames; and
- rewrites target-origin redirect locations back to the local preview origin and
  removes target-only cookie domains so preview cookies remain scoped to that origin.

The daemon mounts an additive transport route outside the versioned JSON API namespace
because it accepts arbitrary HTTP methods, streaming bodies, and WebSocket upgrades.
The existing LAN authentication middleware still wraps this route. The route resolves
the session, validates the forwarded target, and then serves or reverse-proxies the
request.

## Target Validation

The daemon treats all forwarded target metadata as untrusted even though the LAN
listener already authenticated the request.

HTTP(S) targets must satisfy all of the following:

- the hostname is `localhost`, loopback IPv4, loopback IPv6, or an unspecified listen
  address that can be normalized to loopback;
- the URL contains a valid explicit or scheme-default port;
- DNS is not used to reinterpret a non-loopback hostname as loopback; and
- same-origin redirects stay on the existing mapping, redirects to another loopback
  origin replace the mapping only after the same validation, and public/LAN redirects
  leave the proxy and load directly.

File targets must satisfy all of the following:

- the path is absolute and exists;
- the initial file and every subsequent relative asset resolve inside the session
  workspace after symlink evaluation; and
- directories, missing files, and workspace escapes are rejected.

The proxy never accepts other schemes and never connects to arbitrary RFC1918, public,
link-local, metadata-service, Unix-socket, or named-pipe targets.

## HTTP And WebSocket Behavior

For HTTP(S), the daemon uses a streaming reverse proxy. It replaces the upstream Host
and Origin with the validated target origin, preserves method, path, query, request
body, status, and ordinary response headers, and strips hop-by-hop headers according to
HTTP rules. Loopback HTTPS may accept a self-signed development certificate only for
the already validated loopback target.

For WebSockets, the browser connects to the same local preview origin. The Electron
forwarder preserves the upgrade, the daemon dials the validated loopback target, and
both layers pipe frames without inspecting application payloads. This covers Vite and
similar HMR clients without adding a new public port.

For files, the daemon serves the selected entry and relative assets with normal content
types. Markdown continues to use the existing renderer rather than introducing a
second Markdown implementation.

## Lifecycle And Errors

Preview registrations are in-memory client state. They are recreated from the durable
session preview URL after the Remote client reconnects or restarts. Closing a Browser
view removes its registration; closing the Remote client closes the existing local
forwarder as today and does not affect daemon sessions or tmux processes.

Invalid targets return a stable client-visible navigation failure. Missing sessions or
files return not-found failures. Connection refusal, TLS failure, and upstream timeout
return a bad-gateway or gateway-timeout response without exposing credentials, local
filesystem contents, or raw internal error strings.

## Testing

Backend tests use loopback `httptest` servers and temporary workspaces to prove:

- HTTP methods, paths, queries, bodies, redirects, and streamed responses;
- WebSocket upgrade and bidirectional frames;
- loopback HTTPS development certificates;
- workspace HTML/Markdown/file assets; and
- rejection of non-loopback targets, unsupported schemes, missing sessions, symlink
  escapes, and unreachable upstreams.

Electron tests prove:

- normal daemon API forwarding is unchanged;
- loopback and file preview URLs become opaque local preview origins;
- public/LAN URLs and the normal desktop build remain unchanged;
- preview HTTP, redirects, cookies, and WebSocket upgrades select the correct mapping;
  and
- mappings are removed on view/client shutdown without terminating remote work.

The final deployment verification uses the exact build on `ubuntu@192.168.2.220`:

1. Serve a workspace HTML file through the existing daemon preview-file route.
2. Run a temporary HTTP and WebSocket development server bound only to server loopback.
3. Open both previews in the installed Remote client's Browser panel.
4. Verify assets, navigation, fetch, and WebSocket/HMR traffic.
5. Select a page element, submit an annotation, and confirm the target worker receives
   the existing formatted message.
6. Capture a screenshot and confirm the original local Agent Orchestrator app remains
   untouched.

## Delivery Boundary

The change is limited to the daemon preview transport, Electron Remote URL resolution
and forwarding, focused tests, generated API artifacts only if an existing versioned
DTO must change, the 220 daemon binary, and the separately named Remote application.
It does not modify or replace the currently installed local Agent Orchestrator app.
