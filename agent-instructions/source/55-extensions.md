## Repo extensions (ao)

- **Tracking:** GitHub-only (no `.beads/` here — skills degrade
  automatically; the issue is the sole tracker).
- **Build/test gates:** backend is Go — `npm run ci:backend` (runs `go build`,
  `go vet`, `go test -race`, and the CI-pinned `golangci-lint` over `./...`).
  Run `npm run format:check` before push for changed-file Prettier parity; set
  `BASE_REF=origin/<branch>` when the PR base is not the default branch. Upstream
  CI workflows are the remote gate.
- **Frontend gates — the frontend is an npm project, not pnpm.**
  `frontend/package.json` + `frontend/package-lock.json` are authoritative: the
  lockfile decides which package manager a project uses. Two upstream file names
  are cited below purely as file names — the first does not exist in this tree at
  all, and the second is an Electron packaging settings file, which decides
  nothing about which manager to run:

  - `frontend/pnpm-lock.yaml`
  - `frontend/pnpm-workspace.yaml`

  No agent should reach for pnpm here.

  The four frontend gate commands, run from the repo root:

  ```bash
  npm ci --prefix frontend --allow-git=all --ignore-scripts   # install
  npm test --prefix frontend                                  # vitest
  npm run typecheck --prefix frontend                         # tsc --noEmit
  npm run build:web --prefix frontend                         # production web bundle
  ```

  The install flags are narrow and deliberate: this host's npm defaults
  `allow-git=none`, while Electron's lockfile pins a transitive git dependency,
  so `--allow-git=all` is passed **on the command line only** (never written into
  repo or global npm config), and `--ignore-scripts` keeps the install
  side-effect free. Frontend dependencies are **not preinstalled** in a fresh
  worktree — which is never the same thing as "unavailable". Run the install
  above before reporting any frontend tooling or test blocker (see the
  verification contract: reviewer claims are evidence candidates, never facts).

- **Sensitive paths (autonomous merge PARKS):** `backend/internal/daemon/**`,
  `backend/internal/session_manager/**`, `backend/internal/lifecycle/**` —
  a bad change here takes down the whole fleet; a human reviews those merges.
- **Autonomous merge config:** project config sets `autonomousMerge=true` for
  this repo when workers may merge after the full gate. AO reflects that into
  `POLYPOWERS_AUTOMERGE=1` inside worker sessions for compatibility with the
  skills layer; it is not a global daemon env assumption. Sessions also run with
  the project's `env` (including `POLYPOWERS_REPO`). The authoritative values —
  `autonomousMerge`, `env`, `workerMix`, `trackerIntake`, prefixes, workspace
  mode, role overrides — are **not** duplicated in this prose; they live in the
  committed spec `ops/project-config/agent-orchestrator.json` (see Config-as-code
  below), which is the single source of truth.
