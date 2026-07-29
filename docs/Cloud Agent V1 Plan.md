# Cloud Agent V1 Plan

> Implementation plan and acceptance contract for adding AO Cloud without
> regressing the existing local product.

Status: **implementation in progress**

Branch: `feat/cloud-agent-v1`

This document records the requested V1 scope, the current repository baseline,
the architecture that follows from it, the external services needed, and the
questions that must be answered before implementation begins. It supplements
[`Cloud Agent Plan Nihal.md`](Cloud%20Agent%20Plan%20Nihal.md), which contains
the longer decision history and competitive research.

## Implementation checkpoint

Implemented on `feat/cloud-agent-v1`:

- separately deployable `ao-cloud` and `ao-worker` Go binaries;
- `ao_*` PostgreSQL migrations with RLS enabled on every cloud table;
- Supabase access-token verification and personal-account isolation;
- durable idempotent session creation, ordered events, replay, and live fanout;
- provider-neutral sandbox contract and Daytona create/get/start/stop/delete;
- desired/observed reconciliation with leased, restart-safe work claiming;
- encrypted AO-managed and user-provided Daytona connection storage;
- one-time worker bootstrap grants and epoch-fenced worker credentials;
- outbound worker command WebSocket and authenticated browser terminal tickets;
- bidirectional PTY output/input/resize with durable output replay;
- reusable existing Claude Code, Codex, Cursor, and other AO agent adapters;
- local-development GitHub repository listing and scoped Git smart-HTTP proxy
  backed by the host's `gh` login;
- real Supabase email login/signup/logout UI, cloud project/session/provider flows,
  and xterm terminal surface;
- control-plane and complete three-agent worker images;
- Render and Vercel deployment configuration/documentation.

Verified locally:

- PostgreSQL migrations, command idempotency, account isolation, RLS, ordered
  event replay, one-use grants, worker epoch fencing, and bidirectional terminal
  routing;
- Daytona credentials plus live sandbox create/get/delete;
- worker binary upload and launch in a real Daytona sandbox;
- Go cloud packages, browser auth tests, TypeScript checks, static Next.js build,
  and both Docker images.

External completion blockers:

- a Supabase PostgreSQL connection URL/password was not supplied, so the hosted
  schema cannot yet be applied or verified;
- the tested Daytona sandbox reset all outbound HTTPS connections, including
  `example.com`, despite `networkBlockAll=false`, preventing its worker from
  reaching a local tunnel;
- Render/Vercel access and a production image registry/snapshot have not been
  supplied.

## TL;DR

AO will have two independent execution modes built from one shared product core:

```text
Local AO
Desktop UI → local Go daemon → local runtime/worktree → SQLite

AO Cloud
Browser UI → authenticated AO Cloud Go service
           → Daytona provider adapter
           → one isolated sandbox per AO session
           → AO worker + coding agent
           → PostgreSQL event/state persistence
```

There is **no local/cloud synchronization in V1**. Local sessions remain local;
cloud sessions remain cloud-owned. Both modes use the same domain vocabulary,
API base types, lifecycle rules, SCM rules, and UI components where behavior is
actually equivalent.

Go does not use class inheritance for this design. The shared core consumes
interfaces; local and cloud implementations satisfy those interfaces through
composition:

```text
Shared domain and application services
├── local adapters: SQLite, local Git worktrees, tmux/conpty, loopback HTTP
└── cloud adapters: PostgreSQL, Daytona, cloud worker, authenticated HTTPS/WSS
```

The first delivery is not considered complete if the web UI contains fake data,
preview-only terminal output, inactive buttons, TODO handlers, or other stubs.

## What was requested

1. Update from current `main` and create a dedicated cloud branch.
2. Inventory everything that works locally so local regressions are measurable.
3. Extract a clean common contract/core instead of copying the daemon.
4. Preserve local-specific behavior behind local adapters.
5. Add cloud-specific behavior behind cloud adapters.
6. Add a separately deployable AO Cloud area and artifacts.
7. Add Login beside the landing page's Download button.
8. Implement real login and logout, with a practical initial provider.
9. Make the authenticated browser product visually and behaviorally match the
   Electron renderer wherever the feature applies to cloud execution.
10. Register cloud projects from authorized Git repositories.
11. Keep AO's orchestrator-per-project product model.
12. Provision isolated Daytona compute for each cloud orchestrator/worker
    session.
13. Put a lightweight AO worker and the selected coding-agent CLI inside each
    sandbox.
14. Implement cloud LCM and SCM behavior rather than relying on the local daemon.
15. Persist cloud records and ordered session events in PostgreSQL.
16. Replay missed events and then hand off to the live stream after refresh or
    reconnect.
17. Let users configure their own Daytona connection in cloud settings.
18. Keep provider code abstract enough to replace Daytona later.
19. Verify the browser product locally where possible and against Daytona once
    credentials are supplied.
20. Do not implement local/cloud session synchronization yet.

## Important interpretation corrections

### Shared interfaces, not inheritance

“Local and cloud inherit the common interface” means both implementations
satisfy common Go ports and wire contracts. It does not mean:

- a `LocalDaemon` superclass and a `CloudDaemon` subclass;
- one giant request type containing many nullable local/cloud fields;
- cloud handlers importing concrete SQLite or tmux packages;
- local code learning about users, organizations, Daytona, or PostgreSQL.

