# AO Cloud Design

Status: implemented Cloud product foundation plus a live AWS/Vercel demo
deployment. Production automation and hardening remain in progress.

The control plane, PostgreSQL schema, organization authorization, WorkOS JWT
boundary, GitHub App install/webhook flow, worker transport, browser Cloud
surface, ECS/Fargate provider, and deletion/quota boundaries are implemented.
The current demo runs the web app on Vercel, the control plane on AWS EC2, the
database on private RDS, and one worker task per session on ECS/Fargate. This
document distinguishes that working deployment from production automation,
enterprise hardening, and operational work that remain to be done.

## Non-negotiable boundary

```text
Cloud web app → authenticated AO Cloud control plane → cloud sandboxes
```

- The **cloud web app is the only client for AO Cloud projects**.
- The Electron desktop app, local `ao` CLI, local daemon, local SQLite state,
  and local worktrees **never call AO Cloud**.
- Local AO and AO Cloud remain separate products with separate authorities.
  They may share domain vocabulary, agent adapters, and carefully versioned
  semantic contracts, but they do not synchronize sessions or databases.
- A browser never calls a sandbox directly. It uses the control plane for
  commands, events, terminal brokering, previews, and authorization.

## Shared semantic contracts

The shared boundary is `backend/internal/contract`. It is deliberately
storage-free and authority-free: no SQLite, no PostgreSQL, no Docker, no
Daytona, no Electron, no browser API. It only defines AO meanings that must stay
the same across local and Cloud.

The contract currently covers:

- session roles, activity states, and derived display/Kanban statuses
- normalized SCM facts for PR state, CI, review verdict, mergeability, stack
  branch relationships, and unresolved review comments
- shared status derivation, including stack-aware PR aggregation and `no_signal`
  behavior
- workspace file/diff vocabulary for file status, old path, additions,
  deletions, binary markers, and compare mode
- portable `ao` lifecycle/SCM command names used by local-like Cloud worker CLI
  commands

Local AO maps its SQLite, worktree, and harness-hook facts into these contract
types. AO Cloud maps PostgreSQL, GitHub, and sandbox facts into the same types.
The control plane remains the Cloud authority and the local daemon remains the
desktop authority, but the rule "CI failing means `ci_failed`" or "a clean PR
means `mergeable`" is implemented once.

## Design references

- Product/UI direction: [`../../DESIGN.md`](../../DESIGN.md). Cloud retains AO's dense,
  dark, refined-blue control-surface language while using browser-appropriate
  interaction rather than Electron APIs.
- Local setup, current hosted topology, environment placement, and release
  runbook: [`../README.md`](../README.md).
- Hosted-sessions research reference:
  <https://gist.github.com/Pritom14/7e4c4075938d89de16f740b61b18916e>.

The hosted-sessions reference is useful for provider abstraction, trusted
control-plane versus untrusted-sandbox separation, and tenant boundaries. Its
desktop-to-cloud/federated-local model is explicitly **not** part of this
design.

## Current cloud schema

The current PostgreSQL schema is organization-scoped. These are separate
tables, linked with foreign keys:

