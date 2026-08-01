# AO Cloud Roadmap

This roadmap rebuilds AO Cloud as a browser-only product:

```text
Cloud web app → control-plane authentication → Daytona sandbox worker
```

Electron, the local daemon, local SQLite, and local worktrees never call AO
Cloud.

## Current baseline

Reusable foundations already exist under `backend/internal/cloud/`: PostgreSQL
state, durable turns/events, idempotent commands, worker bootstrap and fencing,
sandbox-provider abstraction, reconciliation, terminal/workspace/preview
brokering, and existing agent adapters.

The current `ao_*` schema includes accounts, projects, sessions, commands,
events, turns, sandboxes, worker connections, provider connections, tickets,
and audit events. It needs to be properly reworked from a single-user
`account_id` model into organization, membership, role, repository-grant,
quota, and tenant-audit ownership. See [`CLOUD_DESIGN.md`](CLOUD_DESIGN.md).


## Phase 1 — Organization authorization and Auth

- Evolve the control-plane-owned email/password authentication into
  organization-aware authorization.
- Add organizations, memberships, roles, personal-tenant bootstrap, and
  tenant-scoped authorization.
- Test every project, session, event, terminal, workspace, preview, and
  provider operation against cross-tenant access.

**Outcome:** an authenticated user can select an organization, and no resource
can be accessed outside its tenant.

## Phase 2 — Control-plane API and schema migration

- ~~Make the Go control plane the complete Cloud authority for projects,
  repositories, sessions, messages, interrupts, orchestration, terminals,
  workspace, previews, and PR/review data.~~
- Properly migrate the existing schema to organization ownership, repository
  grants, quotas, audit records, and retention policy.
- Publish a versioned Cloud API schema and generate the browser client.

**Outcome:** the web app uses a typed, durable, organization-aware API without
talking to a database, sandbox, or local daemon directly.

## Phase 3 — Daytona lifecycle and worker runtime

- Make Daytona the production sandbox provider while retaining the provider
  interface.
- Harden reconciliation: ~~create, boot, pause/resume, replacement, deletion,
  retries,~~ orphan cleanup, egress policy, resource limits, and retention.
- Build/publish an immutable worker image with no baked credentials.
- ~~Keep the shared interactive terminal path harness-neutral: Claude Code, Codex,
  and Cursor workers must all render and resize through the same full-pane PTY
  viewport rather than a harness-specific transcript UI.~~
- Add new harnesses by baking their CLI and verified runtime prerequisites into
  the worker image, then implementing the matching AO adapter, credential
  delivery, prompt strategy, hooks/activity mapping, and lifecycle tests before
  exposing the harness in Cloud settings.

**Outcome:** every orchestrator or worker gets one isolated Daytona sandbox
that recovers safely from worker, provider, or control-plane failure.

## Phase 4 — Git and agent security boundaries

- Add a GitHub App connection flow so each user or organization can install AO
  on selected repositories from the Cloud settings UI.
- Replace temporary local `gh auth token` forwarding and deployment tokens with
  GitHub App installation tokens. The control plane obtains and refreshes those
  short-lived tokens server-side; sandboxes receive only AO-scoped, short-lived
  Git credentials for their registered repository.
- Add repository grants, installation selection, disconnect/revocation,
  verified webhooks, and clear UI status for the connected GitHub account or
  organization.
- Scope Git operations by organization, project, session, repository, branch,
  and operation.
- Support an agent only when its cloud credential, launch, stream, interrupt,
  reconnect, and resume flow is complete.

**Outcome:** sandboxes can access only authorized code and receive no broad Git
or permanent provider credential.

## Phase 5 — Browser-only product completion

- Complete Clerk organization UX, ~~cloud project/session controls, Kanban,
  orchestrator/worker chat, terminal, files/diffs, private previews,~~
  notifications, and ~~PR/review surfaces.~~
- Keep local-only controls absent rather than mocked.
- Add end-to-end coverage from sign-in through worker delegation, reconnect,
  interrupt, preview, and deletion.

**Outcome:** users can operate a cloud project entirely in a browser and safely
close/reopen it while work continues.

## Phase 6 — Azure deployment and production hardening

- Deploy to Azure Container Apps with TLS ingress, managed identity, Key Vault,
  managed PostgreSQL, registry, observability, and worker-image rollout.
- Make worker command delivery safe across multiple control-plane replicas.
- Add quotas, cost and abuse controls, egress enforcement, alerts, backups,
  restore drills, runbooks, security review, and load/failure testing.

**Outcome:** AO Cloud is a secure, observable, multi-tenant product with no
dependency on a user's local AO installation.

## Sequencing rules

- Do not expose a Cloud UI action before its authorization, persistence, error
  handling, and end-to-end test exist.
- Docker is contributor/CI infrastructure only; Cloud users always use the
  hosted control plane and Daytona.
- Preserve shared semantic contracts, but do not add Cloud identity, networking,
  or sandbox details to local wire contracts.