Shared command types should contain facts common to both modes. Local-only and
cloud-only commands should be separate, typed contracts.

### Do not migrate the entire local daemon unchanged

The current daemon assumes:

- one trusted OS user;
- an unauthenticated loopback listener;
- filesystem paths on that user's computer;
- SQLite and trigger-based CDC;
- local tmux/conpty runtime handles;
- local Git worktrees;
- Electron lifecycle and daemon discovery.

Those assumptions must remain local. The reusable pieces are the domain types,
service rules, LCM reductions, SCM normalization, agent abstractions, API error
shape, and compatible read models.

### Two images, with different lifetimes

The control-plane image is not started once per worker:

```text
AO Cloud control-plane image
→ deployed as a long-running web/API service
→ serves many users and sessions

AO worker image / Daytona snapshot
→ forked once per cloud session
→ runs one AO worker and one coding-agent process
```

Daytona provisions the **worker environment**. It should not provision a fresh
copy of the whole AO Cloud API for every worker.

### One sandbox per AO session

An AO orchestrator is itself a session. Therefore:

```text
Cloud Project A
├── orchestrator session → Daytona sandbox O
├── worker session 1     → Daytona sandbox W1
└── worker session 2     → Daytona sandbox W2
```

The orchestrator can ask AO Cloud to create workers. AO Cloud records the
command and provisions each worker through the Daytona adapter.

## Current repository facts

### Existing auth is not reusable user auth

The landing package declares `@ao/auth`, but
`frontend/src/landing/packages/auth/src/server.ts` explicitly contains:

```text
Stub - auth is not needed for the landing page
```

It always returns no session. The landing site therefore has no real human
signup, login, account session, or logout flow to copy. The machine-readable
OAuth documentation under the landing app also does not constitute a working
human account system in this repository.

Cloud V1 needs a real identity implementation behind an AO-owned auth
interface.

### Known differences between current documentation and runtime

The repository audit found two current-state details that the implementation
baseline must represent accurately:

- PR merge and review-comment resolution routes are registered, but their
  production dependency is not wired by the daemon, so they currently return
  `501`. They are existing contract scaffolding, not shipped end-to-end local
  behavior.
- GitHub tracker intake is active and read-only: it can poll assigned issues and
  start one worker per canonical issue. General issue/comment synchronization
  back to the tracker is still incomplete.

Cloud V1 must not preserve the `501` behavior as “parity.” If a PR action is
visible in the cloud UI, it requires a real authorized implementation. The local
baseline should first capture the existing gap so shared-core refactoring does
not silently change unrelated local behavior.

### Existing browser preview is not the cloud product

`VITE_NO_ELECTRON=1` currently supports marketing/demo preview. When Electron's
preload bridge is absent:

- the daemon is reported as stopped;
- folder scanning returns no repositories;
- terminal panes render scripted sample transcripts;
- browser controls use fallback behavior;
- native update, notification, and window methods no-op.

Those paths are useful development references, but they are stubs and cannot be
shipped as AO Cloud. Cloud mode needs real HTTP, event, terminal, preview,
clipboard, auth, and notification adapters.

### Existing Go package boundary

The Go module is rooted at `backend/`, and reusable packages currently live
under `backend/internal/`. A separate root-level Go module cannot import those
internal packages. The cloud binaries should initially remain inside the same
Go module:

```text
backend/cmd/ao          # existing local CLI
backend/cmd/ao-cloud    # authenticated cloud control plane
backend/cmd/ao-worker   # headless sandbox worker
```

A root `ao-cloud/` directory can own deployable artifacts without duplicating
Go source:

```text
ao-cloud/
├── README.md
├── docker/
│   ├── control-plane.Dockerfile
│   └── worker.Dockerfile
├── deploy/
├── environments/
└── scripts/
```

This keeps cloud packaging portable while allowing the Go binaries to reuse
the current internal core.

## Proposed source layout

The exact refactor should be driven by real call sites and kept surgical.

```text
backend/
├── cmd/
│   ├── ao/
│   ├── ao-cloud/
│   └── ao-worker/
├── internal/
│   ├── domain/              # shared vocabulary
│   ├── ports/               # shared capabilities
│   ├── service/             # shared application/read rules where portable
│   ├── lifecycle/           # shared fact reduction
│   ├── observe/scm/         # shared provider-neutral SCM observation
│   ├── local/               # local-only wiring/config where extraction helps
│   ├── cloud/
│   │   ├── auth/
│   │   ├── commands/
│   │   ├── events/
│   │   ├── postgres/
│   │   ├── reconcile/
│   │   ├── sandbox/
│   │   │   └── daytona/
│   │   ├── secrets/
│   │   └── workerhub/
│   └── worker/
└── ...

frontend/
├── src/renderer/            # current shared visual product, incrementally made runtime-neutral
├── src/cloud/               # browser entry, cloud auth/runtime composition
└── src/landing/             # marketing site and Login link

ao-cloud/                    # images and deployment assets
```

Do not move every package merely to match this tree. Introduce a package only
when cloud/local wiring creates a real boundary.

## Shared core contract

### Shared domain concepts

- project
- session
- orchestrator and worker session kinds
- agent harness
- activity facts
- termination facts
- branch and repository identity
- PR, CI, review, and mergeability facts
- notifications
- normalized agent events
- API errors and request IDs
- derived display status

