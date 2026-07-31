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
Daytona creates sandboxes from the published worker snapshot (or Fly creates
Machines from the worker image).

## Terminal-first sessions

Each cloud session exposes the actual PTY that runs its selected harness. The
browser sends input, resize, and reconnect commands to that terminal through the
control plane; it does not reconstruct a custom chat transcript from provider
output. An orchestrator terminal starts Claude Code with AO's bypass-permission
policy and includes the cloud `ao` CLI for `spawn`, `send`, `status`, `inspect`,
`wait`, and `result`.

Workers keep their own harness PTY. PostgreSQL still records lifecycle,
provisioning, and terminal output needed for reconnect, while the sandbox volume
keeps the repository and harness state. Files and diffs remain available through
the inspector.

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

## Fly Machines

Set `AO_SANDBOX_PROVIDER=fly` to provision one private Fly Machine and encrypted
10-GiB volume per session. The control plane needs:

```text
AO_FLY_API_URL=https://api.machines.dev/v1
AO_FLY_API_TOKEN=<org- or app-scoped token>
AO_FLY_APP=<worker app>
AO_FLY_REGION=<region>
```

Publish `ao-cloud/docker/worker.Dockerfile` to the Fly app's private registry.
AO defaults to `registry.fly.io/ao-workers-nihal-2026:stable`; use the optional
`AO_FLY_WORKER_IMAGE` override only for another Fly app or a rollback.
The image entrypoint prepares the mounted workspace as root, then drops to the
unprivileged `ao` user before starting the worker. Pausing suspends the Machine
so the one-time bootstrap credential is never reused.

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

`render.yaml` is a legacy deployment manifest and is not part of the supported
single-VM hosted topology.

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

The browser uses PostgreSQL-backed control-plane email/password sessions; it
does not require Supabase browser credentials.

The product-level cloud design is in
[`architecture/CLOUD_DESIGN.md`](architecture/CLOUD_DESIGN.md).
For a complete local control-plane, database, sandbox, and web-app walkthrough,
see [`LOCAL_SETUP.md`](setup/LOCAL_SETUP.md).