| Table | Current responsibility |
| --- | --- |
| `ao_accounts` | Legacy compatibility mapping from pre-organization Cloud accounts to personal organizations. |
| `ao_users` | Durable AO user mapped to a local or external identity-provider subject. |
| `ao_organizations` | AO tenant: personal, team, or enterprise workspace. |
| `ao_org_memberships` | User-to-organization role (`owner`, `admin`, `member`, or `viewer`). |
| `ao_org_invitations` | Durable invitation lifecycle. |
| `ao_projects` | Registered repository projects, owned by `org_id`. |
| `ao_sessions` | Orchestrator and worker sessions: kind, harness, branch, activity, termination, and native agent session ID. |
| `ao_commands` | Idempotent command receipts, results, and failures. |
| `ao_session_sequences` | Allocates the next ordered event sequence for each session. |
| `ao_events` | Append-only, replayable lifecycle, chat, terminal, and worker events. |
| `ao_turns` | One durable user-message-to-agent-response run, including its state, worker epoch, attempts, and completion/failure. |
| `ao_sandboxes` | Session-to-provider-environment mapping, desired/observed lifecycle state, retry lease, resource profile, and last error. |
| `ao_worker_connections` | The current worker identity, epoch, capabilities, and heartbeat timestamps for a sandbox. |
| `ao_provider_connections` | Encrypted coding-agent and optional sandbox-provider connection metadata. |
| `ao_access_tickets` | One-time, short-lived worker bootstrap, terminal, and preview access grants. |
| `ao_audit_events` | Audit-log foundation: actor, action, resource, metadata, and time. |
| `ao_pull_requests` | Normalized pull-request facts observed for a session. |
| `ao_pr_checks` | CI/check facts belonging to a normalized pull request. |
| `ao_github_install_attempts` | Signed, expiring, single-use AO user/org installation attempts. |
| `ao_github_installations` | Per-organization bindings for user-owned GitHub App installations; a connection is inherited by every AO organization that user creates. |
| `ao_github_repositories` | Canonical GitHub repository identity and metadata. |
| `ao_github_repository_grants` | Durable intervals in which an installation grants an AO organization access to a repository. |
| `ao_github_webhook_deliveries` | Signed, deduplicated, retryable GitHub webhook inbox. |
| `ao_org_provider_settings` | Organization policy for custom versus personal-default agent credentials. |
| `ao_project_share_links` | Revocable, expiring project/session share links. |
| `ao_project_share_grants` | Durable project access granted after a share link is redeemed. |
| `ao_project_share_link_recipients` | Optional email or organization restriction for a share link. |

The main relationships are:

```text
user → organization memberships → organizations
organization → projects → sessions
session → commands, events, turns, sandbox, worker connection, access tickets
sandbox → provider connection
session → pull requests → PR checks
organization → GitHub installations → repository grants → GitHub repositories
GitHub webhook deliveries → installation/repository reconciliation
project/session share links → redeemed user grants
```

Migration `00008_cloud_org_auth.sql` backfills legacy accounts into personal
organizations and adds non-null `org_id` ownership to tenant-owned lifecycle,
SCM, provider, worker, ticket, and audit records. The remaining schema work is
operational policy: quotas, retention, billing/entitlements, and production RLS
enforcement.

## Components

### 1. Cloud web app

The zero-install browser product for every cloud project.

- Reuses the AO React component tree and design language, but removes the
  Electron `aoBridge` seam and every assumption that a local daemon exists.
- Talks only to the control plane over authenticated HTTPS; receives durable
  events over SSE and uses authenticated WebSockets where terminal or live
  interaction requires them.
- Owns cloud project selection, Kanban, orchestrator and worker conversations,
  workspace inspection, terminal, previews, PR/review surfaces, settings, and
  organization-aware navigation.
- Uses real cloud data only. Cloud-only controls must be complete; local-only
  controls are absent rather than shown as disabled placeholders.
- **Why:** Cloud work must continue when no laptop is awake. A browser-first
  client makes “cloud orchestrator plus cloud workers” a real standalone
  product rather than a remote mode of the desktop app.

### 2. Ingress and authentication gateway — WorkOS

WorkOS is the hosted identity provider; the control plane remains the
authorization gateway.

- A deployment-owned TLS ingress routes browser traffic to the control plane.
  WorkOS does not run that ingress.
- In `workos` auth mode, the Go control plane verifies WorkOS access-token JWTs
  against WorkOS JWKS and resolves the
  authenticated AO user, active organization, role, and tenant scope before
  application handlers run.
- Enforces CORS, request limits, origin policy, and short-lived tickets for
  WebSocket/terminal/preview-capable flows.
- Does not trust a browser-supplied user ID, organization ID, project ID, or
  session ID as authorization.