### Shared application behavior

- project and session read models
- session spawn validation
- lifecycle fact reduction
- conservative liveness handling
- SCM observation normalization
- PR/CI/review-derived status
- agent message semantics
- restore/resume capability vocabulary
- notification intent generation

### Environment-specific ports

Current ports already establish useful seams for agents, runtimes, workspaces,
SCM, messaging, reviews, and telemetry. Cloud adds focused capabilities rather
than expanding every existing interface:

```go
type SandboxProvider interface {
    Create(context.Context, SandboxSpec) (Sandbox, error)
    Get(context.Context, SandboxID) (Sandbox, error)
    Pause(context.Context, SandboxID) error
    Resume(context.Context, SandboxID) error
    Delete(context.Context, SandboxID) error
    Snapshot(context.Context, SandboxID, SnapshotSpec) (Snapshot, error)
}

type EventLog interface {
    Append(context.Context, SessionID, ExpectedSequence, []Event) ([]Event, error)
    Replay(context.Context, SessionID, AfterSequence, Limit) ([]Event, error)
}

type CommandJournal interface {
    Begin(context.Context, Command) (Receipt, error)
    Complete(context.Context, CommandID, Result) error
}
```

These signatures are illustrative, not approved source code. The implementation
must define idempotency, optimistic concurrency, errors, and transaction
boundaries before finalizing them.

### API contract strategy

Keep the existing OpenAPI generation workflow. Split the API conceptually into:

1. **Shared product API** used by both local and cloud where semantics match:
   projects, sessions, orchestrators, PR summaries/actions, reviews,
   notifications, workspace files, and agent catalog.
2. **Local-only API** for daemon control, local folder import/initialization,
   desktop updates, Connect Mobile, and local process details.
3. **Cloud-only API** for identity, organizations, Git installations,
   repository selection, provider settings, sandbox lifecycle, usage, durable
   event replay, worker registration, terminal tickets, and previews.

Do not make local callers send fake organization or sandbox values. Do not make
cloud callers send local filesystem paths.

## Local regression baseline

Everything below currently works or is represented as shipped on `main`. It is
the minimum local regression checklist.

### Backend and API

- [ ] Loopback daemon health, readiness, and graceful shutdown
- [ ] SQLite migrations and trigger-based `change_log`
- [ ] SSE events with `Last-Event-ID` replay
- [ ] Project list, add, get, update, config update, remove
- [ ] Local folder Git initialization
- [ ] Legacy project import
- [ ] Session list, spawn, get, rename, send, kill, cleanup, rollback
- [ ] Session activity hooks and native agent session identity
- [ ] Session restore and agent resume
- [ ] Session merge policy
- [ ] Session workspace file list, content, and diff
- [ ] Session browser preview discovery and files
- [ ] Orchestrator list, spawn, get, completion, and re-engagement
- [ ] Agent catalog, refresh, and readiness probing
- [ ] Standalone shell terminal list, open, rename, and close
- [ ] Terminal mux attachment, input, resize, exit, and reconnect
- [ ] GitHub SCM polling with ETags and normalized PR facts
- [ ] Read-only GitHub tracker intake and issue-to-worker deduplication
- [ ] PR claim/takeover behavior
- [ ] Existing PR merge/review-comment routes remain registered and continue to
      return their current `501` response until separately wired locally
- [ ] Code-review trigger, result, cancellation, and history
- [ ] Notifications, pagination, live stream, and read acknowledgement
- [ ] Lifecycle reaper and the rule that probe failure is not proof of death
- [ ] Dirty-worktree preservation and refusal to force-delete
- [ ] Multi-repository workspace project behavior
- [ ] Existing CLI behavior as a thin daemon client

### Electron renderer

- [ ] Project sidebar and project/session navigation
- [ ] Sessions board and derived status columns
- [ ] Orchestrator and worker session views
- [ ] Per-session tab layout
- [ ] New project and new worker/orchestrator flows
- [ ] Agent selection and project settings
- [ ] Live xterm terminal, resize, reconnect, and replay presentation
- [ ] Standalone session-scoped shell terminals
- [ ] Session send, terminate, restore, resume, rename, and merge policy
- [ ] Workspace changed-file list, content, and diff
- [ ] PR/CI/review summary and review actions
- [ ] Browser preview panel and annotations
- [ ] Notification center and native notification routing
- [ ] Search/command palette and keyboard shortcuts
- [ ] Theme and panel/sidebar persistence
- [ ] Daemon startup, failure, and restart UX
- [ ] Migration UI
- [ ] Connect Mobile UI
- [ ] Desktop update UI

### Required local verification gate

At each structural refactor:

```bash
npm run lint
npm run frontend:typecheck
cd frontend && npm test
cd backend && go test -race ./...
```

Run focused package/component tests first. API source changes require
`npm run api` and generated-artifact drift checks.

## AO Cloud runtime architecture

