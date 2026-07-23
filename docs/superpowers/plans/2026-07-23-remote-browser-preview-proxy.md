# Remote Browser Preview Proxy Implementation Plan

> **Execution:** Use `superpowers:subagent-driven-development` task by task. Each task follows red-green-refactor and receives an independent spec/code review before the next task starts.

**Goal:** Make the Browser panel load server-local workspace files and loopback development servers through the existing authenticated Remote connection, without changing the daemon's existing REST/SSE/terminal contracts or exposing another port.

**Architecture:** The Remote Electron process registers protected preview targets in its existing loopback forwarder and gives Chromium an opaque `*.ao-preview.localhost` origin. Preview-origin HTTP and WebSocket traffic is converted into an authenticated request to a new unversioned daemon transport route. The daemon resolves the session, confines file access to its workspace, and reverse-proxies only literal loopback HTTP(S) targets.

**Stack:** Go 1.x (`chi`, `httputil.ReverseProxy`, existing session/preview services), Electron/Node 20, TypeScript, Vitest.

## Global Constraints

- Do not restart, stop, replace, or deploy to any existing local or remote process while executing this plan.
- Work only in `/Users/czg/code/github/agent-orchestrator/.worktrees/gitlab-provider-coordinator-wakeup`.
- Preserve the existing daemon REST DTOs, SSE events, terminal WebSocket frames, session persistence, and annotation message formatting.
- Keep the primary daemon listener on `127.0.0.1`. Add no listener. The new route is mounted on the shared router and is therefore protected by the existing LAN auth middleware on `0.0.0.0`.
- Never forward `/shutdown`, `/internal/*`, or `/api/v1/mobile*` through the preview transport; reuse the exact LAN control-path predicate.
- Never forward the preview transport back into itself.
- Never proxy non-loopback, RFC1918, public, link-local, metadata-service, Unix-socket, named-pipe, or DNS-resolved targets.
- Never expose the raw target URL, workspace path, or connection password in the Chromium-visible preview URL.
- Keep normal desktop Browser navigation and public/LAN HTTP(S) navigation unchanged.
- Do not edit, stage, delete, or regenerate the pre-existing untracked `frontend/src/renderer/routeTree.gen.ts`.

## Fixed Internal Contract

- Daemon transport route: `/_ao/preview/{sessionId}/*`, outside `/api/v1`.
- Forwarder-owned target header: `X-AO-Preview-Target`. The forwarder deletes any caller-supplied value and writes the registered normalized target.
- Daemon-owned redirect response header: `X-AO-Preview-Redirect-Target`. The daemon sets it only after validating a cross-origin loopback redirect; the forwarder consumes and removes it before replying to Chromium.
- Preview browser host: `<random-token>.ao-preview.localhost:<forwarder-port>`. The token is generated with Node cryptographic randomness and maps only in memory.
- HTTP(S) mappings store a normalized loopback origin. Chromium retains the target path, query, and fragment on the opaque origin.
- File mappings store the normalized absolute `file:` target and expose only its base name as the initial browser path. Other request paths resolve relative to the selected file's parent, and every resolved path is checked against the session workspace after symlink evaluation.
- Preview HTTP and WebSocket requests delete Chromium's opaque `Origin` before entering the daemon's global CORS middleware. After target validation, the daemon sets the upstream Origin to the real target origin and removes AO Authorization, cookies, and internal headers before dialing the development server.
- Registrations are owned by renderer-scoped Browser view ID, not only session ID, so parallel views cannot replace each other's mappings.
- Closing a Browser view removes its mapping. Closing the forwarder clears all mappings. Neither action calls a daemon lifecycle endpoint.
- When saved Remote configuration replaces the ephemeral forwarder, the runtime asks BrowserViewHost to re-register and reload active source URLs on the new port before closing the old forwarder.

### Task 1: Daemon preview transport validation and file serving

**Files:**

- Create: `backend/internal/httpd/preview_proxy.go`
- Create: `backend/internal/httpd/preview_proxy_test.go`
- Modify: `backend/internal/httpd/router.go`
- Modify: `backend/internal/httpd/api.go`
- Modify: `backend/internal/service/session/service.go`
- Modify: `backend/internal/service/session/service_test.go`
- Modify: `backend/internal/daemon/daemon.go`
- Reuse: `backend/internal/httpd/lan_listener.go`
- Reuse: `backend/internal/httpd/controllers/sessions.go`
- Reuse: `backend/internal/preview/*`

**Step 1: Write failing handler tests**

Add table/integration tests proving:

- a missing session and missing `X-AO-Preview-Target` fail without leaking an internal error;
- `file:` GET and HEAD serve a workspace HTML asset;
- Markdown uses the existing renderer;
- missing files, directories, outside-workspace paths, and symlink escapes fail;
- unsupported schemes, DNS names other than exact `localhost`, non-loopback IPs, userinfo, and malformed targets fail;
- `0.0.0.0` and `[::]` normalize to loopback; and
- `/shutdown`, `/internal/*`, and `/api/v1/mobile*` targets are rejected.

