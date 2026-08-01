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

The existing PostgreSQL schema is a useful starting point. These are separate
tables, linked with foreign keys:

| Table | Current responsibility |
| --- | --- |
| `ao_accounts` | One external authenticated user maps to one cloud account. |
| `ao_projects` | Registered repository projects, owned by `account_id`. |
| `ao_sessions` | Orchestrator and worker sessions: kind, harness, branch, activity, termination, and native agent session ID. |
| `ao_commands` | Idempotent command receipts, results, and failures. |
| `ao_session_sequences` | Allocates the next ordered event sequence for each session. |
| `ao_events` | Append-only, replayable lifecycle, chat, terminal, and worker events. |
| `ao_turns` | One durable user-message-to-agent-response run, including its state, worker epoch, attempts, and completion/failure. |
| `ao_sandboxes` | The session-to-provider-environment mapping, desired/observed lifecycle state, retry lease, resource profile, and last error. |
| `ao_worker_connections` | The current worker identity, epoch, capabilities, and heartbeat timestamps for a sandbox. |
| `ao_provider_connections` | Encrypted Daytona and coding-agent provider connection metadata. |
| `ao_access_tickets` | One-time, short-lived worker bootstrap, terminal, and preview access grants. |
| `ao_audit_events` | Audit-log foundation: actor, action, resource, metadata, and time. |
| `ao_pull_requests` | Normalized pull-request facts observed for a session. |
| `ao_pr_checks` | CI/check facts belonging to a normalized pull request. |

The main relationships are:

```text
account → projects → sessions
session → commands, events, turns, sandbox, worker connection, access tickets
sandbox → provider connection
session → pull requests → PR checks
```

The rebuild must replace the single-user `account_id` ownership model with
organization, membership, role, repository-grant, quota, and tenant-scoped
audit ownership. Existing event, turn, command, sandbox, and worker-fencing
semantics should be retained where they remain valid.

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
- Cloud UI mirrors the applicable AO experience, but it never pretends that
  local-only desktop capabilities exist.
