# AO Cloud end-to-end session runbook

Status: Phase 1+2 integration wiring is present on `cloud/integration`.

This runbook starts `ao-cloud`, creates a dev-auth org, spawns a Claude Code
session in a Daytona sandbox, and verifies that sandbox activity reaches the
control plane.

## Required inputs

Never print or commit these values:

- `DAYTONA_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN`
- Any tunnel auth token

Also required:

- A Daytona snapshot containing tmux, git, Claude Code, and `/usr/local/bin/ao`.
  Build/push instructions are in `docs/cloud/daytona-runtime.md`.
- A base URL for `ao-cloud` in `AO_CLOUD_API_BASE`. In production this must be a
  public HTTPS URL reachable from Daytona sandboxes. Local E2E can use the
  Daytona activity bridge when tunnel egress is blocked.
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

This is the preferred production-like callback path. `ao-cloud` still injects
`AO_CLOUD_API_BASE` into each sandbox as `AO_API_BASE`, with a per-session
`AO_API_TOKEN`, so `ao hooks` can POST directly to the control plane.

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

If Daytona egress to quick-tunnel domains resets, local E2E can still validate
activity with the Daytona bridge. Set `AO_CLOUD_API_BASE` to the local URL
(`http://127.0.0.1:3011`) and continue; direct sandbox POSTs will fail, but the
control plane will read the sandbox activity spool through Daytona's toolbox API
and apply those events through the same lifecycle manager.

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
# Optional: makes active -> idle visible in local polling demos.
export AO_CLOUD_ACTIVITY_ACTIVE_GRACE_SECONDS=6

go run ./cmd/ao-cloud
```

`AO_CLOUD_API_BASE` is injected into each sandbox as `AO_API_BASE`. `ao-cloud`
mints a per-session JWT and injects it as `AO_API_TOKEN`; the token is accepted
only for `POST /api/v1/sessions/{that-session}/activity`. For Daytona sessions,
`ao-cloud` also watches a sandbox-local activity spool over Daytona's toolbox
API as a fallback for local E2E environments where sandbox-to-tunnel traffic is
blocked.

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
AO_CLOUD_API_BASE: http://127.0.0.1:3021
activity fallback: Daytona toolbox activity bridge
AO_CLOUD_ACTIVITY_ACTIVE_GRACE_SECONDS=6
auth: AO_CLOUD_DEV_AUTH=1
project: agent-orchestrator registered through /api/v1/cloud/projects
```

Successful loop:

```text
spawn_elapsed_seconds=18
session.id=agent-orchestrator-8
terminalHandleId=agent-orchestrator-8
branch=ao/agent-orchestrator-8/root
```

Activity observed through the control-plane API:

```text
poll_02=2026-07-29T22:22:27Z
{
  "id": "agent-orchestrator-8",
  "status": "working",
  "activity": {
    "state": "active",
    "lastActivityAt": "2026-07-29T15:22:26-07:00"
  }
}

poll_11=2026-07-29T22:22:36Z
{
  "id": "agent-orchestrator-8",
  "status": "idle",
  "activity": {
    "state": "idle",
    "lastActivityAt": "2026-07-29T15:22:35-07:00"
  }
}
```

Direct Daytona pane inspection confirmed the real Claude process ran in the
sandbox and answered the prompt:

```text
AO cloud Daytona bridge delivered activity.
daytona@3dcd75f3-5035-489f-82b4-c7687d4dff24:~/ao/agent-orchestrator-8$
```

## Desktop dev-mode cloud tasks

The desktop dev app has a Developer Mode setting for testing this path from the
product UI.

1. Start `ao-cloud` with Daytona as above. For local UI testing, `AO_CLOUD_PORT`
   can be any free port; set the same value in Settings as `AO Cloud URL`.
2. Start the Electron dev app.
3. Open Settings, enable Developer Mode, then enable `AO Cloud tasks`.
4. Set `AO Cloud URL` to the local control-plane URL, for example
   `http://127.0.0.1:3022`.
5. Click `Connect & register`. This uses `/auth/dev/token` and registers the
   configured cloud project through `/api/v1/cloud/projects`.
6. Use `New task`. When `AO Cloud tasks` is enabled and ready, the same dialog
   spawns the worker through `ao-cloud` and the board/sidebar polling includes
   cloud projects and sessions.
7. Select the cloud worker. The terminal pane attaches to `ao-cloud`'s `/mux`
   WebSocket with the dev access token and opens a Daytona tmux attach stream
   for the session's `terminalHandleId`.

The terminal pane uses the same frontend mux client as local sessions, but points
it at the configured `AO Cloud URL`. `ao-cloud` authenticates the WebSocket
query token, scopes the request to the selected org, then authorizes the runtime
handle before delegating to the Daytona runtime adapter.

Tunnel reachability note: ngrok, Cloudflare quick tunnels, and localtunnel all
served `/healthz` from the maintainer machine, but Daytona sandbox `curl` calls
to those URLs reset before reaching `ao-cloud`. The bridge is what makes local
E2E reproducible in that network shape; production should use a deployed
`AO_CLOUD_API_BASE` or a tunnel known to be reachable from Daytona.

Local verification completed:

```text
cd backend && go build ./... && go test ./...
PASS (cloud Postgres integration tests skipped here because the local Docker
socket was unresponsive; the tests now skip after a bounded Docker preflight)

npm run frontend:typecheck
PASS
```

For production auth validation, provide real Google OAuth client credentials;
until then, use `AO_CLOUD_DEV_AUTH=1`.