```text
Landing site
  → Login
  → browser receives secure account session
  → AO Cloud web application

AO Cloud web application
  → authenticated HTTPS commands
  → short-lived ticket for terminal/event WebSocket

AO Cloud Go service
  → PostgreSQL command journal and state
  → Daytona adapter creates sandbox

Daytona sandbox
  → boots approved AO worker image/snapshot
  → worker exchanges bootstrap grant for short-lived session identity
  → worker clones authorized repository and checks out session branch
  → worker starts selected agent under host-authoritative PTY ownership
  → worker streams heartbeats, PTY chunks, and normalized events outward

AO Cloud Go service
  → commits ordered events
  → updates projections
  → broadcasts committed events
  → browser replays after last sequence, then joins live stream
```

Clients do not control Daytona directly. Clients do not connect directly to an
unauthenticated sandbox. Daytona keys never enter browser code.

## Cloud project and session flow

### Add project

Cloud “Add project” cannot use Electron's local folder chooser. Its equivalent
flow is:

1. User authenticates.
2. User connects/installs the AO GitHub App.
3. AO lists only repositories granted to that installation.
4. User chooses a repository and base branch.
5. User chooses orchestrator and worker agent defaults.
6. AO stores repository identity and project configuration.
7. User starts the project orchestrator.

### Start orchestrator

1. Record an idempotent spawn command.
2. Create the orchestrator session and desired sandbox state transactionally.
3. Reconciler asks the Daytona adapter to provision.
4. Sandbox boots the worker image.
5. Worker registers with a single-session bootstrap grant.
6. Worker clones the repository and checks out the orchestrator branch.
7. Worker starts the configured orchestrator agent.
8. AO records ordered lifecycle and output events.

### Orchestrator spawns a worker

The cloud orchestrator must not invoke a loopback `ao` binary that expects the
local daemon. The sandbox CLI/worker sends an authenticated command to AO Cloud:

```text
orchestrator → ao spawn command → AO Cloud
             → durable receipt
             → worker session row
             → Daytona sandbox
             → cloud worker agent
```

Retries use the same operation ID so a reconnect does not create two workers.

## Daytona abstraction

Daytona is the first adapter, not a domain dependency.

### AO-owned provider configuration

For an AO-managed deployment, server administrators configure the default
Daytona organization/key and allowed targets. Ordinary users do not see this
credential.

### User-owned Daytona configuration

The requested cloud settings flow may allow a user or organization admin to:

- connect a Daytona API key;
- select an allowed Daytona target, region, or organization;
- validate the connection;
- select a resource profile;
- see which provider account will be billed;
- rotate or disconnect the credential.

The key must be encrypted at rest and never returned after creation. The UI
shows metadata and validation status, not the secret value.

### Provider-neutral domain

Provider-specific fields belong in the adapter/config record. Core session
records keep:

```text
session_id
provider
provider_environment_id
desired_state
observed_state
worker_last_seen_at
resource_profile
last_error
```

Future AWS, E2B, Vercel Sandbox, or customer-hosted adapters should not require
rewriting session, event, UI, or LCM semantics.

## Worker image and snapshot model

### Worker base image

Contains:

- minimal Linux userspace;
- non-root AO worker user where provider capabilities allow;
- signed AO worker binary;
- Git and GitHub CLI where required;
- supported coding-agent CLIs;
- common build tools;
- certificates and outbound networking configuration;
- bootstrap entrypoint;
- no permanent model, Git, Daytona, or database credentials.

### Reusable snapshot initialization

Slow, reusable setup:

```text
worker base image
→ install system packages and browsers
→ optionally clone project at a public/non-secret revision
→ install reusable dependencies
→ save last-known-good project snapshot
```

### Per-session setup

Fresh, identity-specific setup:

```text
fork snapshot
→ exchange one-time worker bootstrap grant
→ fetch authorized repository state
→ check out dedicated session branch
→ inject short-lived grants
→ run project setup
→ start PTY and agent
```

Secrets never enter a reusable snapshot.

## PostgreSQL ownership and schema direction

PostgreSQL is authoritative for cloud state. SQLite remains authoritative for
local state. They do not replicate or connect directly in V1.

### Shared/base cloud tables

Port the domain facts needed by cloud services, preserving semantics rather
than mechanically translating every SQLite trigger:

- projects
- project configuration
- sessions
- PRs, checks, reviews, threads, and comments
- review runs
- notifications
- orchestrator re-engagement facts

### Cloud-only tables

- users
- identities
- organizations
- organization memberships and roles
- Git provider installations and repository grants
- cloud provider connections
- cloud session/environment mappings
- desired and observed environment state
- worker registrations and connection epochs
- command receipts
- append-only session events
- projection checkpoints
- terminal/output chunks or object references
- secret metadata and grants
- usage and quota records
- audit events

### Migration rule

PostgreSQL gets its own append-only migrations. Existing merged SQLite
migrations remain untouched. A common Go store interface should express the
required transaction, not force both databases to share SQL.

## Durable command and event model

### Transactional command receipt

Example: user starts a worker with operation ID `op-123`.

In one PostgreSQL transaction:

1. insert or find command receipt `op-123`;
2. verify authorization and current projection;
3. create the session and desired environment record;
4. append `session.requested` with the next sequence;
5. commit.

Only committed work is published. A repeated `op-123` returns the recorded
result instead of spawning another sandbox.

### Sequence-numbered events

Every session event has a monotonically increasing sequence within that
session:

```text
41 session.requested
42 sandbox.provisioning
43 worker.connected
44 repository.ready
45 agent.started
46 terminal.output
47 agent.waiting_input
```