- **Why:** Every cloud operation must be scoped before it can read a project,
  send a prompt, inspect a workspace, or reach a sandbox. This is the first
  boundary that prevents tenant crossover.

### 3. Identity and organizations model — WorkOS plus AO records (grows)

WorkOS proves identity; AO owns authorization and resource ownership.

- WorkOS provides hosted sign-in, sessions, SSO/SCIM/MFA paths, and identity
  claims without replacing AO's authorization tables.
- AO stores durable organization, membership, role, project ownership,
  repository grant, session access, audit, and quota facts in its own
  PostgreSQL tables.
- Initial roles should be explicit—at minimum owner, admin, and member—rather
  than inferred from UI state or a repository URL.
- Every cloud project, session, provider connection, secret grant, event, and
  sandbox is owned by one AO tenant/organization.
- Personal use is represented as a personal tenant, not as an unscoped
  exception to the model.
- **Why:** Identity-provider claims alone cannot safely express AO-specific
  project, repository, session, spending, and audit permissions. This model is
  where cloud resources become distinct from all local resources.

### 4. GitHub App installation and credential boundary

The GitHub App implementation is AO Cloud's hosted repository authority. Local
development remains a separate explicit `local-gh` mode that uses the host `gh`
credential.

- An AO organization owner/admin starts an expiring, signed, single-use install
  attempt. The control plane validates the returned App installation, binds it
  to the organization, and synchronizes the selected repositories into durable
  grants.
- Webhooks are signature-verified, deduplicated by GitHub delivery ID, stored
  before processing, and retried with bounded backoff. Installation and
  repository-selection changes reconcile the durable grants.
- Project creation and every SCM/Git operation require an active
  organization/repository grant.
- The credential broker mints a short-lived installation token for exactly one
  repository and one allowed operation/permission set. Tokens are retained only
  in control-plane memory and are not included in worker bootstrap data,
  persisted in sandboxes, or logged. The App private key remains
  control-plane-only.
- SCM observation uses the smallest required App token scope for the core PR
  read path (`pull_requests:read`) and treats check-run/review-thread reads as
  optional enrichment. A missing optional GitHub permission must not prevent AO
  from recording the claimed PR number, title, and mergeability.
- Workers that need `gh pr ...` commands use the worker-only
  `/worker/github-token` broker path to obtain a short-lived repository-scoped
  App token for that operation. They do not receive a reusable GitHub token at
  bootstrap.
- The chosen installation flow does not use GitHub user OAuth or request user
  authorization. AO proves which AO owner/admin initiated and confirmed the
  signed attempt and that the installation belongs to the configured App, but
  cannot cryptographically prove the same GitHub human clicked Install. The AO
  initiator is responsible for confirming the GitHub account and repository
  selection.

The demo has a real GitHub App registration, production-style secrets, and
public callback/webhook URLs. Remaining work is operational hardening:
environment separation, automated rotation, rate limiting, complete audit
coverage, monitoring/alerting, and repeatable hosted end-to-end release gates.

### 5. Control-plane API service (grows substantially)

The trusted, long-running server-side authority that replaces the local
daemon's role for cloud projects.

- Runs as a Go service behind ingress, with PostgreSQL as the durable source of
  truth. The current demo intentionally runs one replica because live worker
  sockets are routed through an in-memory hub; horizontal replicas require a
  shared connection registry/message backplane or explicit connection affinity.
- Provides authenticated cloud-project CRUD; repository grants; session
  spawn/list/status/send/interrupt/terminate; orchestrator delegation;
  terminal brokering; workspace inspection; preview brokering; and PR/review
  reads and actions.
- Persists idempotent commands, desired and observed sandbox state, worker
  registrations, turns, ordered events, SCM facts, and audit records before
  presenting status to the web app.
- Replays durable events before handing clients to live delivery. Browser
  refreshes, control-plane restarts, and worker replacement must not duplicate
  completed turns or lose accepted prompts.
