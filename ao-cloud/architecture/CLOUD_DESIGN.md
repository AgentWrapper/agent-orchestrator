# AO Cloud Design

Status: implemented local Cloud foundation plus hosted-production design.

The control plane, PostgreSQL schema, organization authorization, WorkOS JWT
boundary, GitHub App install/webhook flow, worker transport, and browser Cloud
surface are implemented in this repository and exercised locally. This document
distinguishes those implemented foundations from hosted deployment, enterprise
hardening, and operational work that remain to be done.

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
- Local cloud setup and runtime commands: [`../README.md`](../README.md).
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
| `ao_provider_connections` | Encrypted Daytona and coding-agent provider connection metadata. |
| `ao_access_tickets` | One-time, short-lived worker bootstrap, terminal, and preview access grants. |
| `ao_audit_events` | Audit-log foundation: actor, action, resource, metadata, and time. |
| `ao_pull_requests` | Normalized pull-request facts observed for a session. |
| `ao_pr_checks` | CI/check facts belonging to a normalized pull request. |
| `ao_github_install_attempts` | Signed, expiring, single-use AO user/org installation attempts. |
| `ao_github_installations` | Organization-bound GitHub App installations, permissions, events, and lifecycle status. |
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

The implementation still needs a real GitHub App registration, production
secrets, public callback/webhook URLs, and hosted end-to-end verification before
it can serve a customer organization.

### 5. Control-plane API service (grows substantially)

The trusted, long-running server-side authority that replaces the
local daemon's role for cloud projects.

- Runs as a stateless Go service behind ingress, with PostgreSQL as the durable
  source of truth.
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

- Depends on a provider-neutral sandbox interface. Daytona is the primary
  target; providers remain replaceable without changing session, event, or web
  semantics.
- Creates, boots, pauses, resumes, restores, replaces, and deletes sandboxes
  from durable desired state rather than directly from browser requests.
- Applies idempotency, provider-operation retries, worker bootstrap grants,
  egress allowlists, resource limits, autostop/retention policy, and orphan
  cleanup.
- Starts a headless AO worker in each sandbox. The worker clones authorized
  repositories, runs one selected harness, reports heartbeats/events, and
  connects outward to the control plane.
- Worker Git credentials are configured idempotently when a sandbox is created
  or restored. Repeated starts must replace old helper config rather than crash
  on duplicate `credential.helper` values, so control-plane restarts can bring
  existing Docker/Daytona workspaces back online.
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
  → Daytona sandbox and headless AO worker
  → worker events and heartbeats back to the control plane
  → ordered replay and live updates to the browser
```

No arrow in this flow passes through the local AO desktop application or local
daemon.

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
