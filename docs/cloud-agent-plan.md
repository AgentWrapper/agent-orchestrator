# Cloud Agent Plan

> A beginner-friendly explanation of how Cursor Cloud Agents and Claude Code on
> the web work, what the reviewed Docker/Daytona branches actually built, and
> how Agent Orchestrator should become a real cloud-agent product.

## TL;DR

The reviewed branch does **not** contain a cloud-agent platform.

- Its Daytona code creates a temporary cloud machine to test an AO desktop
  release. That is useful CI, but users cannot run their own AO sessions there.
- Its Docker branches run containers on the same computer as AO. That is local
  isolation, not remote cloud execution.
- The Docker branches are hundreds of commits behind `main` and should not be
  used as the base of the new system.

Cursor and Claude use the same broad pattern:

1. A user selects an authorized repository and submits a task.
2. A control plane creates an isolated cloud machine.
3. The repository is cloned **inside** that machine.
4. The agent installs dependencies, edits code, runs tests, and starts previews.
5. The user watches through authenticated logs or a terminal.
6. Git operations use narrowly scoped credentials or a secure proxy.
7. The result is pushed to a branch and offered as a pull request.
8. The machine is paused, snapshotted, or destroyed.

AO should follow that pattern. Build a cloud control plane on the current Go
architecture, hide the first sandbox provider behind an interface, and run one
isolated sandbox per active AO session by default.

### Ratings

| System                                |     Rating | Meaning                                                          |
| ------------------------------------- | ---------: | ---------------------------------------------------------------- |
| Reviewed Daytona work                 |   **2/10** | A cloud smoke test, not a cloud product                          |
| Reviewed local Docker runtime         | **2–3/10** | Useful experiment, unsafe and incomplete for cloud               |
| First remote single-user AO prototype | **5–6/10** | An agent can really work remotely                                |
| Durable authenticated MVP             |   **7/10** | Useful to early users without constant babysitting               |
| Secure production beta                |   **8/10** | Strong isolation, recovery, previews, quotas, and observability  |
| Mature Cursor-like service            |   **9/10** | Proven at scale with polished operations and enterprise controls |

A plan does not earn an 8/10 by itself. AO reaches that score only after the
design is implemented, tested, operated, and shown to recover from failures.

---

## Caveman dictionary

### Control plane

The **boss**.

It remembers users, repositories, sessions, permissions, and machine state. It
tells cloud providers when to create or destroy machines.

### Sandbox

The **cave where the agent is allowed to make a mess**.

It is an isolated container, microVM, or VM containing code and development
tools. If the agent breaks something, the damage should stay inside that cave.

### VM

A virtual computer. It has its own operating system, processes, filesystem, and
network boundary.

### MicroVM

A smaller, faster VM. It aims to give stronger isolation than an ordinary
container while starting much faster than a traditional VM.

### Container

A separated process environment sharing the host's kernel. Containers are
excellent developer tools, but an ordinary container is not automatically a
safe hostile multi-tenant boundary.

### Worker

The software inside the sandbox that runs the coding agent and reports status
to the control plane.

### Provider

The company or infrastructure that supplies sandboxes, for example Daytona,
E2B, Modal, Fly Machines, or our own VM fleet.

### Snapshot

A reusable photograph of a machine's disk. It avoids reinstalling the same
dependencies for every new task.

### Reconciliation

The boss repeatedly asks, “What actually exists?”

If the database says a machine is running but the provider says it disappeared,
the system repairs the record. If the provider has an orphaned machine, the
system cleans it up.

### Secret broker

A guarded middleman for credentials. It gives a session only the temporary
permission it needs instead of copying the user's master token into the VM.

### Preview proxy

A guarded front door for applications started by an agent. The user receives an
authenticated URL instead of exposing a random container port to the internet.

---

## How Cursor Cloud Agents work

The following is based on Cursor's public documentation. Their private internal
implementation may contain additional systems.

### Simple version