- Keeps permanent infrastructure, Git, and model credentials outside browser
  responses and sandbox images. Sandboxes receive only narrowly scoped,
  short-lived grants.
- **Why:** This is the trusted multi-tenant brain. It owns authorization,
  durable truth, routing, lifecycle intent, and recovery; neither the browser
  nor a disposable sandbox is allowed to become authoritative.

### 6. Sandbox supervisor and provisioner (reuse and extend)

The control-plane subsystem that manages cloud compute boxes, one
isolated sandbox per active AO session.

- Depends on a provider-neutral sandbox interface. ECS/Fargate is the current
  hosted provider, Docker is the local provider, and Daytona remains optional.
  Providers remain replaceable without changing session, event, or web
  semantics.
- Creates, boots, replaces, and deletes sandboxes from durable desired state
  rather than directly from browser requests. Providers may expose pause/resume,
  but Fargate pause is a task stop and cannot resume that task in place.
- Applies idempotency, provider-operation retries, worker bootstrap grants,
  resource limits, sandbox quotas, and orphan cleanup. Production egress
  allowlists, autostop, and retention policy remain hardening work.
- Starts a headless AO worker in each sandbox. The worker clones authorized
  repositories, runs one selected harness, reports heartbeats/events, and
  connects outward to the control plane.
- Worker Git credentials are configured idempotently when a sandbox is created
  or restored. Repeated starts must replace old helper config rather than crash
  on duplicate `credential.helper` values, so control-plane restarts can bring
  existing workspaces back online.
- The sandbox owns execution; the supervisor owns compute lifecycle. Session
  activity remains a separate durable control-plane concern.
- **Why:** Sandboxes run arbitrary agent and user code, so they are disposable
  and untrusted. The supervisor keeps provider credentials, lifecycle policy,
  and recovery authority in the trusted control plane.

## Target request flow

```text
Browser
  → WorkOS-authenticated TLS ingress
  → AO Cloud control-plane API
  → PostgreSQL durable command/session/turn state
  → sandbox supervisor
  → ECS/Fargate task and headless AO worker
  → worker events and heartbeats back to the control plane
  → ordered replay and live updates to the browser
```

No arrow in this flow passes through the local AO desktop application or local
daemon.

## Current hosted deployment

As of August 2026, the demo deployment is:

```text
Vercel Next.js app
  → WorkOS AuthKit
  → HTTPS/Caddy on AWS EC2
      → ao-cloud control-plane container
          → private AWS RDS PostgreSQL 17
          → GitHub App API and webhook inbox
          → ECS cluster ao-cloud-workers in eu-north-1
              → one Fargate task per active AO session
              → worker image pinned by ECR digest
```

The active worker task definition is sized at 2 vCPU and 4 GiB and uses
`awsvpc` networking. The demo currently assigns public task IPs because it uses
public subnets. The production direction is private subnets with NAT or
controlled egress, no inbound worker rules, and VPC endpoints where they reduce
cost and exposure.

The EC2 control plane uses an instance role for ECS operations. Fargate uses a
task execution role to pull from ECR and publish logs. The worker task does not
need an AWS task role for AO's core flow because it calls outward to the control
plane and receives scoped AO credentials there.

The live EC2 checkout and Compose definition are currently operated manually.
After the feature PRs merge upstream, EC2 must switch from the temporary fork
feature branch to the upstream `main` commit. A Git merge or Vercel deployment
does not update EC2, ECR, the ECS task definition, RDS, or existing Fargate
tasks.

## Deployment connection and version contract

One immutable Git commit SHA is the release identity:

