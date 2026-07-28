# AO Control Plane — deploy

The hosted, multi-tenant service that fronts cloud-sandbox provisioning. It
authenticates devices (Clerk), scopes everything to a tenant, holds the single
Daytona key, owns the cloud-session registry (Postgres), and relays REST to
sandboxes. **Sandboxes run on Daytona; Azure runs only this service.**

Artifacts here:
- `Dockerfile` — builds the control plane **+ bakes the linux `ao`** it uploads to sandboxes.
- `docker-compose.yml` — local Postgres (+ optional local control plane).
- `main.bicep` — Azure infra: Container Apps + ACR + Postgres Flexible Server + Key Vault.

Postgres is used **everywhere** (local Docker + Azure managed) — one engine, no
dev/prod drift.

---

## Local dev

```bash
# from backend/
cd deploy/controlplane

# DB only, iterate the Go service with `go run` (fastest loop):
docker compose up -d postgres
DAYTONA_API_KEY="$(az keyvault secret show --vault-name ao-testgate-kv --name daytona-api-key --query value -o tsv)" \
GITHUB_TOKEN="$(gh auth token)" \
AO_LINUX_BINARY=/tmp/ao-linux-amd64 \
CONTROLPLANE_DB='postgres://ao:ao@localhost:5432/ao_controlplane?sslmode=disable' \
  go run ../../cmd/controlplane

# OR the full stack in containers:
DAYTONA_API_KEY=... GITHUB_TOKEN=... docker compose up --build
```

Auth: with `CLERK_JWKS_URL` unset it runs **DEV auth** — the `X-AO-Tenant` header
is trusted (any caller can claim any tenant). Fine locally; **never** expose a
public endpoint in this mode. Test:

```bash
curl -s -H 'X-AO-Tenant: acme' http://127.0.0.1:8080/api/v1/cloud/capabilities
```

To exercise **real Clerk verification locally** (the same code path as prod),
add the Clerk env — the server then verifies RS256 JWTs against Clerk's public
JWKS and derives the tenant from `org_id` (falling back to `sub`):

```bash
CLERK_JWKS_URL='https://valued-weasel-0.clerk.accounts.dev/.well-known/jwks.json' \
CLERK_ISSUER='https://valued-weasel-0.clerk.accounts.dev' \
DAYTONA_API_KEY="$(az keyvault secret show --vault-name ao-testgate-kv --name daytona-api-key --query value -o tsv)" \
CONTROLPLANE_DB='postgres://ao:ao@localhost:5432/ao_controlplane?sslmode=disable' \
  go run ../../cmd/controlplane
# then call it with a real token from the Electron app:
#   curl -s -H "Authorization: Bearer <clerk-jwt>" http://127.0.0.1:8080/api/v1/cloud/capabilities
```

The publishable key + JWKS/issuer above are **public**. The Clerk **secret key**
is not needed for JWT verification (that uses the public JWKS); if a later
backend Clerk call needs it, it lives in Key Vault as `clerk-secret-key`.

---

## Azure deploy (Container Apps) — NOT run yet

> Nothing below has been provisioned. It creates billable resources; run only
> when ready. **Wire Clerk first** (or keep ingress restricted) — a public
> endpoint on DEV auth is an open door.

```bash
# 0. one-time: log in + pick the subscription
az login
az account set --subscription "<sub>"

# 1. resource group + ACR (from main.bicep's namePrefix; default "aocp")
az group create -n ao-controlplane-rg -l centralindia
az deployment group create -g ao-controlplane-rg -f main.bicep \
  -p namePrefix=aocp \
     postgresAdminPassword='<strong-pw>' \
     daytonaApiKey='<daytona-key>' \
     githubToken='<gh-token>' \
     clerkJwksUrl='https://valued-weasel-0.clerk.accounts.dev/.well-known/jwks.json' \
     clerkIssuer='https://valued-weasel-0.clerk.accounts.dev' \
     containerImage='aocpacr.azurecr.io/ao-controlplane:latest'
```

But the image must exist in the ACR **before** the Container App can pull it, so
the real order is: create ACR (deploy once, or `az acr create`), build+push the
image, then (re)deploy the app. Practical sequence:

```bash
# a. build + push the image to the ACR created by the deployment
az acr login -n aocpacr
docker build -f deploy/controlplane/Dockerfile -t aocpacr.azurecr.io/ao-controlplane:latest ..   # context = backend/
docker push aocpacr.azurecr.io/ao-controlplane:latest

# b. deploy (idempotent) — the Container App picks up the image
az deployment group create -g ao-controlplane-rg -f main.bicep -p ...   # as above

# c. the control-plane URL:
az deployment group show -g ao-controlplane-rg -n main --query properties.outputs.controlPlaneFqdn.value -o tsv
```

Secrets (Daytona key, Postgres DSN, GitHub token) go into **Key Vault** by the
deployment; the Container App reads them via its **managed identity** (RBAC:
AcrPull + Key Vault Secrets User, both assigned by the Bicep). No secret is
baked into the image or committed.

### Production notes
- **Clerk required** before public traffic — set `clerkJwksUrl` / `clerkIssuer`.
- Postgres starts on the cheapest **Burstable B1ms**; scale the SKU up in
  `main.bicep` as load grows. Registry-in-Postgres means the app can run
  **multiple replicas** safely (`scale.maxReplicas: 3`, scale-to-zero when idle).
- The WebSocket **terminal relay** is not implemented yet (only REST `/cloud/proxy`
  is relayed); `transport: auto` on ingress already supports WS for when it lands.