### Projection

The UI reads efficient current-state projections rather than folding the whole
log for every request. Projections are derived from committed events and can be
rebuilt or repaired.

### Replay then live handoff

```text
browser last saw sequence 45
→ opens stream requesting after=45
→ server establishes a live-delivery fence/buffer
→ replays 46..current from PostgreSQL/object storage
→ drains events committed during replay
→ continues live without a gap
```

If retained events cannot cover the requested gap, the server returns a fresh
snapshot/projection plus its sequence and continues from there.

### PTY durability

PostgreSQL should not receive one row per individual terminal byte. The worker
batches bounded, ordered chunks. The final storage split should support:

- recent replay with low latency;
- long transcript retention without unbounded hot-table growth;
- redaction before persistence;
- explicit retention and deletion;
- sequence correlation with structured events.

Small metadata and event records belong in PostgreSQL. Large compressed terminal
segments and artifacts may move to object storage while PostgreSQL stores their
ordered references.

## LCM and SCM in cloud

### Cloud LCM

Cloud LCM remains the canonical reducer for session lifecycle facts, but gains
environment observations:

- desired sandbox state;
- Daytona-observed state;
- worker connection/liveness;
- agent activity;
- PTY incarnation;
- process launch generation;
- termination and retention policy.

As locally, failed probes are not proof of death. Cloud lifecycle must also
reconcile orphaned provider resources and incomplete operations.

### Cloud SCM

Reuse provider-neutral observation and status rules. Replace assumptions about
local `gh` authentication with a GitHub App installation and repository grant.
The cloud observer:

- polls or receives webhooks for authorized repositories;
- normalizes PR/CI/review facts;
- persists them in PostgreSQL;
- notifies cloud LCM;
- sends idempotent nudges through the connected worker;
- preserves the same user-visible derived statuses.

There is no local/cloud SCM synchronization in V1.

## Authentication and authorization

### Recommended initial decision

Use a standards-based identity boundary so the provider can be replaced.
For the fastest testable first setup, the recommendation is:

- Supabase-hosted PostgreSQL plus Supabase Auth;
- email/password enabled initially;
- Google OAuth can be added later;
- Go verifies access tokens using issuer/JWKS;
- AO authorization remains in AO tables, not only in identity-provider claims.

This is a recommendation requiring approval. A plain PostgreSQL service plus
Auth0, Clerk, WorkOS, or another OIDC provider can satisfy the same AO auth
port.

### Browser session

- secure, HTTP-only, SameSite cookies where the web topology permits;
- CSRF protection for cookie-authenticated mutations;
- short-lived access tokens;
- server-side refresh/rotation;
- explicit logout and session revocation;
- no provider secret in browser storage.

### WebSocket authentication

1. Authenticated client requests a one-use ticket for one session and purpose.
2. Ticket expires quickly and carries narrow scopes.
3. WebSocket upgrades using the ticket.
4. Every command on the connection still checks its required scope.
5. Ticket replay, wrong session, wrong operation, or expiry is rejected.

Example scopes:

```text
session:read
session:operate
terminal:read
terminal:operate
review:write
provider-settings:write
```

### Worker authentication

- control plane creates a one-time, session-bound bootstrap grant;
- worker exchanges it over TLS for short-lived worker credentials;
- credential binds session ID, environment ID, worker image/version, and epoch;
- reconnect does not authorize another session;
- replacement increments the connection epoch so stale workers cannot act.

## Secret handling

Secrets include:

- Daytona API keys;
- GitHub App private key and installation tokens;
- model-provider keys;
- database credentials;
- worker bootstrap grants;
- signing/encryption keys.

Requirements:

- encrypt permanent secrets at rest;
- use KMS/managed secret storage in production;
- keep secret plaintext out of PostgreSQL logs, events, terminal history, and
  error payloads;
- return write-only values only at creation where unavoidable;
- issue short-lived session grants;
- audit create, validate, rotate, and revoke operations;
- never bake secrets into images or snapshots.

## Web UI parity strategy

The goal is one product UI, not a second dashboard that slowly drifts.

### Reuse approach

Incrementally replace direct Electron/daemon assumptions with typed runtime
capabilities:

```text
Shared React UI and state
├── Desktop runtime
│   ├── Electron bridge
│   ├── local daemon transport
│   └── native BrowserView/notifications/updater
└── Cloud web runtime
    ├── authenticated cloud API transport
    ├── durable event/terminal transport
    ├── browser preview proxy
    └── browser notifications/clipboard
```

The marketing site's Login button links to the authenticated cloud application.
It does not turn the marketing layout into the session dashboard.

### Cloud parity matrix