Cursor gives each cloud agent an isolated cloud VM. It clones the authorized
repository into the VM, configures tools and secrets, runs the agent, and lets
the user inspect the result.

### Important details

- Cloud agents run in dedicated isolated VMs rather than on the user's laptop.
- Cursor documents Firecracker-based microVM infrastructure.
- The VM contains a full development environment: repositories, dependencies,
  setup commands, selected secrets, and allowed network access.
- Environments can be configured with setup instructions or a Dockerfile.
- A configured environment can be snapshotted so later agents start faster.
- Cursor supports multi-repository environments for tasks spanning several
  related repositories.
- The agent can run tests, servers, desktop software, and browsers.
- Cursor manages provisioning, snapshots, capacity, and teardown.
- Repository access is limited to repositories authorized through the source
  control connection.
- Teams can restrict outbound network destinations.
- Secrets are scoped to configured environments.
- Private services can be reached through controlled private connectivity.

### Lesson for AO

The important product is not “Docker support.” The important product is the
entire managed lifecycle:

```text
authorize -> provision -> clone -> configure -> run -> observe
          -> preview -> push -> pause/delete -> reconcile
```

---

## How Claude Code on the web works

The following is based on Anthropic's public documentation and engineering
posts.

### Simple version

Each web session starts in a fresh Anthropic-managed VM. Claude clones the
selected GitHub repository, works inside the VM, and pushes its result to a
reviewable branch.

### Important details

- Each session runs in an isolated cloud VM.
- Sessions continue after the browser is closed and can be monitored from
  another device.
- Network access is restricted by default and can be configured.
- Setup scripts and environment variables customize the VM.
- GitHub credentials and signing keys are not placed directly in the sandbox.
- Git commands pass through a secure proxy.
- The proxy checks the scoped credential, repository, operation, and destination
  branch before attaching the real GitHub authorization.
- A session can move between web and a local terminal through Claude's
  cloud/teleport workflow.

### Lesson for AO

The Git proxy is especially important. An agent should not receive a permanent
GitHub token capable of reading or modifying every repository owned by a user.

The safe model is:

```text
agent asks to push
    -> AO Git proxy checks session + repo + branch + operation
    -> proxy uses the real credential
    -> GitHub receives the request
```

If the sandbox is compromised, the attacker receives only the narrow ability
assigned to that session.

---

## What Cursor and Claude have in common

They differ in product details, but the load-bearing ideas are similar:

1. **Remote execution:** work continues without the user's laptop.
2. **Strong isolation:** each session receives its own environment.
3. **Repository authorization:** users cannot select arbitrary private code.
4. **Code cloned in the sandbox:** no dependency on host bind mounts.
5. **Controlled credentials:** avoid putting broad permanent tokens in the VM.
6. **Durable session records:** the browser may disconnect while work continues.
7. **Remote observation:** logs, terminal output, state, diffs, and notifications.
8. **Network policy:** restrict what untrusted code can contact.
9. **Lifecycle management:** create, pause, resume, snapshot, and destroy.
10. **Git handoff:** branches and pull requests are the durable result.

---

## One VM per repository?

No. The better default is **one sandbox per active task/session**, not one
machine permanently assigned to one repository.

### Normal task

```text
Sandbox A
└── repo-one
```

### Multi-repository task

```text
Sandbox B
├── frontend
├── backend
└── shared-library
```

Multiple related repositories may be cloned into one sandbox when one task must
change them together.

### What not to do initially

Do not put unrelated users or unrelated tasks into the same long-lived VM just
to save money. That creates difficult credential, cleanup, collision, and
security problems.

AO can later support multiple agents inside one sandbox for tightly coordinated
work, but the first production model should be:

```text
one AO session -> one isolated sandbox -> one or more authorized repositories
```

---

## What the reviewed repository actually built

### Daytona release test

The Daytona code:

1. Runs from GitHub Actions.
2. Gets a Daytona API key through Azure OIDC and Key Vault.
3. Creates one temporary Daytona sandbox.
4. Uploads a published AO Linux package and a Playwright harness.
5. Starts the real Electron app and Go daemon.
6. Checks that the UI paints and the daemon becomes ready.
7. Downloads logs and deletes the sandbox.

This proves AO software can run in a Daytona environment. It does **not** let an
AO user create a cloud coding session.

### Local Docker runtime

The Docker branches:

1. Create a local Docker or Compose container.
2. Bind-mount the host worktree into the container.
3. Pass environment variables and local credential directories into it.
4. Keep host-side tmux involved in terminal control.
5. Publish selected container ports.
6. Try to remove the resources when a session ends.

This is a useful developer experiment. It is not a remote cloud architecture.

---

## What those branches did well

Do not throw away every idea.

- They recognized that runtimes should be replaceable.
- Runtime handles keep provider-specific details out of most core code.
- They attempted explicit create, liveness, messaging, attachment, and destroy
  operations.
- They added cleanup logic and tests for several failure paths.
- The stronger Docker branch explored resource limits, read-only roots,
  capability drops, and structured attach commands.
- The Daytona harness uses ephemeral infrastructure and avoids copying its API
  key into the sandbox.
- The release smoke test isolates AO state and verifies a real packaged app and
  real daemon.

These are ingredients. They are not the complete meal.

---

## What those branches got wrong or left unfinished

### 1. They solve the wrong level of the problem

Running `docker` is one low-level action. A cloud product also needs identity,
authorization, provisioning, durable state, recovery, networking, secrets,
cost controls, and user-facing lifecycle operations.

### 2. They depend on local host paths

The Docker runtime bind-mounts the existing worktree and AO data directory.
A remote machine cannot mount a path that only exists on the user's laptop.

Cloud sandboxes must clone repositories and create their own workspace.

### 3. Secrets are too broad

The prototypes pass host environment variables and credential directories into
containers. One branch writes the environment into generated Compose YAML.

For a personal local experiment this may be tolerable. For cloud users it is a
major security failure.

### 4. Terminal access is not designed for the public internet

A local loopback terminal can trust the local user. A hosted terminal must
authenticate the user, verify session ownership, expire access, rate-limit
traffic, and record security events.

### 5. Ports are not safe previews

Publishing a Docker port is not a product-grade preview system. Some mappings
can listen on every host interface even when metadata displays a loopback URL.

Use an authenticated reverse proxy with a session-scoped hostname.

### 6. Cleanup errors are hidden

Several destroy paths ignore provider failures and then delete local records.
That can leave running containers, release ports too early, and continue
charging money.

Destroy must be retryable and reconciled. “Delete requested” and “confirmed
deleted” are different facts.

### 7. Port allocation can race

Two sessions can observe the same available port before either binds it.
Production previews should not depend on manually leasing arbitrary host ports.

### 8. There is no durable cloud control plane

There are no tenant records, host placement decisions, operation records,
heartbeats, reconciliation jobs, quotas, leases, or audit events.

### 9. The branches are stale

The reviewed Docker branches are hundreds of commits behind the fork's current
`main` and do not match the current Go rewrite architecture.

Building on them would require repairing old architecture before creating the
cloud product.

### 10. The Daytona gate is not the product

It is a release test. Its fuller implementation also lives on a heavily
diverged branch. Passing that workflow proves only that one package survived
two smoke tests in a temporary VM.

---

## What AO should build

## Recommended product boundary

Keep the existing desktop/local mode. Add cloud mode as a separate deployment
of the same domain concepts.

Do **not** expose the existing unauthenticated loopback daemon to the internet.
Its primary listener must remain on `127.0.0.1`.

Cloud mode should have:

1. A hosted authenticated control plane.
2. A sandbox provider adapter.
3. A worker inside each sandbox.
4. An outbound authenticated worker connection.
5. A Git credential proxy.
6. An authenticated terminal/log stream.
7. An authenticated preview proxy.
8. Durable hosted storage and reconciliation jobs.

