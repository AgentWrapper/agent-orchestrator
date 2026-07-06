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
- **Deploy target:** ao production is the local self-hosted user daemon and
  browser-mode web surface, not an external PaaS. Deploy command:
  `ops/deploy.sh`. The script backs up `~/.local/bin/ao` to
  `~/.local/bin/ao.prev`, rebuilds the daemon binary from `backend/`, restarts
  `ao.service`, and retries readiness for about 30 seconds so the brief
  self-hosted API outage is not treated as a failure. If `frontend/` changed
  in the deployed range it restarts `ao-web.service` (whose `ExecStartPre`
  rebuilds the web bundle); if `ops/` changed it restarts
  `ao-slack-notifier.service`.

### Deploy

- **Command:** `ops/deploy.sh`
- **Verify:** `ao status` reports ready; `ao doctor` has no failures;
  `curl http://127.0.0.1:3001/api/v1/projects` returns 200; the
  pre-restart `ao session ls --json` count matches the post-restart
  re-adopted count; the tailnet web URL returns 200; and
  `ao-slack-notifier.service` is active after notifier restarts.
- **Logs:** `journalctl --user -u ao`; for web and notifier follow-ups use
  `journalctl --user -u ao-web` and
  `journalctl --user -u ao-slack-notifier`.
- **Rollback:** `ops/deploy.sh --rollback` restores `~/.local/bin/ao.prev` to
  `~/.local/bin/ao`, restarts `ao.service`, and reruns the same daemon
  readiness/API/session/web checks.
- **Pool:** deploy-only work runs on the cheap haiku pool:
  `ao spawn --model haiku`.
- **Session self-naming (ao-hosted sessions):** keep your session's names in
  sync with the current work item so the dashboard and the Claude Code session
  list read like a live work log. Workers set both surfaces on claiming a work
  item and again on every queue item transition. Your ao session id is
  `SID="${AO_SESSION_ID:-$(tmux display-message -p '#S')}"` (ao injects the
  env var; tmux is the fallback). Derive `<slug>` from the issue title:
  lowercase `[a-z0-9-]` only, everything else stripped — never interpolate a
  raw title into a shell command.
  - ao display name: `ao session rename "$SID" "#<issue> <slug>"` — 20-char
    cap (enforced at spawn/API; the CLI rename path currently skips the
    check, so never rely on a longer name sticking). Visible in the
    dashboard and `ao session get`; the `ao session ls` table doesn't show
    it yet (gap tracked in GH #28).
  - Claude Code session title (claude-code harness only):
    `tmux send-keys -t "$SID" -l '/rename #<issue> <short-desc>'` then
    `tmux send-keys -t "$SID" Enter` — verified safe mid-turn. This title is
    intentionally uncapped and should use the descriptive work-item text, not
    only ao's 20-char display name. Other harnesses have no Claude Code title
    surface; ao display name is their only naming surface and must not be
    faked.
  - Never rename the tmux session itself — its name IS the ao session id and
    ao addresses the pane by it.
