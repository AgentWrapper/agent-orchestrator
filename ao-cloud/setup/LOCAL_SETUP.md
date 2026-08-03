# Run AO Cloud Locally

This starts the same Go control plane used for cloud deployments, a local
PostgreSQL database, local Docker worker sandboxes, and the cloud web app.

## What runs where

| Component | Local address or runtime |
| --- | --- |
| Cloud web app | `http://127.0.0.1:5174` |
| Control plane | Docker container published at `http://127.0.0.1:3010` |
| PostgreSQL | Docker on `127.0.0.1:5432` |
| Per-session sandbox | Local Docker container from `ao-cloud-worker:local` |

The Docker provider rewrites the worker's control-plane address to
`host.docker.internal`, so containers can call a CP running on the host.
The CP itself runs in Docker and is given the Docker socket only in local mode,
so it can create the dynamic session containers.

## Prerequisites

- Docker Desktop running
- Go and Node.js/npm installed
- An authenticated `gh` CLI (`gh auth login`) with access to repositories you
  will open
- A coding-agent credential to add through the Cloud settings UI

On macOS, Docker Desktop is enough for the Docker pieces. On Windows, use Docker
Desktop with the WSL 2 backend enabled and run the local Cloud commands from a
WSL shell, not PowerShell, Command Prompt, or Git Bash. Docker Desktop must have
integration enabled for that WSL distro so `docker` works inside WSL.

Local mode stores email/password credentials and sessions in the local
PostgreSQL database. Passwords are stored only as bcrypt hashes. It makes no
external authentication request.

You can also opt into the hosted-style WorkOS flow locally. In that mode, the
browser signs in through hosted WorkOS AuthKit, the web app reads the WorkOS
access token, and the Go control plane verifies that token through WorkOS JWKS
before syncing the user into AO's `ao_users` and organization tables.

## Start the stack

From the repository root, run one command:

```bash
npm run cloud:local
```

It runs these steps in order:

1. Creates `.env.cloud.local` from `ao-cloud/.env.example` if it is missing.
2. Generates `AO_ENCRYPTION_KEY` and `AO_WORKER_SIGNING_KEY` when they are blank.
3. Creates `frontend/src/landing/.env.local` with the local API URL if it is missing.
4. Reads `gh auth token` from the host and injects it into the local
   control-plane container for GitHub repository access.
5. Runs `npm install` for the root and cloud web app.
6. Builds `ao-cloud-worker:local` and the local control-plane image.
7. Starts Compose PostgreSQL and the control plane.
8. Waits for the control plane's `/readyz`, then starts the web app.
9. Streams control-plane, web-app, and Docker sandbox lifecycle logs in the
   current terminal until Ctrl-C.

The runner overrides stale environment values so this path always uses local
PostgreSQL, the loopback control plane, and Docker sandboxes. By default it uses
local CP auth. Repository cloning and the selected coding agent can still make
their normal external GitHub/provider API calls.

The generated local secrets are required by the control plane:

- `AO_ENCRYPTION_KEY` encrypts coding-agent credentials before they are stored
  in local PostgreSQL.
- `AO_WORKER_SIGNING_KEY` signs short-lived sandbox worker/bootstrap tokens.

The control-plane and web-app logs are written to:

```text
~/.ao/cloud-local/logs/control-plane.log
~/.ao/cloud-local/logs/web.log
```

`npm run cloud:local` stays attached to the log stream. Press Ctrl-C to
gracefully stop each local AO worker sandbox (with a 15-second grace period),
then stop the control-plane and PostgreSQL Compose services plus the web app.
It preserves worker workspace volumes and the database volume.

The runner reads the host `gh auth token` at startup. In local Docker mode, each
worker stores that token in its persistent AO data directory with mode `0600`
and configures the repository's Git credential helper to read it for clone,
fetch, pull, and push. This temporary local-only path is not enabled by the
hosted Daytona configuration; hosted deployments still require the planned
account-scoped GitHub App/provisioning path. If `gh` is unavailable or not
authenticated, repository cloning and PR/SCM actions are disabled until the
contributor runs `gh auth login`.

Open `http://127.0.0.1:5174`, create a local email/password account, connect a
coding-agent credential in Cloud settings, create a project, and start an
orchestrator or worker. Each session creates a local Docker sandbox and opens
the harness's actual terminal.

## Test WorkOS Locally

The default `npm run cloud:local` path remains CP-local auth because it has the
fewest prerequisites for contributors. To emulate hosted external auth locally,
create a WorkOS app and set:

```bash
AO_CLOUD_AUTH_MODE=workos
WORKOS_CLIENT_ID=client_...
WORKOS_API_KEY=sk_...
WORKOS_COOKIE_PASSWORD=<32+ character random secret>
NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://127.0.0.1:5174/callback
```

Configure the same redirect URI in the WorkOS dashboard.

Then run:

```bash
npm run cloud:local
```

In this mode the CP no longer serves the local `/api/cloud/v1/auth/login` and
`/signup` path. The UI uses WorkOS, and the CP accepts only signed WorkOS access
tokens from the browser. AO authorization still comes from AO's own org and
membership tables.

## Verify the local stack

Run the Cloud test suite against the Compose PostgreSQL database:

```bash
npm run cloud:test
```

Inspect active sandbox containers:

```bash
docker ps --filter label=ao.managed=true
```

Inspect the database container:

```bash
docker compose -f ao-cloud/docker-compose.local.yml ps
```

## Stop or clear the database

Stop local worker sandboxes, the control plane, web app, and database while
keeping their workspace/database volumes:

```bash
npm run cloud:local:stop
```

Delete the entire local AO Cloud PostgreSQL database, including accounts,
projects, sessions, credentials, and all test data. This stops the local stack,
deletes only its PostgreSQL volume, and does not start anything afterward:

```bash
npm run cloud:local:clear-db
```

`npm run cloud:local:reset-db` remains an alias for this command.

Delete all AO-managed sandbox containers:

```bash
ids="$(docker ps --all --quiet --filter label=ao.managed=true)"
[ -z "$ids" ] || docker rm --force $ids
```

The last command removes worker containers but does not remove their named
workspace volumes. Remove an individual volume only when you deliberately want
to discard that session's workspace:

```bash
volumes="$(docker volume ls --format '{{.Name}}' | rg '^ao-workspace-')"
[ -z "$volumes" ] || docker volume rm $volumes
```
