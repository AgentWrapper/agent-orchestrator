# AO Cloud Design

Status: proposed rebuild design. This is the source of truth for the intended
AO Cloud product direction, not a description of the currently deployed test
vertical slice.

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

## Design references

- Product/UI direction: [`DESIGN.md`](DESIGN.md). Cloud retains AO's dense,
  dark, refined-blue control-surface language while using browser-appropriate
  interaction rather than Electron APIs.
- Local cloud setup and runtime commands: [`ao-cloud/README.md`](ao-cloud/README.md).
- Hosted-sessions research reference:
  <https://gist.github.com/Pritom14/7e4c4075938d89de16f740b61b18916e>.

The hosted-sessions reference is useful for provider abstraction, trusted
control-plane versus untrusted-sandbox separation, and tenant boundaries. Its
desktop-to-cloud/federated-local model is explicitly **not** part of this
design.

## Components

### 1. Cloud web app (new)

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

### 2. Ingress and authentication gateway — Clerk (grows)

The TLS front door and first multi-tenant enforcement point.

- Runs at the public ingress for the control plane, initially on Azure
  Container Apps.
- Verifies Clerk JWTs on every browser request and resolves the authenticated
  user, active organization, role, and tenant scope before application
  handlers run.
- Enforces CORS, request limits, origin policy, and short-lived tickets for
  WebSocket/terminal/preview-capable flows.
- Does not trust a browser-supplied user ID, organization ID, project ID, or
  session ID as authorization.
- **Why:** Every cloud operation must be scoped before it can read a project,
  send a prompt, inspect a workspace, or reach a sandbox. This is the first
  boundary that prevents tenant crossover.

### 3. Identity and organizations model — Clerk plus AO records (grows)

Clerk proves identity; AO owns authorization and resource ownership.

- Clerk provides sign-in, sessions, organization selection, and identity
  claims.
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

### 4. Control-plane API service (grows substantially)

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

### 5. Sandbox supervisor and provisioner (reuse and extend)

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
- The sandbox owns execution; the supervisor owns compute lifecycle. Session
  activity remains a separate durable control-plane concern.
- **Why:** Sandboxes run arbitrary agent and user code, so they are disposable
  and untrusted. The supervisor keeps provider credentials, lifecycle policy,
  and recovery authority in the trusted control plane.

## Target request flow

```text
Browser
  → Clerk-authenticated TLS ingress
  → AO Cloud control-plane API
  → PostgreSQL durable command/session/turn state
  → sandbox supervisor
  → Daytona sandbox and headless AO worker
  → worker events and heartbeats back to the control plane
  → ordered replay and live updates to the browser
```

No arrow in this flow passes through the local AO desktop application or local
daemon.

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
- Cloud UI mirrors the applicable AO experience, but it never pretends that
  local-only desktop capabilities exist.