| Desktop behavior             | Cloud equivalent                                     | V1 requirement                               |
| ---------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| Local folder picker          | Authorized Git repository picker                     | Real implementation                          |
| SQLite project/session reads | PostgreSQL-backed cloud API                          | Same visual models                           |
| Local tmux/conpty terminal   | Cloud worker PTY over authenticated WSS              | Full input/resize/reconnect                  |
| Local CDC SSE                | Durable cloud event replay + live stream             | No event gap on refresh                      |
| Local filesystem browser     | Worker workspace API                                 | Files/content/diff parity                    |
| Electron BrowserView         | Authenticated preview proxy/iframe or web surface    | Real navigation and access control           |
| Native clipboard             | Browser Clipboard API                                | Capability/error handling                    |
| Native notifications         | Web notifications/in-app notification center         | In-app required; browser permission optional |
| Local project settings       | Cloud project/agent/environment settings             | Real persistence                             |
| Local agent catalog probe    | Worker-image supported catalog and session readiness | Do not pretend browser has local binaries    |
| Local shell terminal         | Session sandbox shell terminal                       | Real sandbox PTY                             |
| Local import/migration       | Not applicable without sync                          | Hidden, not stubbed                          |
| Connect Mobile LAN bridge    | Not applicable; cloud is already remote              | Hidden, not stubbed                          |
| Desktop updater              | Web deployment versioning                            | Hidden, not stubbed                          |
| Window chrome/fullscreen IPC | Browser-native layout                                | No fake IPC                                  |

“Hidden, not stubbed” means local-only controls do not appear in cloud mode. It
does not mean rendering a disabled button with “coming soon.”

### Visual requirement

The cloud app must reuse the current renderer's design and shadcn primitives,
following `DESIGN.md` and the instruction to clone agent-orchestrator verbatim.
The web runtime may omit OS window chrome, but project/session/terminal/review
surfaces must remain visually equivalent.

## No-stub completion gate

Before Cloud V1 is called complete:

- [ ] Search production cloud code for TODO/FIXME/placeholder/not-implemented
- [ ] No cloud route returns hard-coded sample project/session data
- [ ] No terminal renders `workerPreviewLines` or another scripted transcript
- [ ] No cloud button is wired to a no-op bridge method
- [ ] Every visible mutation has an integration test proving durable state
- [ ] Every visible read has a real API and authorization test
- [ ] Refresh during active output replays then resumes live
- [ ] Retried spawn with the same operation ID creates one session/sandbox
- [ ] Two concurrent attach requests adopt one PTY incarnation
- [ ] Stale worker credentials cannot control a replacement worker
- [ ] Logout revokes the browser session and closes protected streams
- [ ] One user cannot read another user's project, session, terminal, or provider
      settings
- [ ] Daytona credentials never appear in browser responses or logs
- [ ] Provider failure and control-plane restart reconciliation are tested
- [ ] Local regression baseline remains green

## Verification strategy

### Unit and contract tests

- shared domain/status behavior against local and cloud stores;
- sandbox provider adapter with a deterministic fake;
- command idempotency and event sequence allocation;
- event projection and snapshot rebuild;
- auth middleware and resource authorization;
- worker registration and epoch fencing;
- PTY authority and duplicate attach behavior;
- secret redaction;
- cloud/local OpenAPI compatibility tests.

### PostgreSQL integration tests

Use an isolated real PostgreSQL instance in CI for:

- migrations;
- transactions and rollback;
- concurrent sequence allocation;
- command-receipt uniqueness;
- organization/user isolation;
- replay queries and retention;
- reconciler leases/locking;
- restart recovery.

SQLite mocks are not sufficient for these tests.

### Browser end-to-end tests

Playwright covers:

1. login and logout;
2. Git repository connection;
3. add cloud project;
4. start orchestrator;
5. orchestrator creates worker;
6. live terminal interaction;
7. refresh during output;
8. replay with no duplicate/missing sequence;
9. file/diff view;
10. PR/CI/review status;
11. notification flow;
12. cloud settings and Daytona validation;
13. authorization denial across two test users.

### Daytona end-to-end gate

Once Daytona credentials exist:

1. build/sign worker image;
2. provision sandbox through the real adapter;
3. verify outbound registration;
4. clone a dedicated test repository;
5. start a fake deterministic agent first, then a real supported agent;
6. stream PTY and structured events;
7. disconnect browser and reconnect;
8. pause/resume;
9. delete sandbox;
10. confirm reconciler state and no orphan;
11. confirm secrets absent from image, logs, events, and snapshots.

## Step-by-step implementation order

Each stage must leave the repository testable. A later stage does not excuse
shipping stubs from an earlier stage.

### Stage 0: freeze the contracts and baseline

- approve the decisions listed at the end of this document;
- turn the local regression inventory into executable/traceable checks;
- document shared, local-only, and cloud-only API operations;
- define session, command, event, PTY, and sandbox state machines;
- define threat model and data retention expectations.

Exit: no unresolved decision changes foundational schema or identity.

### Stage 1: shared-core extraction

- add characterization tests around local behavior;
- extract only concrete shared interfaces and application rules;
- keep local adapters and wiring behavior unchanged;
- add local/cloud capability descriptors instead of browser/Electron detection
  scattered across components.

Exit: all local checks pass with no cloud runtime yet.

### Stage 2: AO Cloud skeleton and PostgreSQL

- add `ao-cloud` binary and authenticated server wiring;
- add PostgreSQL migrations/store;
- implement users/organizations/memberships;
- implement command journal, event log, projection checkpoint, and audit records;
- expose health/readiness and shared read models.

Exit: authenticated multi-user API integration tests pass against PostgreSQL.

### Stage 3: real website authentication

- replace the landing auth stub;
- add Login beside Download;
- add login callback/session/logout;
- protect cloud app routes;
- implement account/session security and CSRF behavior.

Exit: browser E2E proves login, protected route, refresh, logout, and revocation.

