# AO Cloud

AO Cloud is a separately deployable Go control plane plus a headless worker
image. It shares AO's domain and agent adapters while keeping the local
loopback daemon, SQLite, worktrees, and Electron lifecycle unchanged.

## Images and runtime topology

```text
Cloud web app
    → control-plane image (ao-cloud/docker/control-plane.Dockerfile)
    → PostgreSQL 17 service
    → provider-created sandbox from worker image
        → ao-worker + ao CLI + Claude Code/Codex/Cursor
```

There are two AO images:

- `ao-cloud/docker/control-plane.Dockerfile` builds the long-lived control
  plane. It owns the browser API, authentication verification, lifecycle
  reconciliation, and the PostgreSQL connection.
- `ao-cloud/docker/worker.Dockerfile` builds the per-session sandbox image.
  It contains `ao-worker`, the cloud `ao` CLI, and coding-agent CLIs. An
  orchestrator and a worker use this same image; their session role determines
  whether the agent works directly or uses the `ao` CLI to coordinate workers.

Workers and orchestrators are not fixed Compose services because the control
plane creates, reconnects, suspends, and deletes them per session. Locally it
creates Docker containers from `ao-cloud-worker:local`. In hosted deployments,
Daytona creates sandboxes from the published worker snapshot.

## Terminal-first sessions

Each cloud session exposes the actual PTY that runs its selected harness. The
browser sends input, resize, and reconnect commands to that terminal through the
control plane; it does not reconstruct a custom chat transcript from provider
output. An orchestrator terminal starts Claude Code with AO's bypass-permission
policy and includes the cloud `ao` CLI for `spawn`, `send`, `status`, `inspect`,
`wait`, `result`, and `session` subcommands.

Workers keep their own harness PTY. PostgreSQL still records lifecycle,
provisioning, and terminal output needed for reconnect, while the sandbox volume
keeps the repository and harness state. Files and diffs remain available through
the inspector.

## Cloud `ao` parity surface

The cloud worker image exposes a CP-authenticated `ao` CLI. The CLI never reads
daemon state, local SQLite, Docker internals, or raw worker databases; every
command goes through scoped worker tokens and CP routes.

Orchestrators can:

- `ao spawn --name "<label>" --prompt "<task>"` or `ao spawn --issue <number>`
  to create durable worker sessions in the same project.
- `ao status`, `ao session ls`, and `ao session get <worker>` to inspect
  lifecycle, activity, turn attempts, branch, runtime, PR, CI, and review state.
- `ao send --session <id> --message "<text>"`, `ao wait <worker>`, and
  `ao result <worker>` to coordinate turns and read completed answers.
- `ao session claim-pr <worker> <number-or-url>` to attach existing GitHub PRs.
- `ao session merge-pr <worker>` and
  `ao session resolve-review-thread <worker> <thread-id>` for explicit
  GitHub write actions after review/CI policy allows it.
- `ao session kill <worker>` to request worker deletion.

Workers can use `ao blocker --message "<details>"` when they need an
orchestrator decision or cross-session coordination. The CP records an
idempotent message to the project orchestrator and wakes it through the worker
command stream.

The Cloud SCM observer persists pull requests, check runs, review state, merge
state, and GitHub review threads. Actionable CI failures, requested changes,
merge conflicts, and unresolved review threads are turned into idempotent worker
messages so the responsible worker sees the same feedback loop the local daemon
provides. In local development these GitHub operations use the host `gh` token
or `AO_GITHUB_TOKEN`; hosted production should replace that deployment-wide
token with the planned GitHub App.

Workspace inspection is repository-scoped. Cloud projects always have one Git
repository, so scratch and multi-repository local workspace behavior is not
carried over. The inspector returns directory listings, text file reads,
localhost/file previews, and structured diff metadata: durable compare base
ref/SHA, added/modified/deleted/renamed status, untracked non-ignored files,
per-file additions/deletions, binary flags, and truncation markers.

## Local development

`npm run cloud:local` uses Compose for the control plane and PostgreSQL, builds
the worker image, and starts the web app on the host. The local control-plane
image includes the Docker CLI and is given the Docker socket solely so it can
create per-session worker containers. Worker containers reach the published
loopback CP port through `host.docker.internal`.

Prerequisites:

- Go, Node.js, npm, Docker
- authenticated `gh` CLI for the development Git credential broker

