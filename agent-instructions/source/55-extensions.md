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
- **SDLC audit markers:** workers must leave durable, externally auditable
  markers for every lifecycle stage. The durable surfaces are GitHub issue/PR
  comments plus SHA-pinned commit status/check contexts; when the ao session/API
  is available, also emit ao activity updates so `/api/v1/events` and
  `ao-slack-notifier.service` surface the transition in Slack. The chat
  transcript is never the audit record.

  Required markers:

  1. **Planning** — after `/plan-work` or equivalent phase design, post the
     phase plan and test strategy to the GitHub issue or PR. If no PR exists
     yet, use the issue and carry the marker forward once the PR opens.
  2. **Independent review cycle** — for each review cycle, post a
     `review requested` marker with the reviewer/model family and head SHA
     reviewed, then post `review verdict` with the verdict, findings count by
     severity, and whether fixes are required.
  3. **CI run** — for each local or remote CI run used as a gate, post `CI run`
     with the command or workflow, the head SHA, and the conclusion. Link remote
     logs when GitHub Actions produced them.
  4. **Final review** — `/final-review` is REQUIRED before merge readiness. Its
     final-review verdict must be posted as a PR comment naming the current head
     SHA, and it must set a successful `review-passed` commit status/check on
     that same SHA only when the verdict is clean. Failed, inconclusive, or
     stale verdicts must set or leave a non-success state and park the PR.

  Autonomous merge is blocked unless GitHub has a clean final-review verdict for
  the current head SHA, backed by both required artifacts: the final-review PR
  comment naming that SHA and a successful `review-passed` commit status/check
  on that SHA. It is also blocked by any current-head human-merge-required
  signal such as `merge-park`. Any missing, stale, failing, inconclusive,
  human-gated, or different-SHA artifact parks the PR instead of merging.

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

### Session naming — ao owns it

**Do not name your own session.** ao computes `<repoKey> #<issue> <slug>` from
the project and the issue's own title, and applies it to both surfaces — the ao
display name (dashboard, `ao session get`, `ao session ls`) and the harness's
in-harness app title — at launch, for every harness. A session dispatched with
`ao spawn --issue <n>` is already named correctly before your first turn.

- **Never hand-type a rename into a pane** (`tmux send-keys '/rename …'`). That
  is the drift that produced double-renames and, when it raced a booting TUI,
  swallowed the worker's prompt entirely.
- **Never pass `ao spawn --name`** for a session that has an issue; an explicit
  name overrides ao's computed one.
- If your session's bound work item genuinely changes (a queue advancing
  between issues), use `ao session rename "$SID" "<name>"` — it updates the
  display name **and** re-issues the in-harness title through the daemon, so
  there is still exactly one code path. Your ao session id is
  `SID="${AO_SESSION_ID:-$(tmux display-message -p '#S')}"`. The name is capped
  at 20 characters on every path, so a longer one will not stick.
- **Never rename the tmux session itself** — its name IS the ao session id and
  ao addresses the pane by it.
