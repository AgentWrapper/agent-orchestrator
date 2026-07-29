# AO Cloud end-to-end session runbook

Status: Phase 1+2 integration wiring is present on `cloud/integration`.

This runbook starts `ao-cloud`, exposes it to Daytona through a tunnel, creates
a dev-auth org, spawns a Claude Code session in a Daytona sandbox, and verifies
that in-sandbox `ao hooks` activity reaches the control plane.

## Required inputs

Never print or commit these values:

- `DAYTONA_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN`
- Any tunnel auth token

Also required:

- A Daytona snapshot containing tmux, git, Claude Code, and `/usr/local/bin/ao`.
  Build/push instructions are in `docs/cloud/daytona-runtime.md`.
- A reachable public HTTPS base URL for the local `ao-cloud` API. For local
  testing, use `cloudflared` or `ngrok` as shown below.
- For production auth testing: Google OAuth web client id/secret and redirect
  URL. For local e2e without Google creds, set `AO_CLOUD_DEV_AUTH=1`.

## Start Postgres

```bash
docker run --rm --name ao-cloud-postgres \
  -e POSTGRES_USER=ao \
  -e POSTGRES_PASSWORD=ao \
  -e POSTGRES_DB=ao_cloud \
  -p 54329:5432 \
  postgres:16-alpine
```

## Start a tunnel

Cloudflare quick tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:3011
```

Copy the printed `https://...trycloudflare.com` URL into `AO_CLOUD_API_BASE`.

ngrok:

```bash
ngrok http 3011
```

Copy the printed `https://...ngrok-free.app` URL into `AO_CLOUD_API_BASE`.

## Start ao-cloud with Daytona runtime

```bash
cd backend
export AO_CLOUD_DATABASE_URL='postgres://ao:ao@127.0.0.1:54329/ao_cloud?sslmode=disable'
export AO_CLOUD_JWT_SECRET='replace-with-a-long-random-dev-secret'
export AO_CLOUD_SECRET_KEY='replace-with-a-long-random-secret-key'
export AO_CLOUD_HOST=127.0.0.1
export AO_CLOUD_PORT=3011
export AO_CLOUD_RUNTIME=daytona
export AO_CLOUD_API_BASE='https://YOUR-TUNNEL.example'
export AO_CLOUD_DEV_AUTH=1
export DAYTONA_API_KEY
export AO_DAYTONA_SNAPSHOT='ao-agent-sandbox:dev'
export CLAUDE_CODE_OAUTH_TOKEN

go run ./cmd/ao-cloud
```

`AO_CLOUD_API_BASE` is injected into each sandbox as `AO_API_BASE`. `ao-cloud`
mints a per-session JWT and injects it as `AO_API_TOKEN`; the token is accepted
only for `POST /api/v1/sessions/{that-session}/activity`.

## Authenticate and create the default org

In another shell:

```bash
export AO_CLOUD_URL=http://127.0.0.1:3011
AUTH_JSON=$(curl -sS -X POST "$AO_CLOUD_URL/auth/dev/token" \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","name":"AO Cloud Dev"}')
export AO_CLOUD_ACCESS_TOKEN=$(printf '%s' "$AUTH_JSON" | jq -r .accessToken)
export AO_CLOUD_ORG_ID=$(printf '%s' "$AUTH_JSON" | jq -r '.orgs[0].ID')
```

For Google/device-flow testing, replace this with the real Google OAuth flow.
The maintainer still needs to provide `AO_CLOUD_GOOGLE_CLIENT_ID`,
`AO_CLOUD_GOOGLE_CLIENT_SECRET`, and `AO_CLOUD_GOOGLE_REDIRECT_URL`.

## Register a project

Use a clone URL reachable from the Daytona sandbox. For private repos, provide
`AO_CLOUD_GIT_USERNAME` and `AO_CLOUD_GIT_PASSWORD` to `ao-cloud` before spawn.

```bash
curl -sS -X POST "$AO_CLOUD_URL/api/v1/cloud/projects" \
  -H "Authorization: Bearer $AO_CLOUD_ACCESS_TOKEN" \
  -H "X-AO-Org-ID: $AO_CLOUD_ORG_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "id":"agent-orchestrator",
    "repoUrl":"https://github.com/Untrivial-ai/agent-orchestrator.git",
    "name":"agent-orchestrator",
    "defaultBranch":"main",
    "workerAgent":"claude-code",
    "permissions":"bypass-permissions"
  }'
```

## Spawn a cloud session

```bash
START=$(date +%s)
SPAWN_JSON=$(curl -sS -X POST "$AO_CLOUD_URL/api/v1/sessions" \
  -H "Authorization: Bearer $AO_CLOUD_ACCESS_TOKEN" \
  -H "X-AO-Org-ID: $AO_CLOUD_ORG_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId":"agent-orchestrator",
    "kind":"worker",
    "harness":"claude-code",
    "displayName":"cloud e2e",
    "prompt":"Say exactly: AO cloud Daytona hooks are connected."
  }')
date +%s | awk -v start="$START" '{print "spawn_elapsed_seconds=" ($1-start)}'
export AO_CLOUD_SESSION_ID=$(printf '%s' "$SPAWN_JSON" | jq -r .session.id)
printf '%s\n' "$SPAWN_JSON" | jq .
```

## Verify activity reaches the control plane

Poll until `status`/`activity.state` transitions through active/idle and does
not remain permanently idle/no-signal:

```bash
for i in $(seq 1 60); do
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  curl -sS "$AO_CLOUD_URL/api/v1/sessions/$AO_CLOUD_SESSION_ID" \
    -H "Authorization: Bearer $AO_CLOUD_ACCESS_TOKEN" \
    -H "X-AO-Org-ID: $AO_CLOUD_ORG_ID" | jq '.session | {id,status,activity}'
  sleep 5
done
```

## Worker-run result

This worker could not execute the live Daytona/Claude loop because the required
live inputs were absent in the environment:

```text
DAYTONA_API_KEY=missing
CLAUDE_CODE_OAUTH_TOKEN=missing
AO_CLOUD_GOOGLE_CLIENT_ID=missing
AO_CLOUD_GOOGLE_CLIENT_SECRET=missing
AO_CLOUD_API_BASE=missing
```

Local verification completed:

```text
cd backend && go build ./... && go test ./...
PASS (cloud Postgres integration tests skipped here because the local Docker
socket was unresponsive; the tests now skip after a bounded Docker preflight)

npm run frontend:typecheck
PASS
```

Maintainer still needs to provide the Daytona API key, Claude Code token, and a
tunnel URL to run the live loop above. For production auth validation, provide
real Google OAuth client credentials; until then, use `AO_CLOUD_DEV_AUTH=1`.