## Caveman diagram

```text
Phone / Browser / Desktop
          |
          | login + HTTPS
          v
+---------------------------+
| AO Cloud Control Plane    |
|                           |
| users / repos / sessions  |
| permissions / billing     |
| lifecycle / audit log     |
+---------------------------+
      |             |
      | provider API| scoped Git operations
      v             v
+-------------+  +----------------+
| Daytona/E2B |  | AO Git Proxy   |
| or another  |  | -> GitHub App  |
+-------------+  +----------------+
      |
      | creates
      v
+----------------------------------+
| Isolated sandbox for Session 123 |
|                                  |
| AO worker                         |
| coding agent                      |
| repo A                            |
| optional related repo B           |
| tests and development servers     |
+----------------------------------+
      |
      | outbound authenticated stream
      v
AO control plane -> terminal, logs, status, previews
```

---

## Core architecture

### 1. Cloud control plane

The control plane owns durable facts:

- user and organization
- source-control installation
- repository authorization
- environment definition and version
- cloud session
- requested sandbox operation
- actual sandbox identity and provider
- lifecycle state
- worker heartbeat
- terminal connection grants
- preview routes
- secret grants
- resource usage and cost
- audit events

The UI reads these facts. It must not guess state from a disconnected browser.

### 2. Sandbox provider interface

AO should not spread Daytona-specific API calls throughout the service layer.

Conceptually:

```go
type SandboxProvider interface {
    Create(ctx context.Context, req CreateSandboxRequest) (Operation, error)
    Get(ctx context.Context, sandboxID string) (Sandbox, error)
    Pause(ctx context.Context, sandboxID string) error
    Resume(ctx context.Context, sandboxID string) (Operation, error)
    Snapshot(ctx context.Context, sandboxID string) (Snapshot, error)
    Delete(ctx context.Context, sandboxID string) error
}
```

Provider calls may take time. Creation should return an operation or enter a
provisioning state rather than blocking one HTTP request for several minutes.

### 3. Worker protocol

The worker starts inside the sandbox and makes an outbound TLS connection to the
control plane.

It reports:

- worker version
- sandbox and session identity
- startup progress
- heartbeats
- agent activity
- logs
- terminal stream
- process exits
- preview ports
- Git/diff metadata
- resource usage

The control plane sends:

- start agent
- send message
- interrupt
- resize terminal
- run approved command
- stop session
- rotate temporary grants

Outbound connectivity avoids opening an inbound SSH port on every sandbox.

### 4. Repository provisioning

For each session:

1. Verify the user is allowed to access every selected repository.
2. Mint a short-lived, session-scoped clone grant.
3. Clone repositories inside the sandbox.
4. Create session branches.
5. Run environment setup.
6. Revoke or rotate the initial grant.

Do not upload the user's local working directory as the normal workflow.

### 5. Git proxy

The sandbox receives a temporary credential that only talks to the AO Git
proxy. The proxy enforces:

- user and session are active
- repository is authorized
- operation is allowed
- destination branch belongs to the session
- protected branches cannot be directly modified
- grant has not expired

The real GitHub App token remains outside the sandbox.

### 6. Secret broker

Secrets need:

- encryption at rest
- environment-level allowlists
- session-scoped grants
- short expiration
- revocation
- output redaction
- audit logs
- no persistence in generated Compose files

Prefer proxied access for highly sensitive systems. If a secret must enter a
sandbox, make it narrow and temporary.

### 7. Terminal transport

Every connection must:

1. Authenticate the user.
2. Authorize access to the organization and session.
3. Use a short-lived terminal ticket.
4. Bind that ticket to one session.
5. Expire and rotate it.
6. Apply size, bandwidth, and rate limits.
7. Record connect/disconnect audit events.

### 8. Preview proxy

When an agent starts a server:

1. The worker reports an internal port.
2. The control plane creates a route.
3. The user receives an HTTPS URL.
4. The proxy authenticates the user.
5. The route disappears when the session stops.

Example:

```text
https://preview-123.cloud.ao.dev
```

Do not expose `host:random-port` directly.

### 9. Lifecycle reconciliation

Use explicit states such as:

```text
requested
provisioning
bootstrapping
ready
running
paused
stopping
deleting
deleted
failed
```

Persist requested state and observed state separately.

Example:

```text
desired_state = deleted
observed_state = running
```

The reconciler sees the mismatch, retries deletion, and does not release billing
or security records until the provider confirms the sandbox is gone.

### 10. Persistence and snapshots

The database stores control-plane facts. The provider or attached volume stores
the sandbox filesystem.

Snapshots should contain tools and dependencies, not permanent user tokens.

Support:

- clean environment snapshot
- pause/resume
- session expiration
- snapshot expiration
- explicit delete
- maximum retention policy

### 11. Network policy

Start with controlled outbound access:

- source-control proxy
- model provider
- approved package registries
- user-approved domains
- optionally no general internet

Record the effective network policy for each session.

### 12. Resource and cost controls

Every session needs:

- CPU and memory limit
- disk limit
- maximum running time
- idle timeout
- organization concurrency quota
- monthly spending limit
- automatic pause/delete policy
- usage records

Without these, one forgotten loop can create an expensive surprise.

---

## How this fits the current Go rewrite

The current architecture already has useful boundaries. Extend them instead of
reviving the old TypeScript branch.

### Domain

Add cloud vocabulary under `backend/internal/domain/`:

- `CloudSession`
- `Environment`
- `Sandbox`
- `SandboxOperation`
- `WorkerHeartbeat`
- `Preview`
- `SecretGrant`
- `UsageRecord`

### Ports

Add interfaces under `backend/internal/ports/`:

- sandbox provider
- cloud state store
- Git credential broker
- secret broker
- worker transport
- preview router
- usage meter

### Services

Add service boundaries under `backend/internal/service/`:

- cloud session commands
- environment management
- repository authorization
- terminal grants
- preview grants

### Adapters

Add concrete integrations under `backend/internal/adapters/`:

- first sandbox provider
- GitHub App/proxy
- hosted secret store
- worker WebSocket or streaming transport
- preview proxy

### Storage

Add new SQLite migrations for a local prototype. A hosted multi-instance control
plane will eventually need a server database such as PostgreSQL.

Do not edit old migrations. Persist facts and use database-trigger CDC in the
current architecture.

### Lifecycle and observation

Reuse AO's observe/update/derive rule:

```text
provider observation
    -> durable sandbox facts
    -> derived display state
    -> reconciliation action
```

A failed provider probe must not be treated as proof that a sandbox is dead.

### Existing local daemon

Keep:

- primary listener on `127.0.0.1`
- local unauthenticated behavior
- state under `~/.ao`

Cloud deployment is a separate authenticated boundary. Do not turn the local
listener into a public API.

---

## Provider choice

## Recommendation

Start with one managed provider, but keep the interface provider-neutral.

Good early candidates include Daytona or E2B. The exact choice should follow a
short proof of concept measuring:

- startup latency
- snapshot support
- persistence and pause/resume
- terminal streaming
- private networking
- egress controls
- region support
- deletion guarantees
- quotas and rate limits
- cost
- SDK quality

Do not build and operate our own Firecracker fleet first. That creates a second
company-sized infrastructure problem before AO has validated product demand.

The first provider is a replaceable adapter, not the architecture.

---

## Delivery plan

## Phase 0: settle the contracts

**Resulting rating: still 2/10**

- Define cloud session, environment, sandbox, and operation records.
- Define the sandbox provider interface.
- Define desired versus observed lifecycle state.
- Decide the first managed provider.
- Define worker authentication and message protocol.
- Threat-model repository credentials, terminal access, previews, and secrets.

Exit condition: provider-specific code can be added without changing core
session semantics.