### Stage 4: cloud web runtime

- compose the existing renderer UI with a cloud transport;
- replace preview mock data with real cloud queries;
- hide local-only features by capability;
- implement cloud project repository selection;
- preserve visual and interaction parity.

Exit: every visible cloud control has a real API, test, and persisted behavior.

### Stage 5: provider abstraction and Daytona

- implement typed sandbox provider port;
- implement fake provider and lifecycle tests;
- implement Daytona adapter;
- implement encrypted server default and user-owned provider settings;
- add desired/observed state and reconciliation;
- build control-plane and worker images.

Exit: real Daytona create/get/pause/resume/delete and orphan checks pass.

### Stage 6: AO worker and agent execution

- implement bootstrap exchange and worker authentication;
- implement repository clone/branch setup through scoped Git credentials;
- implement host-authoritative PTY and process-generation fencing;
- start selected agent;
- report heartbeats, lifecycle, raw output, and normalized agent events;
- support orchestrator-issued cloud spawn/send commands.

Exit: one orchestrator plus multiple isolated worker sandboxes operate end to end.

### Stage 7: durable terminal and event handoff

- implement transactional receipts and sequence allocation;
- implement ordered output batching;
- implement replay/live fencing and snapshot fallback;
- implement browser refresh/reconnect;
- implement bounded backpressure and retention.

Exit: fault tests show no missing/duplicate commands and deterministic replay.

### Stage 8: cloud SCM, files, reviews, previews, and notifications

- GitHub App installation/repository grants;
- cloud SCM observer/webhooks;
- workspace file/diff APIs;
- review actions and PR operations;
- authenticated preview proxy;
- durable notification behavior.

Exit: browser behavior matches all applicable desktop product flows.

### Stage 9: production hardening and release gate

- quotas, usage, timeouts, and cost visibility;
- KMS/secrets, redaction, image signing, scanning, and SBOM;
- backup/restore and disaster-recovery test;
- observability, alerts, and orphan cleanup;
- load, reconnect, authorization, and penetration testing;
- complete local regression and no-stub audit.

Exit: Cloud Agent V1 acceptance checklist passes.

## External services and credentials needed

Do not send secrets in chat or commit them. They should be installed into an
ignored local environment file or the selected deployment's secret manager.

### Needed before Stage 3: identity and PostgreSQL

Recommended Supabase path:

- [ ] Supabase project URL
- [ ] Supabase public/anonymous key for the web client
- [ ] server-only PostgreSQL connection string
- [ ] server-only service-role key only if an approved flow requires it
- [ ] JWT issuer/JWKS details
- [ ] Supabase Email Auth enabled
- [ ] allowed local and deployed callback URLs

Alternative path:

- [ ] managed PostgreSQL connection string
- [ ] selected OIDC provider issuer/client ID/client secret
- [ ] callback/logout URLs
- [ ] email delivery provider if password verification/recovery is required

### Needed before Stage 5: Daytona

- [ ] Daytona API key for a test account
- [ ] Daytona API URL if not the default managed endpoint
- [ ] organization/project/target identity required by that account
- [ ] allowed region(s)
- [ ] approved CPU, memory, disk, idle timeout, and maximum lifetime
- [ ] permission to create/delete test sandboxes and snapshots
- [ ] container registry/image import details
- [ ] a strict test spending limit

### Needed before Stage 6/8: Git and agents

- [ ] GitHub App ID
- [ ] GitHub App client ID
- [ ] GitHub App private key
- [ ] GitHub App webhook secret
- [ ] installation on a disposable test organization/repository
- [ ] test repository with permission to create branches and PRs
- [ ] decision and credentials for model access
- [ ] at least one supported coding agent selected for the first real E2E
- [ ] confirmation that third-party subscription login is contractually allowed,
      or API-key/gateway access instead

### Needed before deployment

- [ ] cloud API and web domains
- [ ] TLS/certificate and DNS ownership
- [ ] deployment target for AO Cloud Go service
- [ ] deployment target for the browser app/landing app
- [ ] container registry
- [ ] KMS/secret manager
- [ ] object storage if durable large terminal segments/artifacts are retained
- [ ] error monitoring/logging/tracing destination
- [ ] backup destination and retention policy

## Proposed environment names

Final names may follow the selected providers, but the application should expect
concepts like:

```text
AO_CLOUD_PUBLIC_URL
AO_WEB_PUBLIC_URL
AO_DATABASE_URL
AO_OIDC_ISSUER
AO_OIDC_CLIENT_ID
AO_OIDC_CLIENT_SECRET
AO_AUTH_COOKIE_SECRET
AO_ENCRYPTION_KEY_ID
AO_DAYTONA_API_URL
AO_DAYTONA_API_KEY
AO_DAYTONA_TARGET
AO_GITHUB_APP_ID
AO_GITHUB_APP_CLIENT_ID
AO_GITHUB_APP_PRIVATE_KEY
AO_GITHUB_WEBHOOK_SECRET
AO_OBJECT_STORE_BUCKET
AO_OBJECT_STORE_REGION
```

Browser bundles may receive only explicitly public values. Secrets must fail
closed when accidentally prefixed/exposed to frontend builds.

## Confirmed implementation decisions

### 1. Initial identity and database provider