| Layer | Release binding |
| --- | --- |
| Vercel web | Deployment commit must equal the release SHA. |
| Control plane | Container image is built from the release SHA; production should use an immutable ECR digest or SHA tag. |
| PostgreSQL schema | Migrations are embedded in that control-plane binary and run through `AO_DATABASE_DIRECT_URL` before the server listens. |
| Worker | ECR image is built from the same release SHA and pinned by digest in a new ECS task-definition revision. |
| ECS | `AO_ECS_TASK_DEFINITION` identifies the exact family revision used for new sessions. |
| Existing sessions | Keep the image/task revision with which they started until deliberately recreated. |

`AO_WORKER_VERSION` is used by the legacy Daytona snapshot publisher. It is not
an ECS version selector and the current Go control plane does not use it to pick
an ECR image. For ECS, the authoritative worker versions are the ECR image
digest and ECS task-definition revision.

The environment-to-connection mapping is:

```text
Vercel NEXT_PUBLIC_API_URL
  → public control-plane HTTPS origin

Control plane AO_WEB_PUBLIC_URL
  → allowed browser/CORS origin

Vercel WorkOS env + control-plane WORKOS_CLIENT_ID/API_KEY
  → same WorkOS application and JWT issuer

Control plane AO_DATABASE_URL / AO_DATABASE_DIRECT_URL
  → private RDS endpoint with TLS required

Control plane instance role + AO_ECS_* configuration
  → ECS RunTask/ListTasks/DescribeTasks/StopTask and iam:PassRole

ECS task definition
  → immutable ECR worker digest, execution role, logs, CPU/memory, network

Control plane per-session RunTask override
  → short-lived worker token, session ID, CP URL, and bootstrap context

GitHub App Setup/Webhook URLs
  → public control-plane origin; private key stays mounted on EC2
```

The complete variable list and placement rules are maintained in
[`../README.md`](../README.md). Long-lived database, GitHub, AWS, encryption,
and signing secrets must never be copied into Vercel public variables, an ECR
image, an ECS task definition, or worker bootstrap data.

## Manual AWS release runbook

This is the current safe manual pathway after a commit is merged into upstream
`main`. Run it from an operator shell with explicit release values; do not
deploy “whatever happens to be checked out.”

### 1. Select and verify the release

On a clean workstation:

```bash
git fetch origin --prune
git switch main
git pull --ff-only origin main
release="$(git rev-parse HEAD)"
git status --short
npm run lint
npm run frontend:typecheck
npm --prefix frontend/src/landing run build
```

The landing build requires the same variable names as Vercel; inject
non-production WorkOS values in CI rather than copying production secrets to an
arbitrary workstation. Required CI must pass for `$release`. Record the SHA in
the release notes.

### 2. Back up RDS before migrations

Create an RDS snapshot or validated logical backup before replacing the control
plane:

```bash
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rds_instance="REPLACE_WITH_RDS_INSTANCE_ID"
aws rds create-db-snapshot \
  --region eu-north-1 \
  --db-instance-identifier "$rds_instance" \
  --db-snapshot-identifier "ao-cloud-before-${stamp}"
aws rds wait db-snapshot-available \
  --region eu-north-1 \
  --db-snapshot-identifier "ao-cloud-before-${stamp}"
```

An automated RDS backup is not a substitute for checking that retention,
restore permissions, and a recent restore test are valid.

### 3. Build and push the worker image

Build from `$release`, push a unique SHA tag, resolve it to a digest, and never
reuse the tag:

```bash
region="eu-north-1"
account="$(aws sts get-caller-identity --query Account --output text)"
repository="ao-cloud-worker"
registry="${account}.dkr.ecr.${region}.amazonaws.com"
worker_tag="${registry}/${repository}:${release}"

aws ecr get-login-password --region "$region" \
  | docker login --username AWS --password-stdin "$registry"
docker build --platform linux/amd64 \
  -f ao-cloud/docker/worker.Dockerfile \
  -t "$worker_tag" .
docker push "$worker_tag"
worker_digest="$(aws ecr describe-images \
  --region "$region" \
  --repository-name "$repository" \
  --image-ids imageTag="$release" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
worker_image="${registry}/${repository}@${worker_digest}"
```