## Phase 1: single-user remote vertical slice

**Resulting rating: 5–6/10**

- One authenticated developer account.
- One GitHub repository.
- Create one remote sandbox per AO session.
- Clone the repository inside the sandbox.
- Install and start one supported coding agent.
- Stream logs and terminal output.
- Send messages and interrupt the agent.
- Push only to a session branch.
- Destroy the sandbox.

Exit condition: a laptop can disconnect while the cloud session completes a
real task and pushes a branch.

This is the first point where AO truthfully has cloud agents.

## Phase 2: durable MVP

**Resulting rating: 7/10**

- Persistent control-plane database.
- GitHub App installation and repository authorization.
- Short-lived worker identity.
- Git proxy or narrowly scoped Git credentials.
- Reconciliation loop.
- Retry-safe create and delete operations.
- Pause/resume or persistent volume support.
- Environment setup configuration.
- Snapshot reuse.
- Authenticated terminal tickets.
- Basic preview proxy.
- Idle timeouts and hard runtime limits.
- Audit log.

Exit condition: early users can rely on the system without developers manually
repairing common failures.

## Phase 3: secure production beta

**Resulting rating: 8/10**

- Organizations and multiple users.
- Tenant isolation tests.
- Secret broker and rotation.
- Network egress policies.
- Multiple authorized repositories per environment.
- Quotas and spending limits.
- Usage metering.
- Orphan detection and cleanup.
- Disaster recovery tests.
- Metrics, alerts, traces, and operator dashboards.
- Security review and penetration testing.
- Provider outage behavior and regional fallback.

Exit condition: AO can safely accept external beta users and survive ordinary
provider, network, and process failures.

## Phase 4: mature service

**Resulting rating: 9/10**

- Multiple provider or region support.
- Capacity forecasting.
- Enterprise SSO and policy controls.
- Private connectivity.
- Advanced image/snapshot management.
- Fast cold starts.
- Sophisticated preview and browser support.
- Signed builds and supply-chain controls.
- Proven backup and restore.
- Published reliability targets.
- Mature billing, support, abuse prevention, and incident response.

The final point is earned through operational history, not feature checkboxes.

---

## First API sketch

This is conceptual, not a final contract.

```text
POST   /cloud/environments
GET    /cloud/environments
POST   /cloud/sessions
GET    /cloud/sessions/{id}
POST   /cloud/sessions/{id}/messages
POST   /cloud/sessions/{id}/pause
POST   /cloud/sessions/{id}/resume
DELETE /cloud/sessions/{id}
POST   /cloud/sessions/{id}/terminal-ticket
GET    /cloud/sessions/{id}/previews
```

Worker-only endpoints should use a separate authenticated surface:

```text
POST /worker/register
POST /worker/heartbeat
WS   /worker/stream
```

Never trust a session ID alone as authorization.

---

## Minimum database sketch

```text
users
organizations
organization_members
scm_installations
authorized_repositories
environments
environment_repositories
environment_versions
cloud_sessions
sandboxes
sandbox_operations
worker_heartbeats
terminal_grants
previews
secret_grants
usage_records
audit_events
```

Every externally created resource needs:

- AO ID
- provider ID
- tenant/owner
- desired state
- observed state
- creation and update timestamps
- last successful observation
- last error
- retry count

---

## Security rules that are not optional

1. Never expose the local unauthenticated daemon to the internet.
2. Never authorize terminal access using only a guessed session ID.
3. Never put a user's broad permanent GitHub token in a sandbox.
4. Never mount one user's host credential directory into a cloud worker.
5. Never treat an ordinary Docker container as the only hostile-tenant boundary.
6. Never expose preview ports directly to the public internet.
7. Never claim deletion succeeded until the provider confirms it.
8. Never silently convert a failed health probe into “dead.”
9. Never reuse one sandbox across unrelated tenants.
10. Never allow unlimited runtime, CPU, disk, or spending.
11. Never store plaintext secrets in generated configuration files or logs.
12. Never let a worker choose its own tenant, repository, or authorization scope.

