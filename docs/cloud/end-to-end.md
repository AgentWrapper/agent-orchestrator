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

Live run on 2026-07-29 with maintainer-provided Daytona and Claude credentials:

```text
Postgres: local Homebrew postgres on 127.0.0.1:54329
ao-cloud: 127.0.0.1:3021
tunnel 1: ngrok https://0fee-...ngrok-free.app
tunnel 2: localtunnel https://lovely-onions-buy.loca.lt
auth: AO_CLOUD_DEV_AUTH=1
project: agent-orchestrator registered through /api/v1/cloud/projects
```

Successful parts of the loop:

```text
spawn_elapsed_seconds=17
session.id=agent-orchestrator-6
terminalHandleId=agent-orchestrator-6
branch=ao/agent-orchestrator-6/root
initial status=idle
```

Direct Daytona pane inspection confirmed the real Claude process ran in the
sandbox and answered the prompt:

```text
AO cloud Daytona hooks are connected.
daytona@b3c67f44-678c-47f7-b2fe-4e962aab05da:~/ao/agent-orchestrator-6$
```

The remaining blocker is sandbox-to-local tunnel reachability. From the same
Daytona sandbox, unauthenticated `curl` to the public tunnel URL reset before
reaching `ao-cloud`; the in-sandbox `ao hooks` calls failed the same way:

```text
curl -i https://<ngrok-url>/healthz
curl: (35) Recv failure: Connection reset by peer

ao hooks claude-code user-prompt-submit:
Post "https://<ngrok-url>/api/v1/sessions/agent-orchestrator-6/activity":
read tcp 172.20.0.11:34060->3.14.182.203:443: read: connection reset by peer

ao hooks claude-code stop:
Post "https://<ngrok-url>/api/v1/sessions/agent-orchestrator-6/activity":
read tcp 172.20.0.11:58424->3.134.125.175:443: read: connection reset by peer
```

The ngrok and localtunnel URLs both served `/healthz` from the maintainer
machine, but reset from the Daytona sandbox. Until a tunnel or deployed
`AO_CLOUD_API_BASE` is reachable from Daytona, the final activity transition
cannot complete; the session remains `no_signal` even though Claude ran.

Local verification completed:

```text
cd backend && go build ./... && go test ./...
PASS (cloud Postgres integration tests skipped here because the local Docker
socket was unresponsive; the tests now skip after a bounded Docker preflight)

npm run frontend:typecheck
PASS
```

Maintainer still needs to provide the Daytona API key, Claude Code token, and a
tunnel or deployed cloud URL reachable from Daytona. For production auth
validation, provide real Google OAuth client credentials; until then, use
`AO_CLOUD_DEV_AUTH=1`.