Keep BuildKit provenance/SBOM output and vulnerability-scan results with the
release when CI automation is added.

### 4. Register an immutable ECS task-definition revision

Clone the current task definition, replace only the worker container image, and
register a new revision:

```bash
aws ecs describe-task-definition \
  --region "$region" \
  --task-definition ao-cloud-worker \
  --query taskDefinition > /tmp/ao-cloud-worker-task.json

jq --arg image "$worker_image" '
  del(
    .taskDefinitionArn,
    .revision,
    .status,
    .requiresAttributes,
    .compatibilities,
    .registeredAt,
    .registeredBy,
    .deregisteredAt
  )
  | .containerDefinitions |= map(
      if .name == "worker" then .image = $image else . end
    )
' /tmp/ao-cloud-worker-task.json > /tmp/ao-cloud-worker-task-new.json

worker_task_definition="$(aws ecs register-task-definition \
  --region "$region" \
  --cli-input-json file:///tmp/ao-cloud-worker-task-new.json \
  --query taskDefinition.taskDefinitionArn \
  --output text)"
```

Inspect the registered revision before using it. CPU/memory, logging,
architecture, execution role, network mode, and container name must remain
correct.

### 5. Update the EC2 checkout and control plane

The current EC2 host uses:

```text
~/agent-orchestrator
ao-cloud/.env.hosted
ao-cloud/docker-compose.ec2-rds.yml
```

The env file and GitHub App private key remain outside Git. One time, after the
feature work lands upstream, point the checkout at the original repository:

```bash
cd ~/agent-orchestrator
release="REPLACE_WITH_RELEASE_SHA"
git remote set-url origin https://github.com/AgentWrapper/agent-orchestrator.git
git fetch origin --prune
git switch main || git switch --track -c main origin/main
git pull --ff-only origin main
test "$(git rev-parse HEAD)" = "$release"
```

Do not run `git clean -fdx` on the host: the deployment has a local Compose
definition and ignored operator files. Remove obsolete `._*` AppleDouble files
separately after confirming they are not deployment inputs.

Update only `AO_ECS_TASK_DEFINITION` in `ao-cloud/.env.hosted` to the new ARN or
`family:revision`, preserving mode `0600`. Then rebuild and recreate only the
control plane:

```bash
docker compose \
  --env-file ao-cloud/.env.hosted \
  -f ao-cloud/docker-compose.ec2-rds.yml \
  build --pull control-plane

docker compose \
  --env-file ao-cloud/.env.hosted \
  -f ao-cloud/docker-compose.ec2-rds.yml \
  up -d --no-deps control-plane
```

The new control plane applies embedded migrations before opening port 3010.
Caddy remains up and returns a temporary upstream failure only during the
single-instance restart.

### 6. Verify before considering the release complete

```bash
docker compose \
  --env-file ao-cloud/.env.hosted \
  -f ao-cloud/docker-compose.ec2-rds.yml ps
docker compose \
  --env-file ao-cloud/.env.hosted \
  -f ao-cloud/docker-compose.ec2-rds.yml logs --since=10m control-plane
control_plane_origin="https://REPLACE_WITH_CONTROL_PLANE_ORIGIN"
curl --fail "${control_plane_origin}/readyz"
```

Then verify, in order:

1. WorkOS sign-in and session restoration.
2. AO user/org bootstrap and role checks.
3. GitHub App installation status, webhook delivery, and repository grants.
4. Provider credential validation.
5. New project and orchestrator creation.
6. ECS task starts from the new task-definition revision and ECR digest.
7. Initial prompt delivery, terminal input/resize/reconnect, and inspector RPC.
8. Worker spawn/message/result, PR observation, sharing, and deletion.
9. Sandbox quota is released after deletion.

Existing sessions are not an image-rollout mechanism. Leave them running if the
new control plane remains protocol-compatible; deliberately delete/recreate
only sessions that can safely lose their ephemeral Fargate workspace.