Run `cd backend && go test ./internal/httpd -run 'TestPreviewProxy_(Validation|Files)' -count=1` and confirm the new tests fail because the route/handler does not exist.

**Step 2: Implement the minimum handler**

Add a lightweight `GetPreviewWorkspace` session-service read that loads only the durable session record and does not query PR facts per CSS/JS request. Add it as an optional `APIDeps.PreviewSessions` dependency and wire the existing session service in daemon construction.

Create a small `previewProxy` handler using that dependency. Parse and validate the internal target header, resolve the session workspace, and open file paths relative to an `os.OpenRoot` workspace root so symlink replacement cannot escape between validation and open. Use `http.ServeContent` or `preview.RenderMarkdown`. Return stable generic HTTP 400/404/405 failures without raw paths or credentials.

Mount the route in `NewRouterWithControl` before the versioned API. Do not add OpenAPI types because this arbitrary-method transport is intentionally outside the JSON API.

**Step 3: Run focused tests**

Run `cd backend && go test ./internal/httpd -run 'TestPreviewProxy_(Validation|Files)' -count=1` and confirm green.

**Step 4: Commit**

Commit as `feat: add confined daemon preview transport`.

### Task 2: Daemon loopback HTTP(S) and WebSocket proxying

**Files:**

- Modify: `backend/internal/httpd/preview_proxy.go`
- Modify: `backend/internal/httpd/preview_proxy_test.go`

**Step 1: Write failing HTTP and streaming tests**

Use only `httptest` loopback servers. Prove method, path, query, body, Host, Origin, status, ordinary response headers, and a flushed streaming response are preserved. Add an unreachable target assertion with a generic 502/504 response and no raw dial error.

Run `cd backend && go test ./internal/httpd -run 'TestPreviewProxy_(HTTP|Streaming|UpstreamFailure)' -count=1` and confirm red.

**Step 2: Implement streaming reverse proxy**

Validate the target using exact `localhost` or `net.ParseIP`; never resolve DNS. Normalize unspecified addresses to the matching loopback family. Use `httputil.ReverseProxy`, replace upstream Host and Origin, preserve the incoming suffix path/query, use scheme-default ports when omitted, and install a generic error handler. Strip AO Authorization, cookies, internal preview headers, and forwarded-client headers before dialing upstream. Permit an insecure development TLS transport only after the host has passed loopback validation.

Inspect redirect responses without following them. Same-origin redirects remain ordinary `Location` responses. A redirect to another validated loopback origin also receives `X-AO-Preview-Redirect-Target`; public/LAN redirects keep their original `Location`; invalid or unsupported redirect targets fail generically. Never emit the internal header for unvalidated data.

**Step 3: Write failing WebSocket test and implement upgrade forwarding**

Add an in-process WebSocket echo upstream and prove a client can upgrade through `/_ao/preview/{sessionId}/*` and exchange frames. Use `ReverseProxy` upgrade support; do not introduce a second frame protocol.

Run `cd backend && go test ./internal/httpd -run 'TestPreviewProxy_(HTTP|Streaming|HTTPS|WebSocket|UpstreamFailure)' -count=1` and confirm green, then run `cd backend && go test ./internal/httpd/... -count=1`.

**Step 4: Commit**

Commit as `feat: proxy loopback preview servers`.

### Task 3: Remote forwarder opaque preview routing

**Files:**

- Modify: `frontend/src/main/remote-forwarder.ts`
- Modify: `frontend/src/main/remote-forwarder.test.ts`

**Step 1: Write failing registry/classification tests**

Extend `RemoteForwarder` with `resolvePreviewURL(ownerId, sessionId, rawURL)`, `releasePreview(ownerId)`, and `originalPreviewURL(localURL)`. Add tests proving:

- loopback HTTP(S), unspecified-listen HTTP(S), and `file:` URLs become opaque preview origins;
- the generated URL contains neither raw target nor workspace path nor password;
- public and RFC1918 HTTP(S) URLs are returned unchanged;
- repeated navigation for the same owner/target reuses its mapping;
- address-bar and annotation translation returns the original target URL; and
- release/close invalidates the mapping without invoking a daemon endpoint.

Run `cd frontend && npm test -- --run src/main/remote-forwarder.test.ts` and confirm red.

**Step 2: Implement the in-memory registry**

Normalize allowed targets with the WHATWG URL API, generate a random lowercase token, and store maps by token and owner. Preserve target path/query/hash for HTTP(S). For files, expose only `/<basename>` plus query/hash. Keep this registration entirely inside the Electron main process.

**Step 3: Write failing HTTP forwarding tests and implement routing**

Send requests to the local forwarder with a preview Host and prove it:

- routes to `/_ao/preview/{escaped-sessionId}<browser-path-and-query>`;
- overwrites `X-AO-Preview-Target` and Authorization;
- deletes the opaque browser Origin before the daemon's CORS layer;
- streams request/response bodies;
- rewrites same-target absolute and relative `Location` values to the opaque origin;
- consumes and removes `X-AO-Preview-Redirect-Target`, creates a derived mapping for the validated loopback redirect without mutating an in-flight mapping, and rewrites `Location`;
- leaves public/LAN redirect locations direct; and
- removes `Domain` from preview cookies and strips the daemon connection cookie.

Unknown or released preview hosts return 404 and are never treated as normal daemon API traffic.

**Step 4: Write failing WebSocket forwarding test and implement upgrade routing**

Prove a WebSocket upgrade on the opaque host selects the same mapping, route, target header, and bearer credential, then pipes frames unchanged.

Run `cd frontend && npm test -- --run src/main/remote-forwarder.test.ts` and confirm green.

**Step 5: Commit**

Commit as `feat: route remote previews through local forwarder`.

### Task 4: BrowserView session-aware Remote URL resolution

**Files:**

- Modify: `frontend/src/main/browser-view-host.ts`
- Modify: `frontend/src/main/browser-view-host.test.ts`
- Modify: `frontend/src/main/remote-client-runtime.ts`
- Modify: `frontend/src/main/remote-client-runtime.test.ts`
- Modify: `frontend/src/main.ts`

**Step 1: Write failing BrowserViewHost tests**

Add optional async preview URL hooks to the host options. Prove `browser:ensure` records the real session ID, `browser:navigate` resolves with renderer-scoped view ownership before `loadURL`, public/direct results pass through, address bar and annotation context translate opaque URLs back to source URLs, and destroy/dispose releases the correct owner. Prove omitted hooks retain the normal desktop behavior byte-for-byte at the load boundary. Add an ownership assertion so a renderer cannot navigate another renderer's scoped view ID.

Run `cd frontend && npm test -- --run src/main/browser-view-host.test.ts` and confirm red.

**Step 2: Implement host wiring**

Store session ID and source URL separately from the renderer-scoped view ID. Resolve only after the existing URL allowlist succeeds, revalidate the resolved URL, and load it. Use a per-entry navigation epoch so a stale async resolve cannot load after a newer navigation, clear, or destroy. Release mappings during view destruction without changing annotation, capture, history, or focus behavior. Expose a host refresh method that re-registers and reloads active source URLs.

**Step 3: Write failing runtime tests and expose active-forwarder hooks**

Add runtime methods that return the original URL when no forwarder is active and delegate to the active forwarder when ready. Add an awaited `onForwarderChanged` dependency. Prove start and configuration replacement trigger BrowserView refresh, configuration replacement finishes refresh on the candidate port before closing the old forwarder, stop only closes the local forwarder, and no daemon session lifecycle call is added.

Run `cd frontend && npm test -- --run src/main/remote-client-runtime.test.ts` and confirm red, then implement the minimum delegation.

**Step 4: Connect Remote main process only**

Pass runtime resolver/release callbacks into `createBrowserViewHost` only for the separately identified Remote client. The normal desktop identity must omit them and keep direct navigation.

Run both focused test files and `cd frontend && npm run typecheck`.

**Step 5: Commit**

Commit as `feat: resolve remote browser previews through forwarder`.

### Task 5: Cross-boundary verification and artifact preparation

**Files:**

- Modify tests only if a cross-boundary failure exposes a real missing case.
- Do not modify or generate `frontend/src/renderer/routeTree.gen.ts`.

**Step 1: Run backend verification**

Run:

```bash
cd backend
go test ./internal/httpd/... -count=1
go test ./... -count=1
go test -race ./internal/httpd/... -count=1
go build ./...
```

**Step 2: Run frontend verification**

Run:

```bash
cd frontend
npm test -- --run src/main/remote-forwarder.test.ts src/main/browser-view-host.test.ts src/main/remote-client-runtime.test.ts
npm run typecheck
npm run build
```

**Step 3: Verify repository scope**

Inspect `git diff --check`, `git status --short`, and the complete branch diff. Confirm no generated API artifact changed, the untracked route tree is untouched, and no running application/service was stopped or replaced.

**Step 4: Build staged artifacts only**

Use the repository's existing packaging command to create a distinctly named Remote application artifact in a staging/output directory. Do not install it, overwrite `/Applications`, launch it, restart the current client, or deploy/restart the 220 daemon.

**Step 5: Whole-branch review and final commit**

Run the required whole-branch code review. Fix all Critical/Important findings with covering tests, re-run the affected verification, and commit any necessary fixes with a conventional message.

Live 220 Browser-panel verification and installation remain intentionally deferred because this execution is explicitly prohibited from touching the running remote service or local client process.