Start local PostgreSQL once:

```bash
npm run cloud:postgres
```

Run the cloud package suite against that disposable database with:

```bash
npm run cloud:test
```

Copy `ao-cloud/.env.example` to the gitignored `.env.cloud.local`, add a Git
credential mode, and generate local encryption/signing keys with:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Build the same worker image used by local Docker sandboxes:

```bash
npm run cloud:build-image
```

Set `AO_SANDBOX_PROVIDER=docker` (the default) and keep
`AO_DOCKER_WORKER_IMAGE=ao-cloud-worker:local`. Start the control plane:

```bash
npm run cloud:server
```

Start the web app in a second terminal:

```bash
npm run cloud:web
```

Open:

```text
http://127.0.0.1:5174/app
```

The Go service applies the embedded `ao_*` PostgreSQL migrations at startup.
Local accounts and opaque bearer sessions are stored in that PostgreSQL
database; only bcrypt password hashes are persisted. Docker, Daytona,
encryption, worker-signing, and Git credentials remain server-side. For the
Docker provider, the worker is given
`host.docker.internal` automatically so it can call the CP that is running on
your host.

## Development GitHub mode

`npm run cloud:local` reads the host's current `gh auth token` before Compose
starts and injects it into the local control plane. If `gh` is unavailable, set
`AO_GITHUB_TOKEN` in the gitignored `.env.cloud.local` instead. Sandboxes never
receive that long-lived token. Git operations use an
AO-authenticated repository proxy scoped to the session's registered
repository.

For hosted deployment, set `AO_GITHUB_TOKEN` to a fine-grained token limited
to the repositories AO may use. The token remains in the control plane and its
Git proxy; sandboxes receive only scoped worker
credentials. Replace this fallback with the planned GitHub App before a
multi-user production launch.

## Daytona

When `AO_SANDBOX_PROVIDER=daytona`, the adapter uses:

```text
DAYTONA_API_URL=https://app.daytona.io/api
DAYTONA_TARGET=us
```

The current account exposes `daytona-large` at 4 vCPU, 8 GiB memory, and 10 GiB
disk. AO uses that as the initial default and enforces the same 10-GiB ceiling
until the Daytona tier changes.

Publish an immutable worker snapshot from the release commit:

```bash
AO_WORKER_VERSION="$(git rev-parse HEAD)" \
AO_DAYTONA_WORKER_SNAPSHOT="ao-worker-$(git rev-parse --short HEAD)" \
npm run cloud:publish-worker
```

Set that snapshot name in `AO_DAYTONA_WORKER_SNAPSHOT` before deploying the
control plane. See [`HOSTED_SETUP.md`](setup/HOSTED_SETUP.md) for the complete
release sequence.

## Tests

```bash
npm run cloud:test
npm --prefix frontend/src/landing test
npm --prefix frontend/src/landing run typecheck
npm --prefix frontend/src/landing run build
```

Run the live Daytona lifecycle gate explicitly:

```bash
set -a
. ./.env.cloud.local
set +a
AO_DAYTONA_LIVE_TEST=1 go test ./backend/internal/cloud/sandbox/daytona \
  -run TestLiveCreateGetDelete -v
```

The live test creates and deletes one sandbox. Ordinary test runs never create
provider resources.

## Hosted deployment on Azure VM

The supported self-hosted topology runs Caddy, the AO control plane, and
PostgreSQL as separate containers on one persistent Azure VM. Caddy is the
only public service; PostgreSQL and the control plane stay private to Compose.

Follow [`HOSTED_SETUP.md`](setup/HOSTED_SETUP.md) to provision the VM, configure
secrets, launch the stack, route HTTPS traffic, and operate backups. The
compose definition is [`docker-compose.hosted.yml`](docker-compose.hosted.yml).

## Vercel deployment

Import the repository into Vercel with:

```text
Root Directory: frontend/src/landing
Framework: Next.js
```

Set:

```text
NEXT_PUBLIC_API_URL=https://YOUR-CLOUD-DOMAIN
```

The browser uses PostgreSQL-backed control-plane email/password sessions.

The product-level cloud design is in
[`architecture/CLOUD_DESIGN.md`](architecture/CLOUD_DESIGN.md).
For a complete local control-plane, database, sandbox, and web-app walkthrough,
see [`LOCAL_SETUP.md`](setup/LOCAL_SETUP.md).
