# AO Cloud control plane

Phase 1 adds the first multi-tenant AO Cloud control-plane skeleton. It reuses
the existing daemon service and HTTP controller boundaries, but swaps local
SQLite state for tenant-scoped Postgres state and wraps the API with cloud auth
and org selection.

## Scope

Included:

- `backend/cmd/ao-cloud` HTTP binary.
- Google OAuth authorization-code login endpoints.
- Device-code endpoints for CLI/desktop login plumbing.
- Short-lived HMAC JWT access tokens and server-stored refresh tokens.
- Tenant middleware for `Authorization: Bearer ...` plus `X-AO-Org-ID`.
- Postgres goose migrations for users, orgs, teams, devices, tokens,
  encrypted agent credentials, repo connections, sandboxes, usage events, audit
  log, and tenant-scoped AO project/session/CDC rows.
- `SecretsManager` port with a local AES-256-GCM development implementation.
- Existing project/session API read paths served through the cloud store.

Not included in Phase 1:

- Sandbox provisioning.
- Terminal streaming.
- Public web deployment.
- Billing, pricing, or payments. Only `usage_events` schema is present.
- GitHub login. GitHub remains a future linked integration.

## Local Postgres

Start a disposable local database:

```bash
docker run --rm --name ao-cloud-postgres \
  -e POSTGRES_USER=ao \
  -e POSTGRES_PASSWORD=ao \
  -e POSTGRES_DB=ao_cloud \
  -p 54329:5432 \
  postgres:16-alpine
```

Use this DSN:

```bash
export AO_CLOUD_DATABASE_URL='postgres://ao:ao@127.0.0.1:54329/ao_cloud?sslmode=disable'
```

## Configuration

Required for `ao-cloud`:

```bash
export AO_CLOUD_DATABASE_URL='postgres://ao:ao@127.0.0.1:54329/ao_cloud?sslmode=disable'
export AO_CLOUD_JWT_SECRET='replace-with-a-long-random-dev-secret'
export AO_CLOUD_SECRET_KEY='replace-with-a-long-random-secret-key'
```

Optional:

```bash
export AO_CLOUD_HOST=127.0.0.1
export AO_CLOUD_PORT=3011
export AO_CLOUD_REQUEST_TIMEOUT=60s
```

Google OAuth:

```bash
export AO_CLOUD_GOOGLE_CLIENT_ID='...apps.googleusercontent.com'
export AO_CLOUD_GOOGLE_CLIENT_SECRET='...'
export AO_CLOUD_GOOGLE_REDIRECT_URL='http://127.0.0.1:3011/auth/google/callback'
```

Create a Google OAuth web client with the redirect URL above. The callback
exchanges the authorization code for a Google identity, upserts the user,
creates a default org for first-time users, and returns an access/refresh token
pair.

## Run

From the repository root:

```bash
cd backend
go run ./cmd/ao-cloud
```

Health check:

```bash
curl http://127.0.0.1:3011/healthz
```

Start Google login:

```bash
open http://127.0.0.1:3011/auth/google/login
```

Authenticated API calls require both a bearer access token and an org scope
when the token can access more than one org:

```bash
curl -H "Authorization: Bearer $AO_CLOUD_ACCESS_TOKEN" \
  -H "X-AO-Org-ID: $AO_CLOUD_ORG_ID" \
  http://127.0.0.1:3011/api/v1/projects
```

## Tests

Cloud package tests:

```bash
cd backend
go test ./internal/cloud/... ./cmd/ao-cloud
```

The org-isolation integration test uses Testcontainers and a disposable
Postgres container:

```bash
cd backend
go test -v ./internal/cloud -run TestControlPlaneOrgIsolationThroughExistingAPI
```

If Docker is unavailable, the integration test skips with the provider error.
Where Docker is available, it boots Postgres, runs migrations, starts the
`ao-cloud` handler, creates two orgs, seeds same-ID projects/sessions in each,
and verifies each token can only see its own org through `/api/v1/projects` and
`/api/v1/sessions`.

