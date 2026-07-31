# Native agent-browser integration

Status: implementation complete, enabled by default; cross-platform acceptance pending

AO can run the pinned native Vercel `agent-browser` against the same Electron
`WebContentsView` shown in AO Preview.

The implementation does not expose an Electron-wide debugging port. Electron
creates a random, loopback-only WebSocket endpoint for one AO worker and keeps
the endpoint inside the desktop process. The daemon still validates the
worker's existing browser capability before forwarding a request.

## Development setup

From `frontend/`:

```powershell
npm run dev
```

The normal development command prepares the current platform's pinned binary
when needed and verifies its SHA-256 checksum. Packaging does the same before
copying the component into the desktop app. It does not install Chrome. The
generated `frontend/agent-browser/` directory is gitignored.

Inside an AO worker:

```text
ao browser open http://localhost:5173
ao browser snapshot --interactive
ao browser fill e1 "hello"
ao browser click e2
ao browser wait --text "Saved"
ao browser errors
```

The native engine is internal. Ordinary `ao browser` commands translate to its
semantic inspection, interaction, wait, tab, frame, dialog, screenshot, and
console/error operations while preserving AO's stable output contract.

AO blocks commands and flags that could launch or attach to another browser,
display the private CDP endpoint, reuse a personal profile, persist browser
state, evaluate arbitrary JavaScript, read arbitrary files, alter network
routes, or close AO Preview.

## Manual acceptance checks

1. Open a local React preview in a worker.
2. Run a compact snapshot and confirm its refs describe the visible page.
3. Fill and click controls, then wait for an asynchronous result.
4. Confirm the actions are visible in the same AO Preview.
5. Open a second worker and confirm commands cannot see its page or tabs.
6. Open native DevTools; the active automation command should stop safely.
   Close DevTools and confirm a fresh snapshot reconnects.
7. Close the worker and confirm AO Preview closes without leaving an
   `agent-browser` process.
8. Wait five minutes after the last command and confirm the sidecar exits while
   AO Preview stays open.

AO retains its own bounded, metadata-only network capture so credentials,
request bodies, and query values never enter browser command output.

## Validation status

- Focused native-runtime, CDP-bridge, Browser host, CLI, controller, and service
  checks pass on Windows.
- A fresh Windows x64 desktop package contains the checksum-matching
  `agent-browser 0.33.1` executable and required license files.
- macOS (arm64/x64), Linux x64 packaging, and the manual lifecycle checks above
  remain release acceptance work on their respective hosts; no implementation
  fallback or feature flag remains.
