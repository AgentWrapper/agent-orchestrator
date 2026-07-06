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
- **Session self-naming (ao-hosted sessions):** keep your session's name in
  sync with your current work item so the dashboard and the Claude Code
  session list read like a live work log. Workers set both surfaces on
  claiming a work item and again on every queue item transition. Your ao
  session id is `SID="${AO_SESSION_ID:-$(tmux display-message -p '#S')}"`
  (ao injects the env var; tmux is the fallback). Derive `<slug>` from the
  issue title: lowercase `[a-z0-9-]` only, everything else stripped — never
  interpolate a raw title into a shell command.
  - ao display name: `ao session rename "$SID" "#<issue> <slug>"` — 20-char
    cap (enforced at spawn/API; the CLI rename path currently skips the
    check, so never rely on a longer name sticking). Visible in the
    dashboard and `ao session get`; the `ao session ls` table doesn't show
    it yet (gap tracked in GH #28).
  - Claude Code session title (claude-code harness only):
    `tmux send-keys -t "$SID" -l '/rename #<issue> <slug>'` then
    `tmux send-keys -t "$SID" Enter` — verified safe mid-turn. Other
    harnesses have no title surface; ao display name only.
  - Never rename the tmux session itself — its name IS the ao session id and
    ao addresses the pane by it.
