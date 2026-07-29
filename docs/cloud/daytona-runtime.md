# Daytona sandbox runtime adapter (AO Cloud, phase 2)

Status: design + phase-2 implementation notes. Locked decisions (2026-07-28):
sandboxes run on [Daytona](https://daytona.io) — no owned Firecracker/K8s; agent
inference credentials are injected at sandbox boot as env vars by the control
plane (e.g. `CLAUDE_CODE_OAUTH_TOKEN` yields a logged-in Claude Code with no
browser flow).

This document records (1) the Daytona API surface the adapter builds on, (2)
how the adapter maps AO's runtime/workspace ports onto that surface so the
**unmodified** session manager + lifecycle manager can run a cloud session,
(3) the terminal attach story, (4) the hooks path, and (5) the cost model for
parked agents.

## 1. Daytona API survey (verified 2026-07-28)

Sources: [Sandboxes](https://www.daytona.io/docs/en/sandboxes/),
[Snapshots](https://www.daytona.io/docs/en/snapshots/),
[API keys](https://www.daytona.io/docs/en/api-keys/),
[Billing](https://www.daytona.io/docs/en/billing/),
[Pricing](https://www.daytona.io/pricing),
[platform OpenAPI](https://www.daytona.io/docs/openapi.json),
[toolbox OpenAPI](https://www.daytona.io/docs/toolbox-openapi.json), and the
official Go SDK source (`github.com/daytona/clients/sdk-go` v0.201.0).

**Product model.** A *sandbox* (the "workspace" term is legacy) is an isolated
runtime with its own kernel/fs/network; container class by default (also
linux-vm/windows/gpu). Sub-90ms cold start from an active snapshot. Default
resources 1 vCPU / 1 GiB / 3 GiB disk; regions `us`/`eu` via the `target`
param. Custom snapshots (`POST /snapshots`, amd64 image or Dockerfile, pinned
tag) are how we preinstall the agent harness (tmux, git, node, agent CLIs,
`ao` Linux binary).

**Auth.** Base URL `https://app.daytona.io/api`; every request carries
`Authorization: Bearer <org-scoped API key>` (dashboard → Keys, or
`POST /api-keys`; scopes incl. `write:sandboxes`). SDK convention env vars:
`DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET` — the adapter reuses
them.

**Lifecycle (platform API).** `POST /sandbox` (create; body `CreateSandbox`:
`snapshot`, `env{}`, `labels{}`, `target`, `cpu/memory/disk`,
`autoStopInterval`, `autoArchiveInterval`, `autoDeleteInterval`,
`ttlMinutes`, …), `GET /sandbox` (list; `labels` filter),
`GET/DELETE /sandbox/{idOrName}`, `POST /sandbox/{idOrName}/start|stop|archive`,
`PUT /sandbox/{id}/labels`, `POST /sandbox/{id}/autostop/{interval}`.
State enum (steady states): `started`, `stopped`, `archived`, `paused`,
`error`, `destroyed`; transitional: `creating/starting/stopping/restoring/
pulling_snapshot/archiving/resuming/…`. The `Sandbox` object carries
`toolboxProxyUrl` — the per-sandbox exec/fs/git surface below.

**Stop semantics.** Stopping a container sandbox terminates it: **filesystem
preserved, memory lost, all processes killed**; `start` restores the disk but
relaunches nothing. Auto-stop defaults to 15 min without API/user activity
(`0` disables). Stopped sandboxes can auto-archive (fs → object storage).

**Toolbox API** (base `{toolboxProxyUrl}/{sandboxId}`, same bearer key):

- Exec: `POST /process/execute` `{command, cwd, envs{}, timeout(s)}` →
  `{result, exitCode}` — the adapter's workhorse (all tmux/git commands).
- Sessions: `POST /process/session`, `POST /process/session/{id}/exec`
  (`runAsync`), log streaming over WebSocket — used for long-running installs.
- **PTY**: `POST /process/pty` `{id, cols, rows, cwd, envs}` →
  `GET /process/pty/{id}/connect` upgrades to a **WebSocket** (subprotocol
  `X-Daytona-Pty-Exit-Control`): binary frames = terminal bytes both ways;
  JSON text frames `{type:"control", status:"connected"|"exited", exitCode}`;
  `POST /process/pty/{id}/resize` `{cols, rows}`; `DELETE /process/pty/{id}`.
  The PTY runs the sandbox user's shell (no command param) — the adapter's
  attach writes `exec tmux -u attach …` as the first input line.
- Git: `POST /git/clone` `{url, path, branch, username, password}` plus
  status/add/commit/…; plain `git` over exec also works (we use exec so the
  command sequences mirror the local gitworktree adapter exactly).
- Files: upload/download/mkdir under `/files/*` (control-plane concern for
  spawn attachments).

**Go SDK.** Official: `github.com/daytona/clients/sdk-go` (v0.201.0,
Apache-2.0), wrapping generated platform + toolbox clients, gorilla/websocket
and a socket.io state feed. The adapter instead ships a **thin REST client**
(~300 lines over `net/http` + the repo's existing `coder/websocket`): the
surface we need is 10 endpoints, the fake-client seam for tests wants our own
narrow interface anyway, and it avoids a large new dependency tree. Revisit if
the surface grows.

**Pricing** (2026-07): vCPU $0.0504/h, RAM $0.0162/GiB-h, disk $0.000108/GiB-h
(first 5 GiB free), per-second metering. Default sandbox ≈ **$0.067/h
running**, ≈ **$0.0003/h stopped** (disk only), **$0 archived**.

## 2. The AO seam being satisfied

The daemon consumes runtimes through two port surfaces (see
`backend/internal/ports/outbound.go`):

- `ports.Runtime` — `Create / Destroy / GetOutput / IsAlive` (the reaper and
  session manager's contract), plus the optional capabilities the daemon wires
  when present: `ports.Attacher` (terminal streams), `ports.RuntimeRestarter`
  (agent resume without a new terminal identity),
  `ports.SupervisedProcessInspector` (agent-alive vs pane-alive, issue #2802),
  and the `runtimeselect.Runtime` union (`Interrupt`, `SendMessage`,
  `GetOutput`).
- `ports.Workspace` — the isolated checkout: `Create / Destroy / Restore /
  ForceDestroy / StashUncommitted / ApplyPreserved / AddExclude`.

The tmux adapter satisfies these against a **local** tmux server; the Daytona
adapter satisfies them against a **remote sandbox that itself runs tmux**:

| AO call | tmux adapter | daytona adapter |
| --- | --- | --- |
| `Workspace.Create` | `git worktree add` under `~/.ao/worktrees` | ensure sandbox for session (create from snapshot, labels `ao/session=<id>`), `git clone --branch` inside sandbox |
| `Runtime.Create` | `tmux new-session` with env-exporting launch line | Daytona exec: same launch line inside sandbox tmux |
| `Runtime.IsAlive` | `tmux has-session` | sandbox state probe + `tmux has-session` via exec |
| `IsSupervisedProcessAlive` | `ps` walk under pane pid | same `ps` walk via sandbox exec |
| `Runtime.GetOutput` | `tmux capture-pane` | `tmux capture-pane` via exec |
| `SendMessage`/`Interrupt` | `tmux send-keys` | `tmux send-keys` via exec |
| `Attach` | local PTY around `tmux attach` | remote PTY session running `tmux attach`, streamed over Daytona's API (outbound WebSocket) |
| `Runtime.Destroy` | `tmux kill-session` + reap | `tmux kill-session` via exec (sandbox teardown is Workspace.Destroy) |
| `Workspace.Destroy` | `git worktree remove` (dirty-refusal) | `git status --porcelain` guard, then delete sandbox |

Running tmux **inside** the sandbox is deliberate: it preserves every semantics
AO already depends on (scrollback, multiple attach clients, keep-alive shell
after agent exit, `send-keys` paste-then-Enter contract, capture-pane output)
without inventing a new PTY host, and the sandbox snapshot pins the tmux
version.

Handles: `RuntimeHandle.ID` is the same sanitized session name the tmux
adapter uses. The sandbox is found by label (`ao/session=<ao session id>`), not
by an in-memory map, so a daemon restart can re-adopt cloud sessions the same
way boot reconcile re-adopts tmux ones.

### Liveness (issue #2802: pane-exists != agent-alive)

`IsAlive` answers "does the terminal session still exist": sandbox exists AND
(sandbox running AND tmux session present) OR sandbox is parked (stopped) with
AO's park marker. Probe failures (API errors, network) return `(false, err)` —
never proof of death; the reaper treats them as failed probes.

Agent-process liveness is separate: `IsSupervisedProcessAlive` runs the same
process-table walk as tmux (`ps -ww -axo pid=,ppid=,args=` under the pane pid,
matching the `ao agent-process supervise --session … --launch …` marker) via
sandbox exec. A stopped (parked) sandbox reports the supervised process dead —
which is true: Daytona stop kills processes — and AO's existing exited→resume
flow relaunches the agent on wake via `RuntimeRestarter.Restart`
(start sandbox + `tmux respawn`-equivalent).

## 3. Terminal attach: outbound-only streaming

Requirement: terminal bytes must reach AO's terminal manager without any
inbound port on the sandbox.

The adapter's `Attach(handle, rows, cols)` creates a fresh PTY session inside
the sandbox via the toolbox API (`POST /process/pty`, sized rows×cols from
birth), dials its `/connect` WebSocket, and immediately writes
`exec tmux -u -T RGB attach-session -t <handle>` as the first input line (the
PTY create API takes no command; tmux's full-screen repaint hides the echoed
line). The WebSocket is wrapped in a `ports.Stream`: binary frames = bytes
both ways, `Resize` = `POST /process/pty/{id}/resize`, close deletes the PTY
session. This mirrors the conpty adapter's loopback-stream shape
(`backend/internal/adapters/runtime/conpty/attach.go`): dial, pump frames into
an `io.Pipe`, close on ctx cancellation.

Connectivity is **outbound from the daemon to Daytona's API proxy** and
**outbound from the sandbox to Daytona's control plane**; the sandbox itself
exposes no inbound port. Each AO client attach opens its own PTY/attach —
matching tmux semantics where the largest client drives the shared grid.

## 4. Hooks path: activity events from inside the sandbox

Agents launched by AO run `ao hooks <agent> <event>` from their native hook
config. On local runtimes the CLI finds the daemon via `running.json` on
loopback. Inside a sandbox there is no loopback daemon, so the adapter injects:

- `AO_API_BASE` — the base URL where the calling daemon's API is reachable
  from the sandbox (control-plane-provided; see below).
- `AO_API_TOKEN` — a sandbox-scoped bearer token minted per session.
- The usual `AO_SESSION_ID`, `AO_PROJECT_ID`, `AO_RUNTIME_LAUNCH_ID`,
  `AO_DATA_DIR` (pointing at a sandbox-local dir for `hooks.log`).

`ao hooks` (and the shared CLI client) honors `AO_API_BASE`: when set, requests
go to `<AO_API_BASE>/api/v1/…` with `Authorization: Bearer $AO_API_TOKEN`
instead of loopback run-file discovery. This is the only daemon-side code
change outside the adapter package.

**What the control plane must provide** (phase 1/3 responsibility, documented
here as the adapter's requirements):

1. A reachable `AO_API_BASE` for sandboxes (e.g. the cloud control plane's
   public API, which forwards `POST /sessions/{id}/activity` to the owning
   daemon, or a tunnel URL for a local daemon).
2. Minting + validating the per-session `AO_API_TOKEN` (scope: that session's
   activity/hook routes only). The loopback listener stays unauthenticated and
   unchanged; the token authenticates only the cloud-facing surface.
3. An `ao` Linux binary inside the sandbox snapshot so hook commands resolve —
   the repo's snapshot image (`test/daytona-snapshot/Dockerfile`, §5a) builds
   it from source and installs it at `/usr/local/bin/ao`.
4. Agent credentials as env vars at `Runtime.Create` (`cfg.Env`), e.g.
   `CLAUDE_CODE_OAUTH_TOKEN` — the adapter passes `cfg.Env` into the tmux
   launch line inside the sandbox verbatim (same export mechanics as the tmux
   adapter, quoted, `PATH` last).

## 5a. The agent snapshot

`test/daytona-snapshot/Dockerfile` builds the custom Daytona snapshot the
adapter expects: tmux, git, `ps` (procps — the #2802 liveness walk needs it),
node + the Claude Code CLI (pin via `--build-arg CLAUDE_CODE_VERSION=<x.y.z>`),
and the `ao` Linux binary built from this repo (stage 1, CGO-free), under the
Daytona-convention `daytona` user with home `/home/daytona` (matching the
adapter's default `WorkspaceRoot`).

Build from the repo root and register (Daytona requires amd64 + pinned tags):

```bash
# --provenance/--sbom off: the Daytona CLI cannot inspect buildx attestation
# manifest lists ("failed to check image architecture") — verified live.
docker buildx build --provenance=false --sbom=false --platform linux/amd64 \
  -f test/daytona-snapshot/Dockerfile -t ao-agent-sandbox:<version> --load .
daytona login --api-key $DAYTONA_API_KEY   # the CLI ignores the env var for push
daytona snapshot push ao-agent-sandbox:<version> --name ao-agent-sandbox:<version>
# or: docker push ghcr.io/<org>/ao-agent-sandbox:<version> && \
#     daytona snapshot create ao-agent-sandbox:<version> --image ghcr.io/<org>/ao-agent-sandbox:<version>
```

Point the adapter (or the live tests' `AO_DAYTONA_SNAPSHOT`) at the snapshot
name. The real-agent demo then runs without any runtime package installs:

```bash
cd backend
DAYTONA_API_KEY=… AO_DAYTONA_SNAPSHOT=ao-agent-sandbox:<version> \
AO_DAYTONA_AGENT_ARGV='["claude","-p","say hello"]' CLAUDE_CODE_OAUTH_TOKEN=… \
go test ./internal/adapters/runtime/daytona/ -run TestLive -v
```

## 5. Idle/suspend mapping and the cost model

Daytona bills running sandboxes per resource-hour; stopped sandboxes cost only
storage; archived sandboxes cost cold storage. AO maps its session states onto
that ladder:

| AO state | Daytona state | What survives | Burn (default 1cpu/1GiB/3GiB) |
| --- | --- | --- | --- |
| active / waiting_input | started | everything | ≈ $0.067/h |
| idle past park threshold | stopped ("parked") | filesystem (repo, agent transcript; tmux/processes do **not** — stop kills them) | ≈ $0.0003/h (disk only) |
| terminated (worktree preserved) | archived or deleted | archived: filesystem in object storage | $0 |

- **Parking**: the adapter sets Daytona's auto-stop interval at create time
  (default: 15 minutes, configurable via `Options.AutoStopMinutes`) so an
  agent that goes quiet stops burning compute even if AO never issues an
  explicit stop. AO-side, a parked sandbox's agent reads as exited (it is), and
  the session stays restorable.
- **Waking**: `RuntimeRestarter.Restart` starts the sandbox (warm start,
  seconds) and relaunches the agent through AO's existing resume flow (native
  transcript resume when the harness supports it — Claude Code does via its
  session id). Terminal scrollback from before the park is lost (tmux died
  with the stop); the agent transcript is not (it lives on the sandbox disk).
- **Teardown**: `Workspace.Destroy` refuses when the sandbox worktree is dirty
  (`git status --porcelain` non-empty) mirroring the local dirty-worktree
  refusal, then deletes the sandbox. `ForceDestroy` deletes unconditionally
  (after `StashUncommitted` captured work as a git ref — which for cloud
  sessions can be pushed to the remote as a preserve ref; see limitations).

## 6. Live validation results (2026-07-28, real Daytona account)

The full live suite passes against production Daytona using the maintainer's
test org, the pushed `ao-agent-sandbox:dev` snapshot, and a real
`CLAUDE_CODE_OAUTH_TOKEN` (all credentials via env; never committed):

| Test | Result | What it proves |
| --- | --- | --- |
| `TestLive_ClientSandboxLifecycle` | PASS, 4.4s | sandbox create→started in ~2–3s, exec, PTY-WebSocket byte round-trip + resize, delete |
| `TestLive_RuntimeSessionLifecycle` | PASS, 14.4s | workspace create (sandbox + clone) → tmux agent → scrollback → send round-trip → park (stop) → wake (`Restart`, same handle) → synchronous teardown |
| `TestLive_RealAgentSession` | PASS, 13.6s | **real Claude Code, authenticated with no browser flow** via `CLAUDE_CODE_OAUTH_TOKEN` boot-env injection, answered a prompt; keep-alive shell held after agent exit |

Observed behaviors that shaped the adapter (each now regression-tested):

- **Stop/delete are async**: the API 200s while state lags (`stopping` /
  still-listed); the toolbox proxy 502s mid-stop. Park waits for `stopped`,
  destroys wait for gone, and a failed liveness exec re-reads sandbox state
  before reporting.
- **The list endpoint trails `GET /sandbox/{id}`**: a freshly-parked sandbox
  can be listed as `stopping`, so wake settles the state first, then starts —
  otherwise the start is never issued (reproduced twice before the fix).
- Daytona's current default snapshot (`daytonaio/sandbox:0.8.0`) already
  ships tmux, so even snapshot-less smoke runs work; the custom snapshot is
  still required for agent CLIs + `ao` and is 0.21 GB vs 7.6 GB.

**Validated at the port level, pending daemon wiring (phase 3):** terminal
streaming is proven over the PTY WebSocket (`Attach`/`Stream` contract), but
in-app rendering needs the daemon to select this runtime per session —
`runtimeselect.New()` still picks tmux/conpty by OS, so merging this PR
changes nothing for local installs. **Confirmed gap:** activity/hook events
cannot reach a loopback-only local daemon from the sandbox; the CLI side
(`AO_API_BASE` + bearer) is unit-tested, and the control plane must provide
the reachable base + per-session tokens (§4).

## 6a. Phase-2 scope, limitations, follow-ups

- The adapter lives in `backend/internal/adapters/runtime/daytona/` and is not
  yet wired into `runtimeselect` platform selection (cloud sessions are
  selected per-session by the control plane, not per-OS; wiring lands with the
  control plane in phase 3).
- `session_manager` local file writes (spawn attachments, per-project
  provisioning symlinks) assume a local worktree; for cloud sessions those are
  control-plane concerns (upload via Daytona fs API). Documented, not blocked
  on: the runtime/workspace ports themselves are fully satisfied.
- `StashUncommitted`/`ApplyPreserved` run their git operations inside the
  sandbox; preserve refs live on the sandbox disk (and survive stop/archive),
  but are lost if the sandbox is deleted without `ao` pushing them. Follow-up:
  push preserve refs to the origin remote under `refs/ao/preserved/*`.
- Live smoke test is gated on `DAYTONA_API_KEY` (skips otherwise).
