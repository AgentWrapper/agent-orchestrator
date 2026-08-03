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
- For either WorkOS command, `cloudflared` and the test GitHub App private key
  saved as `~/.ao/cloud-local/github-app.private-key.pem` with mode `0600`

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
2. Generates encryption/signing, WorkOS cookie, GitHub App state, and GitHub
   App webhook secrets when they are blank.
3. Creates `frontend/src/landing/.env.local` with the local API URL if it is missing.
4. In the default local-auth mode, reads `gh auth token` from the host and
   injects it into the local control-plane container for GitHub repository
   access. WorkOS mode uses the GitHub App instead.
5. Runs `npm install` for the root and cloud web app.
6. Builds `ao-cloud-worker:local` and the local control-plane image.
7. Starts Compose PostgreSQL and the control plane.
8. Waits for the control plane's `/readyz`, then starts the web app.
9. For either WorkOS command, starts a webhook-only Cloudflare Quick Tunnel and
   prints its dynamic GitHub webhook URL.
10. Streams control-plane, web-app, and Docker sandbox lifecycle logs in the
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

The default `npm run cloud:local` command reads the host `gh auth token`. In
local Docker mode, each worker stores that token in its persistent AO data
directory with mode `0600` and configures the repository's Git credential
helper to read it for clone, fetch, pull, and push. This explicit local-only path
does not use the GitHub App. If `gh` is unavailable or not authenticated,
repository cloning and PR/SCM actions are disabled until the contributor runs
`gh auth login`.

Open `http://127.0.0.1:5174`, create a local email/password account, connect a
coding-agent credential in Cloud settings, create a project, and start an
orchestrator or worker. Each session creates a local Docker sandbox and opens
the harness's actual terminal.

## Test WorkOS Locally

The default `npm run cloud:local` path remains CP-local auth because it has the
fewest prerequisites for contributors. To emulate hosted external auth locally,
create a WorkOS app and configure its dashboard URLs:

```text
Redirect URI:       http://127.0.0.1:5174/callback
App homepage URL:   http://127.0.0.1:5174
Initiate login URI: http://127.0.0.1:5174/auth/workos/sign-in
Sign-out URI:       http://127.0.0.1:5174/auth
Allowed web origin: http://127.0.0.1:5174
```

Use `127.0.0.1` consistently. Do not open the app as `localhost`: browser
cookies are scoped by hostname, while WorkOS returns to the configured
`127.0.0.1` callback.

Then add the WorkOS app values to `.env.cloud.local`:

```bash
WORKOS_CLIENT_ID=client_...
WORKOS_API_KEY=sk_...
WORKOS_COOKIE_PASSWORD=<32+ character random secret>
WORKOS_REDIRECT_URI=http://127.0.0.1:5174/callback
NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://127.0.0.1:5174/callback
```

### Configure the test GitHub App

The WorkOS commands use the hosted-style GitHub App flow, not the host `gh`
credential. The local runner expects these test-app defaults:

```text
App ID:    4475070
Client ID: Iv23lIaAnXMSyGGzVI4
App slug:  ao-cloud-test
```

In the GitHub App settings, configure:

```text
Homepage URL: http://127.0.0.1:5174
Setup URL:    http://127.0.0.1:3010/api/cloud/v1/github/install/callback
```

That second field is the **Setup URL**, under post-installation settings. It is
not a GitHub OAuth callback URL. Leave GitHub user OAuth unconfigured and leave
“Request user authorization (OAuth) during installation” disabled. AO does not
request GitHub user authorization in this flow.

Enable the webhook and keep SSL verification on. The Webhook URL is not fixed:
`npm run cloud:workos` and `npm run cloud:workos:gated` start a Cloudflare Quick
Tunnel and print the full dynamic URL to use. It ends in
`/api/cloud/v1/github/webhooks` and changes when the runner is restarted.

Set these repository permissions:

```text
Contents:        Read and write
Issues:          Read-only
Pull requests:   Read and write
Checks:          Read-only
Commit statuses: Read-only
Workflows:       Read and write
Metadata:        Read-only (implicit)
```

Subscribe to these events:

```text
installation
installation_repositories
pull_request
pull_request_review
pull_request_review_thread
check_run
check_suite
status
```

