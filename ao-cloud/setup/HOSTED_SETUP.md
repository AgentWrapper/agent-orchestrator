# Host AO Cloud on a persistent Azure VM

This deployment keeps the AO control plane and PostgreSQL together on one
Azure VM, while running them as separate Docker containers. Caddy terminates
public HTTPS; PostgreSQL and the control plane are not published to the
Internet.

This is a practical single-VM deployment, not a highly available database
design. The VM disk and backups are production data.

## Images and services

The hosted Compose stack builds the persistent
`ao-cloud/docker/control-plane.Dockerfile` image and runs it beside
`postgres:17-alpine`, with Caddy as the HTTPS edge. Those are the only
always-on AO services on the VM.

`ao-cloud/docker/worker.Dockerfile` is a separate, dynamic sandbox image. It
is not a Compose service: each orchestrator or worker session gets its own
sandbox from that image. Orchestrators and workers intentionally share one
worker image; AO changes their role through session configuration rather than
maintaining separate images. For Daytona, publish that image as a snapshot and
set `AO_DAYTONA_WORKER_SNAPSHOT`.

## Prerequisites

- An Azure Linux VM with a durable managed disk, Docker Engine, and the Docker
  Compose plugin installed.
- A DNS name whose A/AAAA record points to the VM public IP. Caddy obtains and
  renews the TLS certificate automatically.
- A Daytona API key and a published worker snapshot.

Configure the VM network security group to allow TCP 80 and 443. Do not open
TCP 3010 or 5432: Caddy is the only public Compose service.

## Publish the worker snapshot

The control plane creates one Daytona sandbox from a versioned snapshot for
every orchestrator or worker. Publish the snapshot from the checked-out release
commit before starting the control plane:

```bash
export AO_WORKER_VERSION="$(git rev-parse HEAD)"
export AO_DAYTONA_WORKER_SNAPSHOT="ao-worker-${AO_WORKER_VERSION:0:12}"
npm run cloud:publish-worker
```

Copy the resulting `AO_DAYTONA_WORKER_SNAPSHOT` value into
`ao-cloud/.env.hosted`. The publisher refuses to build from a different commit
and never replaces a snapshot implicitly; publish a new snapshot name for each
release, then deploy the control plane with that name.

## First deployment

On the VM, clone the repository and make the host-specific environment file:

```bash
cp ao-cloud/.env.hosted.example ao-cloud/.env.hosted
chmod 600 ao-cloud/.env.hosted
```

Fill every blank value. Generate three independent secrets:

```bash
openssl rand -hex 32 # AO_POSTGRES_PASSWORD
openssl rand -hex 32 # AO_ENCRYPTION_KEY
openssl rand -hex 32 # AO_WORKER_SIGNING_KEY
```

`AO_POSTGRES_PASSWORD` must remain URL-safe because Compose puts it into the
PostgreSQL connection URL. The hexadecimal command above satisfies that
requirement.

Start the stack from the repository root:

```bash
docker compose --env-file ao-cloud/.env.hosted \
  -f ao-cloud/docker-compose.hosted.yml up --build -d
```

The control plane applies its embedded `ao_*` migrations on startup. Check
container status and readiness through the TLS proxy:

```bash
docker compose --env-file ao-cloud/.env.hosted \
  -f ao-cloud/docker-compose.hosted.yml ps
curl --fail https://cloud.example.com/readyz
```

Set `AO_CLOUD_PUBLIC_URL` and `AO_CLOUD_DOMAIN` to that same public HTTPS
origin/domain and set `AO_WEB_PUBLIC_URL` to the deployed web application's
origin. Configure the web application with `NEXT_PUBLIC_API_URL` pointing to
`AO_CLOUD_PUBLIC_URL`; hosted accounts use the control plane's PostgreSQL-backed
email/password login.

## Updates

Before changing the control-plane image, take a database backup. Then pull the
new source/image and recreate only the control plane:

```bash
docker compose --env-file ao-cloud/.env.hosted \
  -f ao-cloud/docker-compose.hosted.yml up --build -d --no-deps control-plane
```

Do not run `docker compose down --volumes` on this VM: it deletes the named
PostgreSQL volume. Ordinary `docker compose down` preserves it.

## Backups and restore

Create a timestamped logical backup on the VM, validate it, then copy it to
independent encrypted storage:

```bash
set -a
. ao-cloud/.env.hosted
set +a
db_user="${AO_POSTGRES_USER:-ao}"
db_name="${AO_POSTGRES_DATABASE:-ao_cloud}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
docker compose --env-file ao-cloud/.env.hosted \
  -f ao-cloud/docker-compose.hosted.yml exec -T postgres \
  pg_dump -U "$db_user" -d "$db_name" --format=custom --no-owner \
  >"backups/ao-cloud-${stamp}.dump"
pg_restore --list "backups/ao-cloud-${stamp}.dump" >/dev/null
```

Test restores on a non-production VM. To restore deliberately, stop the control
plane, restore into the intended database with `pg_restore`, then restart the
control plane. Restoring overwrites durable application state; do not use it as
a normal recovery shortcut.

The named `ao-cloud-postgres` volume preserves the database across container
restarts and image updates, but it is not a backup. Configure Azure disk
snapshots and copy logical backups off the VM before treating this as a
production service.

## Recovery boundaries

- PostgreSQL persists accounts, credentials, projects, session metadata, and
  terminal output required for reconnect.
- Each Daytona sandbox retains its own provider-managed workspace volume; the
  database does not reconstruct uncommitted filesystem changes if that volume
  is deleted.
- If the VM or its disk is lost, recovery requires restoring the PostgreSQL
  backup and redeploying the control plane with the same
  `AO_ENCRYPTION_KEY` and `AO_WORKER_SIGNING_KEY`. Losing either key makes
  encrypted credentials or outstanding worker tokens unusable.