### 7. Verify or promote the matching Vercel build

The current Vercel project builds its production branch automatically. After
the branch is changed from the temporary feature branch to `main`, confirm that
the live deployment's Git commit equals `$release`, its Root Directory is
`frontend/src/landing`, and its Production environment contains the variables
listed in the Cloud README.

For a coordinated production pipeline, build the Vercel deployment without
promoting it, finish the AWS smoke tests above, and promote that exact deployment
last. This avoids serving a browser release before its control-plane API exists.

## Live worker, terminal, and browser transport

Every cloud sandbox, including an orchestrator sandbox, runs one `ao-worker`
next to its selected coding-agent harness. The worker owns the actual agent PTY
and reports outward to the control plane; browsers never connect directly to a
sandbox.

```text
Worker → control plane
  - HTTPS heartbeats renew the worker lease and report capabilities.
  - HTTPS events report agent activity, chat turns, terminal output, blockers,
    workspace responses, and agent exit.

Control plane → worker
  - A persistent, authenticated worker WebSocket carries prompts, interrupts,
    terminal input and resize commands, and workspace RPC requests.

Control plane → browser
  - SSE replays durable session and board events, then delivers live updates.
  - A terminal WebSocket carries the live interactive terminal view.

Browser → control plane
  - HTTPS performs normal product actions.
  - The terminal WebSocket carries keystrokes and terminal resize messages.
```

### Terminal relay

A browser requests a short-lived, single-use terminal ticket from the control
plane. The ticket authorizes a **bidirectional browser-to-control-plane**
terminal WebSocket; it does not authorize pod or sandbox access.

```text
Agent harness in sandbox PTY
  → ao-worker publishes terminal-output event
  → control plane relays it on the browser terminal WebSocket
  → xterm.js renders the real terminal output

Browser keystroke or resize
  → browser terminal WebSocket to control plane
  → control plane authorizes and queues a worker command
  → worker WebSocket receives it
  → ao-worker writes it into the actual agent PTY
```

The browser terminal is therefore a live view of the real PTY, not a simulated
or reconstructed terminal. Durable event and turn records remain necessary for
recovery, replay, multi-client consistency, authorization, and audit after a
browser disconnect, worker replacement, or control-plane restart.

### Why the control plane relays this traffic

This is the required model for AO Cloud rather than a browser or orchestrator
connecting directly to a worker:

- **Security:** sandboxes execute repository and agent-controlled code. The
  control plane verifies user, organization, resource grant, worker epoch, and
  short-lived ticket before any terminal or RPC action reaches a sandbox.
- **Recovery:** a sandbox can be recreated, moved, or disconnected without
  changing the browser-facing authority. Durable events and turns explain what
  happened before a reconnect; a raw terminal stream cannot.
- **Correctness:** prompts and interrupts are persisted and idempotent before
  delivery. This prevents browser retries, reconnects, and multiple clients
  from silently duplicating work.
- **Scale:** workers make outbound connections, so sandboxes need no public
  inbound control endpoint or sticky browser-to-pod routing. Control-plane
  instances can route commands using the current worker identity and epoch.
- **Product control:** the orchestrator receives narrow, audited AO
  capabilities—such as send prompt, inspect workspace, interrupt, and open a
  preview—not unrestricted shell or pod administration over other workers.

## Production-grade release path

The manual runbook is acceptable for the current demo, but it is not the final
operating model. The smooth, industry-standard direction is:

1. **Infrastructure as code:** define VPC, private subnets, NAT/VPC endpoints,
   security groups, RDS, ECR, ECS, IAM roles, log groups, alarms, and DNS/TLS in
   Terraform, CDK, or CloudFormation. Review infrastructure changes through PRs.
2. **GitHub Actions with AWS OIDC:** use short-lived role assumption from the
   original repository. Do not store long-lived AWS access keys in GitHub,
   Vercel, EC2 files, or developer machines.