- **Config-as-code (project config):** each project's clean-boot config is a
  committed spec under `ops/project-config/<project>.json` — the system's
  clean-boot state is its specification, reconstructible from a committed source,
  never from archaeology. The `ops/project-config.mjs` CLI wraps the existing
  `ao` commands (no daemon change, per the vanilla rule):
  `node ops/project-config.mjs apply <project>` restores config from the spec
  (THE recovery path after any wipe/incident); `check [--all]` diffs live config
  against the spec and exits non-zero on drift; `capture <project>` refreshes a
  spec from live after an intended change. A drift is surfaced by the
  `ops/project-config-drift.{service,timer}` scheduled compare (install per
  `ops/project-config/README.md`), so a wiped field becomes a red check within
  minutes instead of a multi-day limp. Pause (`paused`/`pauseState`, #161/#212)
  is a sibling of the spec-managed config, never inside it — pausing can never
  register as drift and the spec can never manage pause state.
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
  `ops/deploy.sh`. The script resolves and fetches the requested ref, stages it
  in an isolated clean checkout, builds the daemon and web bundle from that
  checkout, assembles a versioned release under `~/.ao/deploy/releases/`, and
  atomically flips `~/.ao/deploy/current` only after build provenance
  validation passes. The stable `~/.local/bin/ao` path is a symlink to
  `current/bin/ao`, and daemon/web/notifier/reply systemd units execute through
  the same `current` release pointer. Deploy restarts `ao.service`, retries
  readiness for about 30 seconds so the brief self-hosted API outage is not
  treated as a failure, then restarts and verifies the web, Slack notifier, and
  attention reply services so all local services converge to the same release.
  Changed-path detection may skip rebuilding an unchanged web bundle only when
  the previous bundle's recorded `frontend/` tree matches the requested ref; it
  never skips unit topology convergence. Before activation, deploy refuses a
  binary whose Go VCS metadata is missing (unstamped / `-buildvcs=false`),
  dirty (`vcs.modified=true`), or stamped with a revision other than the deploy
  source ref — a build that could not prove its provenance never reaches the
  running daemon. After restart it fails unless the running daemon reports that
  same just-built VCS revision (via `/api/v1/version`), and it appends every
  deploy (timestamp, source ref, revision) to
  `~/.ao/deploy/agent-orchestrator.deploy.log`.

### Codex-family reviewers run in the foreground only

Operator standing rule: **codex and codex-fugu run in the foreground under
all circumstances — never in the background, no exceptions.** Invoke them as
blocking, attached commands that run to completion in view.

- **Never** `nohup`, `&`, `setsid`, `disown`, a detached background shell, or
  any launch-and-poll pattern that starts codex and returns to poll it later.
  Backgrounded reviewers stall silently at MCP startup, die with exit 144,
  and leave workers polling a process that is already dead — the exact
  failures this rule exists to prevent. Foreground runs are attached,
  observable, and fail loudly.
- A long review uses the **maximum foreground timeout**; if it still does not
  fit, split it into smaller foreground passes and re-run — never detach to
  dodge a shell's time cap.
- If codex hangs at MCP startup, the fallback is to disable MCP for that run
  (`-c 'mcp_servers={}'`), still in the foreground — not to background it.
- This binds every codex invocation a worker or an Orc drives: review
  passes (`/codex:review`, `/final-review`), diagnosis, and rescue runs. ao's
  own daemon exec of codex — worker/Orc session launch into a tmux
  TTY and the `#143` model probe — is already blocking/attached and stays
  that way.

### Deploy

- **Command:** `ops/deploy.sh`
- **Verify:** `ao status` reports ready; `ao doctor` has no failures;
  `curl http://127.0.0.1:3001/api/v1/projects` returns 200; the
  pre-restart `ao session ls --json` count matches the post-restart
  re-adopted count; the tailnet web URL returns 200; and
  `ao-slack-notifier.service` is active after notifier restarts. Also confirm
  the running daemon's build revision — `ao version` (or `ao version --json`)
  and `curl http://127.0.0.1:3001/api/v1/version` report the embedded VCS
  revision, build time, and dirty flag — matches the deployed commit and is
  not a dirty (`vcs.modified=true`) build; `deploy.sh` verifies this
  automatically and fails the deploy on missing VCS stamping, a dirty build, a
  revision that differs from the deployed ref, or a running daemon that does
  not report the just-built revision.
- **Logs:** `journalctl --user -u ao`; for web and notifier follow-ups use
  `journalctl --user -u ao-web` and
  `journalctl --user -u ao-slack-notifier`.
- **Rollback:** `ops/deploy.sh --rollback` switches `~/.ao/deploy/current`
  back to the previous release pointer, refreshes the stable CLI symlink and
  unit files, restarts daemon/web/notifier/reply services, and reruns the same
  daemon readiness/API/session/web checks.
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
  between issues), use `ao session set-issue "$SID" "<issue-id>"` — the daemon
  resolves the issue title, recomputes the display name, stores the new issue
  id, and re-issues the in-harness title through the same title delivery path.
  Your ao session id is
  `SID="${AO_SESSION_ID:-$(tmux display-message -p '#S')}"`. The name is capped
  at 20 characters on every path after daemon computation.
- **Never rename the tmux session itself** — its name IS the ao session id and
  ao addresses the pane by it.
