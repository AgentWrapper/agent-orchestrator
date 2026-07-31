# Native agent-browser integration

Status: experimental Stage 0, disabled by default

AO can run the pinned native Vercel `agent-browser` against the same Electron
`WebContentsView` shown in AO Preview.

The implementation does not expose an Electron-wide debugging port. Electron
creates a random, loopback-only WebSocket endpoint for one AO worker and keeps
the endpoint inside the desktop process. The daemon still validates the
worker's existing browser capability before forwarding a request.

## Development setup

From `frontend/`:

```powershell
npm run agent-browser:prepare
$env:AO_AGENT_BROWSER_ENABLED = "1"
npm run dev
```

`agent-browser:prepare` downloads only the current platform's binary for the
pinned release and verifies its SHA-256 checksum. It does not install Chrome.
The generated `frontend/agent-browser/` directory is gitignored.

Inside an AO worker:

```text
ao browser agent-browser open http://localhost:5173
ao browser agent-browser snapshot -i
ao browser agent-browser fill @e1 "hello"
ao browser agent-browser click @e2
ao browser agent-browser wait --text "Saved"
ao browser agent-browser errors
```

The command is hidden from normal CLI help while the adapter is experimental.
Supported commands are intentionally limited to semantic inspection,
interaction, waits, tabs, frames, dialogs, console/errors, highlighting, and
snapshot diffs.

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

The existing `ao browser` commands remain the fallback if the feature flag is
off, the binary is missing, or the Stage 0 adapter fails.