Generate a private key in the GitHub App settings, save the downloaded PEM at
`~/.ao/cloud-local/github-app.private-key.pem`, and restrict it:

```bash
chmod 600 ~/.ao/cloud-local/github-app.private-key.pem
```

Install `cloudflared` if needed:

```bash
brew install cloudflared
```

On first run, the runner generates `AO_GITHUB_APP_STATE_SECRET` and
`AO_GITHUB_APP_WEBHOOK_SECRET` in `.env.cloud.local`.

Then run one of these:

```bash
npm run cloud:workos        # WorkOS with local self-serve signup enabled
npm run cloud:workos:gated  # WorkOS with invite-gated signup, like hosted
```

`npm run cloud:local` always runs the local email/password flow. The WorkOS
commands force `AO_CLOUD_AUTH_MODE=workos` for the current run. The local runner
generates `WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI`, and
`NEXT_PUBLIC_WORKOS_REDIRECT_URI` if they are blank; it cannot generate
`WORKOS_CLIENT_ID` or `WORKOS_API_KEY` because those come from your WorkOS app.
Both WorkOS commands also require the private key at the path above and
`cloudflared`. The runner validates the key and its permissions, starts the
webhook relay and Quick Tunnel, and prints only the dynamic Webhook URL; it does
not print either generated GitHub secret.

While the runner remains active, paste its printed Webhook URL into the GitHub
App. Open `.env.cloud.local` in an editor and paste the
`AO_GITHUB_APP_WEBHOOK_SECRET` value into GitHub's Webhook secret field. Do not
print, echo, or paste the secret into a terminal. The state secret remains
AO-only and must not be entered in GitHub.

### Exercise the GitHub App flow

1. Sign in to AO as an owner or admin, open **Settings → GitHub**, and select
   **Connect GitHub**.
2. On GitHub, choose the account and either all repositories or selected
   repositories, then install the App. GitHub returns through the Setup URL.
3. Review the server-verified account, account type, and repository count in AO,
   then select **Confirm** to consume the signed, single-use install attempt.
   Back in GitHub settings, select **Sync** and confirm the grants remain current.
4. Create a project and verify its repository picker contains only an active
   grant. Create the project and start a session to exercise clone/fetch and SCM
   reads through the control-plane repository proxy.
5. Select **Configure**, change the installation's selected repositories in
   GitHub, return to AO, and select **Sync**. Verify newly selected repositories
   appear and removed repositories can no longer be selected for projects.
6. Select **Disconnect**, confirm the prompt, and verify that installation's
   grants are no longer available to new or running project operations.

AO verifies that the install attempt was initiated by the current AO
organization owner/admin and that the returned installation belongs to the
configured App. Because this deliberately selected flow has no GitHub user
OAuth, AO cannot cryptographically prove that the same GitHub human clicked
Install. The initiating AO owner/admin must confirm the account and repository
selection on GitHub before completing the installation.

In GitHub App mode, workers receive only AO worker credentials. The control
plane checks the active organization/repository grant and mints a short-lived
installation token restricted to one repository and the immediate operation.
That token stays in control-plane memory and is never returned in worker
bootstrap data, persisted in the worker, or logged. The GitHub App private key
also never enters a worker.

In this mode the CP no longer serves the local `/api/cloud/v1/auth/login` and
`/signup` path. The UI uses WorkOS, and the CP accepts only signed WorkOS access
tokens from the browser. AO authorization still comes from AO's own org and
membership tables. After validating a token, the CP uses the server-only
`WORKOS_API_KEY` to retrieve the user's verified email/name from WorkOS; this
keeps invitation matching and personal-workspace labels independent of opaque
WorkOS user IDs.

## Verify the local stack

Run the Cloud test suite against the Compose PostgreSQL database:

```bash
npm run cloud:test
```

Run the focused GitHub App and local relay tests:

```bash
cd backend
go test ./internal/cloud/config ./internal/cloud/httpapi ./internal/cloud/postgres \
  ./internal/cloud/scm/githubapp ./internal/cloud/scm/localgh
cd ..
node --test ao-cloud/scripts/webhook-relay.test.mjs
npm --prefix frontend/src/landing test -- \
  src/app/app/page.test.tsx \
  src/app/app/github/callback/page.test.tsx \
  src/lib/cloud-api.test.ts
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
