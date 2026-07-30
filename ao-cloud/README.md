# AO Cloud

AO Cloud is a separately deployable Go control plane plus a headless worker
image. It shares AO's domain and agent adapters while keeping the local
loopback daemon, SQLite, worktrees, and Electron lifecycle unchanged.

## Components

```text
Cloud web app
    → Render ao-cloud
    → Supabase Auth + PostgreSQL
    → Fly Machine or Daytona sandbox per session
    → ao-worker + Claude Code/Codex/Cursor
```

## Structured agent sessions

Claude Code, Codex, and Cursor sessions open in AO's native conversation view.
The worker consumes each provider's machine-readable event stream and maps it
to provider-neutral `chat.*` events for messages, reasoning, tools, command and
file output, usage, approvals, warnings, errors, and turn lifecycle.

Browser messages are idempotently committed to PostgreSQL before worker
delivery. Provider events are also committed before display. The web client
uses an authenticated replay-then-live SSE stream, so refreshes and reconnects
continue from the last durable sequence without depending on terminal scrollback.
Closing the browser does not stop the worker. Workers that do not negotiate the
structured-chat capability automatically use the PTY surface instead.

## Local development

Prerequisites:

- Go, Node.js, npm, PostgreSQL 17, Docker
- authenticated `gh` CLI for the development Git credential broker
- Supabase project with Email Auth enabled
- Fly organization/app token or Daytona API key

Create local databases once:

```bash
brew services start postgresql@17
createdb ao_cloud_dev
createdb ao_cloud_test
```

Copy `ao-cloud/.env.example` to the gitignored `.env.cloud.local`, then add
credentials. Generate local encryption/signing keys with:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Build the Linux worker used for local-to-Daytona validation (Fly runs the
published worker image directly):

```bash
npm run cloud:build-worker
```

Start the control plane:

```bash
npm run cloud:server
```

Start the website in a second terminal:

```bash
npm run cloud:web
```

Open:

```text
http://127.0.0.1:5174/app
```

The Go service applies the embedded `ao_*` PostgreSQL migrations at startup.
The website uses the Supabase public/anon key only. Service-role, database,
Daytona, encryption, worker-signing, and Git credentials remain server-side.

## Supabase configuration

1. Keep Email enabled under Authentication → Providers.
2. Add local redirect:

   ```text
   http://127.0.0.1:5174/auth/callback
   ```

3. Add the Vercel callback after deployment.
4. Obtain the pooled runtime and direct migration PostgreSQL URLs from the
   Supabase Connect panel.
5. Set `AO_DATABASE_URL` to the runtime connection and apply/verify migrations
   with the direct connection before production rollout.

Google OAuth can be enabled later without changing AO's account model.

The control plane validates HS256 Supabase access tokens through
`/auth/v1/user`. It does not locally trust or expose the legacy JWT signing
secret.

## Development GitHub mode

`AO_GITHUB_AUTH_MODE=local-gh` uses the host's current `gh auth token`.
Sandboxes never receive that long-lived token. Git operations use an
AO-authenticated repository proxy scoped to the session's registered
repository.

This mode works only while the control plane runs on the developer machine.
For a temporary Render deployment, set `AO_GITHUB_TOKEN` to a fine-grained
token limited to the repositories AO may use. The token remains in Render and
the control plane's Git proxy; sandboxes receive only scoped worker
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

Production should build and publish
`ao-cloud/docker/worker.Dockerfile`, create a Daytona snapshot from it, and
set `AO_DAYTONA_WORKER_SNAPSHOT` to that snapshot. Both local development and
the Render control-plane image set `AO_WORKER_BINARY_PATH`; the reconciler
uploads that versioned binary into the sandbox so worker and control-plane
protocol changes deploy together.

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

## Render deployment

`render.yaml` defines the always-on Go service. In Render:

1. Create a Blueprint from this repository.
2. Supply every `sync: false` variable.
3. Set `AO_CLOUD_PUBLIC_URL` to the Render HTTPS service URL.
4. Set `AO_WEB_PUBLIC_URL` to the final Vercel origin.
5. Set `AO_DATABASE_URL` to Supabase's pooled PostgreSQL URL.
6. Generate 64-character hexadecimal encryption and worker-signing keys.
7. Set `AO_GITHUB_TOKEN` to a fine-grained token for temporary testing, or use
   GitHub App mode when available.
8. Verify `/readyz` before allowing web traffic.

Render builds `ao-cloud/docker/control-plane.Dockerfile`. The service keeps
worker WebSockets and lifecycle reconciliation alive independently of Vercel.

## Vercel deployment

Import the repository into Vercel with:

```text
Root Directory: frontend/src/landing
Framework: Next.js
```

Set:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_API_URL=https://YOUR-RENDER-SERVICE
```

Then add:

```text
https://YOUR-VERCEL-DOMAIN/auth/callback
```

to the Supabase Auth redirect allowlist.

## Current deployed test profile

- Render hosts the live control plane.
- Supabase hosts authentication and the migrated PostgreSQL `ao_*` schema.
- Fly Machines is the active sandbox provider.
- The worker image is published to the Fly private registry.
- The cloud web app is verified locally against the hosted control plane;
  production web hosting remains a release decision.
- Daytona remains available behind the provider contract, but its earlier
  restricted-tier account blocked worker egress and is not the active provider.

See [`CURRENT_ARCHITECTURE.md`](CURRENT_ARCHITECTURE.md) for the exact runtime
and [`../docs/TODO-CLOUD.md`](../docs/TODO-CLOUD.md) for production gaps.