Use **Supabase PostgreSQL + Supabase Email Auth** for the first
AO-managed cloud deployment. Keep identity behind an AO interface and keep the
database schema standard PostgreSQL so this choice does not become a permanent
domain dependency. Google OAuth can be enabled later.

### 2. Personal account scope first

Cloud V1 is personal-account-first. Every user receives one private personal
account/workspace, and every project, session, provider connection, event,
secret, and sandbox is explicitly scoped to that account.

Authorization isolation is mandatory even though collaboration is deferred:
one user must never access another user's resources. Organization creation,
invitations, owner/admin/member management, teams, shared sessions, SSO, and
SCIM are deferred to [`TODO-CLOUD.md`](TODO-CLOUD.md).

The persistence and service boundaries must allow a personal account to become
or join an organization later without rewriting session or sandbox identity.
No organization/team controls appear as disabled stubs in Cloud V1.

### 3. Daytona credential model

Support both:

- an AO-managed Daytona connection configured by the deployment operator; and
- a user-provided Daytona connection configured in cloud settings.

The user explicitly chooses the billing/provider connection when relevant.
Both modes implement the same sandbox-provider port and encrypted
provider-connection record.

### 4. Coding-agent account access

Users connect their Claude, Cursor, Codex, or other supported coding-agent
account through AO. AO stores the resulting long-lived credential or refresh
capability encrypted outside the sandbox, refreshes it through a credential
broker, and gives a worker only short-lived, session-scoped access.

This is the required product behavior, but each provider needs a compatibility
and terms check before its connector is declared supported. If a provider does
not expose an approved third-party OAuth/device/subscription-login mechanism,
AO must use that provider's supported API-key or gateway flow rather than
copying unsupported browser credentials into a VM.

Claude Code, Codex, and Cursor are all required Cloud V1 connectors. Cloud V1 is
not complete if only one of these three can authenticate, start, stream,
reconnect, and resume correctly. A deterministic fake agent remains useful for
fault tests, but it does not satisfy this product requirement.

### 5. Source-control scope

Cloud V1 is GitHub-only. Repository access uses a GitHub App installation with
narrow repository grants. GitHub identity login and GitHub repository
authorization remain separate security decisions even when they belong to the
same human.

GitLab and Bitbucket are deferred to [`TODO-CLOUD.md`](TODO-CLOUD.md).

### 6. Cloud UI scope

Implement exact visual/behavioral parity for applicable project, orchestrator,
worker, terminal, files, PR/review, preview, notification, search, and settings
flows.

Local-only controls are absent in web mode rather than disabled or stubbed.
Every control that is visible in the cloud UI must have a complete cloud
implementation.

### 7. Orchestrator isolation

The cloud orchestrator receives its own Daytona sandbox, just like each worker.
It does not run inside the AO Cloud control-plane process.

### 8. Retention

Use these initial defaults:

- pause after 30 minutes of inactivity;
- retain a completed sandbox for 7 days;
- retain durable events and terminal logs for 30 days.

Retention must remain configurable within server-enforced limits. Exact maximum
sandbox lifetime, project snapshot retention, hard-deletion timing, and
plan-specific limits require operational validation and are tracked in
[`TODO-CLOUD.md`](TODO-CLOUD.md).

### 9. Resource profile

The default Daytona sandbox profile is **4 vCPU, 8 GB RAM, and 10 GB disk** for
the current Daytona tier.
Users may select another deployment-approved profile. AO enforces minimums,
maximums, concurrency, and spending limits rather than accepting arbitrary
provider values from the browser.

### 10. Deployment target

Run the AO Cloud Go control plane locally during development. Deploy the
existing website/cloud web entry on Vercel and deploy the always-on AO Cloud Go
control plane on Render so its WebSocket and worker connections are not tied to
serverless request lifetimes. Use Supabase for PostgreSQL and identity.

The landing site is currently built as a static export and canonically deployed
through GitHub Pages. Moving it to Vercel is therefore an intentional deployment
change, not reuse of an existing Vercel production setup. A separate cloud SPA
at an app subdomain is lower risk than forcing the Electron/Vite renderer
directly into the Next.js landing package.

## Explicitly out of scope for this V1 pass

- local-to-cloud database synchronization;
- automatic movement of an active local process into cloud;
- cloud-to-local synchronization;
- one permanent VM per user;
- multiple unrelated sessions sharing one sandbox by default;
- exposing the local unauthenticated daemon to the internet;
- making Daytona concepts part of shared domain types;
- shipping demo data or disabled placeholders as cloud functionality.

## Definition of done

Cloud Agent V1 is done only when:

1. local AO still passes the documented regression baseline;
2. a user can log in and log out through the website;
3. a user can authorize and add a Git repository;
4. a user can configure the selected Daytona billing connection;
5. starting a project orchestrator provisions its isolated sandbox;
6. the orchestrator can provision separate worker sandboxes;
7. real supported agents run inside the worker image;
8. PTY output and normalized events are durably ordered;
9. browser refresh/reconnect replays missed history and resumes live;
10. LCM, SCM, files, reviews, previews, and notifications work for cloud-owned
    sessions;
11. no cloud session depends on the local daemon or Electron remaining open;
12. tenant, secret, network, lifecycle, and provider boundaries pass their
    integration/security tests;
13. no production cloud surface contains a stub.