---

## Testing required before calling it production

### Provider contract tests

Run the same lifecycle tests against every provider:

- create
- duplicate create request
- timeout during create
- worker never connects
- pause/resume
- provider API outage
- delete
- delete timeout
- repeated delete
- sandbox disappears unexpectedly

### Security tests

- user cannot open another user's terminal
- session cannot clone an unauthorized repository
- session cannot push to an unauthorized branch
- expired grants fail
- revoked secrets stop working
- preview URLs require authorization
- logs redact secrets
- worker cannot impersonate another sandbox

### Recovery tests

- restart the control plane during provisioning
- restart during deletion
- disconnect the worker
- lose database connectivity
- receive duplicate provider events
- observe an orphaned provider resource
- observe stale database state

### Real end-to-end test

Use the lesson from the existing Daytona harness:

1. Create a real sandbox.
2. Clone a test repository.
3. Start a real agent or deterministic fake agent.
4. Modify a file.
5. Run a test.
6. Start a preview.
7. Push a branch.
8. Destroy the sandbox.
9. Confirm the provider has no remaining resource.

---

## What we should reuse

From the existing work, reuse ideas—not the stale branch:

- provider-neutral runtime handles
- explicit lifecycle operations
- structured terminal attachment
- resource limits and stronger container defaults
- cleanup tests
- ephemeral Daytona testing
- real packaged-app smoke testing

Reimplement those concepts on current `main` using Go ports, services, adapters,
durable facts, and observation loops.

---

## What we should not reuse

- local host bind mounts as the cloud workspace model
- broad environment copying
- writable host credential mounts
- unauthenticated terminal routes
- raw Docker port publication
- hidden cleanup failures
- flat files as the hosted control-plane database
- host tmux as the remote transport
- provider calls scattered through core code
- either stale Docker branch as the merge base

---

## Exact next steps

1. Write an ADR fixing the cloud boundaries and first provider.
2. Threat-model Git, secrets, terminal access, previews, and worker identity.
3. Define cloud domain records and provider/worker interfaces in Go.
4. Create migrations for environment, cloud session, sandbox, operation, and
   worker heartbeat facts.
5. Build a fake provider and lifecycle contract tests first.
6. Implement the first real managed-provider adapter.
7. Build a minimal worker image containing AO worker software and one agent.
8. Implement repository cloning through a short-lived Git grant.
9. Add authenticated worker heartbeat and log streaming.
10. Complete the single-user vertical slice.
11. Add reconciliation before adding more providers.
12. Add authenticated terminal and preview proxies.
13. Add pause/resume, snapshots, quotas, and cost limits.
14. Run security and failure-injection testing.
15. Only then invite external beta users.

---

## Final recommendation

Do not continue polishing the reviewed Docker branch into a cloud product.

Start from the current Go `main`. Use a managed sandbox provider for compute,
keep provider details behind a Go port, clone authorized repositories inside
each sandbox, and treat authentication, secrets, lifecycle reconciliation,
terminal access, previews, and cost controls as first-class systems.

The shortest honest path is:

```text
current AO Go architecture
    + managed sandbox adapter
    + worker protocol
    + GitHub App / Git proxy
    + authenticated cloud control plane
    + durable lifecycle reconciliation
```

That path produces a real **5–6/10 remote prototype**, then a **7/10 MVP**, and
finally an **8–9/10 product** as security and operations mature.

---

## Public references

- [Cursor Cloud Agents overview](https://cursor.com/docs/cloud-agent)
- [Cursor Cloud Agent setup](https://cursor.com/docs/cloud-agent/setup)
- [Cursor Cloud Agent security](https://cursor.com/docs/cloud-agent/security)
- [Cursor Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities)
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code web quickstart](https://code.claude.com/docs/en/web-quickstart)
- [Anthropic: Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
