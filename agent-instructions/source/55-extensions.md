## Repo extensions (ao)

- **Tracking:** GitHub-only (no `.beads/` here — skills degrade
  automatically; the issue is the sole tracker).
- **Build/test gates:** backend is Go — `cd backend && go build ./... &&
  go vet ./... && go test ./...`; frontend is pnpm/vite under `frontend/`.
  Upstream CI workflows are the remote gate.
- **Sensitive paths (autonomous merge PARKS):** `backend/internal/daemon/**`,
  `backend/internal/session_manager/**`, `backend/internal/lifecycle/**` —
  a bad change here takes down the whole fleet; a human reviews those merges.
- **Env:** sessions run with `POLYPOWERS_AUTOMERGE=1` and
  `POLYPOWERS_REPO=polymath-ventures/agent-orchestrator` (project config).