3. **Build once:** after required tests, build control-plane and worker images
   once from the release SHA. Tag with SHA, record OCI revision/source labels,
   generate SBOMs, scan, sign, push to ECR, and deploy by digest.
4. **Immutable release manifest:** persist release SHA, Vercel deployment,
   control-plane digest, worker digest, ECS task-definition revision, and
   migration set as one approved release record.
5. **Explicit migration job:** when the control plane has multiple replicas,
   run migrations once as an approved job before rolling traffic. Use
   expand/migrate/contract schema changes so the previous and next application
   versions can overlap safely.
6. **Backend before web promotion:** deploy backward-compatible control-plane
   and worker support, run smoke tests, then promote the matching Vercel
   deployment. Avoid exposing a new browser contract before its API exists.
7. **Rolling or blue/green control plane:** move from a mutable EC2-local image
   to an immutable deployment with health checks and automatic rollback. An ECS
   service/ALB is a natural option; a hardened EC2 service managed through SSM
   is also valid for the early stage.
8. **Secrets manager:** move RDS, WorkOS, GitHub, encryption, and signing
   material to AWS Secrets Manager/SSM with least-privilege access, rotation,
   audit logs, and no secret values in Compose-rendered output.
9. **Release gates:** require `/readyz`, authenticated API, GitHub webhook,
   sandbox create/connect/delete, terminal reconnect, and quota-release smoke
   tests before promotion.
10. **Observability and recovery:** alarm on CP readiness/error rate, RDS
    connections/storage, ECS launch failures/stopped tasks, worker heartbeat
    gaps, webhook retry backlog, and spend. Test RDS restore and secret/key
    recovery regularly.

### Rollback boundaries

- **Vercel:** promote the previous known-good deployment.
- **Control plane:** redeploy the previous immutable image digest.
- **New workers:** point `AO_ECS_TASK_DEFINITION` back to the previous revision.
- **Existing workers:** do not recycle healthy tasks merely to roll back new
  launches.
- **Database:** do not reverse migrations automatically. Application rollback
  must remain compatible with the expanded schema. Restore RDS only for a
  deliberate data-recovery incident with an accepted recovery point.
- **Secrets:** retain the previous encryption/signing key during a planned
  rotation window; losing it can make encrypted credentials or outstanding
  worker tokens unusable.

### Current demo gaps to close

- The EC2 control-plane image is currently rebuilt under a mutable local tag.
  Push and deploy it from ECR by digest.
- EC2 updates currently use SSH, a working-tree checkout, and a local untracked
  Compose file. Replace this with a tracked deployment definition plus
  GitHub-OIDC/SSM automation.
- Fargate tasks currently use public subnets/public IPs. Move to private
  subnets with controlled egress.
- Migrations currently run in the single control-plane startup path. Split them
  into an explicit release step before adding replicas.
- Vercel and AWS promotions are independent. Coordinate them with one release
  workflow and a manual production approval.
- Hosted end-to-end smoke tests, centralized dashboards, alerts, image signing,
  backup-restore drills, and documented incident rollback remain release
  requirements.

## Design decisions to preserve

- One isolated sandbox per cloud orchestrator or worker session by default.
- The control plane is long-lived and trusted; sandboxes are untrusted and
  disposable.
- Desired state and provider-observed state remain separate and are reconciled.
- A failed probe is not evidence that a sandbox or session is dead.
- Browser, worker, and provider operations are authenticated and authorized
  independently.
- Permanent credentials never enter browser bundles, logs, reusable snapshots,
  or worker images.
- Project sharing is a CP authorization feature, not a repository grant. Share
  links may be open to anyone with the link or restricted to specific emails or
  organizations; redeemed grants are project-scoped and use only `viewer` or
  `editor`.
- Cloud UI mirrors the applicable AO experience, but it never pretends that
  local-only desktop capabilities exist.
