# Cloud Agent Plan Nihal

> A decision record for the AO cloud-agent architecture discussed after the
> review of the existing Daytona and Docker branches, expanded with the
> self-hosted AWS direction, competitive research, and the deployed Cloud V1
> implementation through 2026-07-30.

This document has three purposes:

1. Record what Nihal has confirmed or substantially agreed with.
2. List the remaining decisions from
   [`cloud-agent-plan.md`](cloud-agent-plan.md) that still need discussion.
3. Compare Factory Droid, Conductor, Orca, T3 Code, and Superset, then identify
   the strongest reusable patterns for AO.

This began as a planning document. AO now has a working hosted test vertical
slice, so planning-era recommendations below must not be mistaken for current
facts. Read [`../ao-cloud/CURRENT_ARCHITECTURE.md`](../ao-cloud/CURRENT_ARCHITECTURE.md)
for the exact implementation and [`TODO-CLOUD.md`](TODO-CLOUD.md) for remaining
work.

The competitor sections distinguish between behavior verified in public source
code and behavior described only in vendor documentation. Factory Droid and
Conductor do not provide public implementation repositories for the relevant
cloud systems, so no private internals are assumed.

## 2026-07-30 implementation update

The current vertical slice implements:

- Supabase user authentication and account-scoped PostgreSQL `ao_*` tables;
- a separately deployed Render control plane;
- one Fly Machine plus encrypted persistent volume per orchestrator/worker
  session, with Daytona retained behind the same sandbox-provider interface;
- a headless AO worker running Claude Code, Codex, or Cursor;
- structured, durable `chat.*` events and first-class `ao_turns`;
- replay, SSE, stale-stream/focus/online reconnect, prompt acknowledgement,
  interruption, worker replacement, and browser-close survival;
- project-time orchestrator prewarming and durable worker delegation through
  cloud `ao spawn/send/status`;
- a scoped Git smart-HTTP proxy using a temporary deployment credential source;
- a cloud web UI with session-isolated chat state, background prefetch,
  immediate multi-session status, and PTY only as fallback;
- safe structured Render logs for request latency, turn queueing, worker
  lifecycle, and VM lifecycle.

The rough architecture notes are resolved as follows:

- **“Fork existing contracts with auth + user args for cloud”:** do not fork
  every contract or add user arguments to local DTOs. Reuse semantic contracts;
  cloud auth middleware supplies account identity to cloud-only services.
- **“AO Cloud service”:** implemented as a modular Go control plane plus
  Postgres, reconciliation, worker hub, SCM proxy, and provider adapters.
- **“Local to both / web to only cloud / app to only cloud”:** the browser is
  cloud-only today; Electron and the normal `ao` CLI are local-only today.
  Cloud workers use a separate cloud-aware `ao` CLI. Electron may gain a cloud
  transport later, but it is not cloud-only.
- **“Single place to define local + cloud API”:** shared semantics and agent
  adapters are defined once, while local-only and cloud-only wire operations
  remain typed extensions. The local API is generated; generating the cloud
  client from a cloud schema is still a tracked maintenance task.
- **“Daytona abstractions configurable in the UI”:** LCM depends on a sandbox
  provider port. Fly and Daytona adapters exist. Settings reflects the deployed
  provider; Daytona deployments accept encrypted user-owned credentials while
  Fly credentials remain operator-managed.
- **“Local agent talks to local API / cloud agent talks to cloud API”:**
  implemented exactly. Neither agent transport falls through to the other
  authority.
- **“No syncing”:** confirmed. SQLite/local sessions and Postgres/cloud sessions
  do not replicate.
- **“Extract to another repository later”:** boundaries support it, but Go
  `internal` packages intentionally keep shared code in one repository today.
  Extraction requires a versioned shared module and compatibility suites.
- **“Keep a cloud fork open source”:** there is no duplicate cloud fork. Open
  source/commercial packaging is a later product decision; duplicate code would
  create unnecessary maintenance now.
- **“LCM / SCM”:** LCM is desired-versus-observed sandbox reconciliation. SCM is
  repository authorization, Git proxying, and normalized PR/check/review facts.
  Both are detailed in the current-architecture document.
- **“Cmd+Shift+N creates a worktree”:** not implemented as a shared shortcut.
  Local new-task creation may create a worktree; cloud new-task creation creates
  a durable session, clone, branch, and sandbox. A future shortcut should invoke
  high-level “new task,” not expose local worktree mechanics to cloud.

## TL;DR

AO will keep local sessions and add a separately deployable cloud system.

```text
Electron/Desktop
├── Local AO daemon → local sessions
└── AO Cloud control plane
    ├── AO-managed deployment → managed sandbox provider
    └── customer deployment → customer AWS session VMs
```

The default cloud model is:

```text
one AO cloud session
    → one isolated Linux VM or strong sandbox
    → one lightweight AO worker
    → one coding-agent process
    → one dedicated Git branch
    → one or more authorized repository clones
```

The local app may close without stopping cloud work. The AO Cloud control plane,
session environment, and coding agent continue running. When the user returns
from the same or another device, AO replays missed events and resumes live
streaming.

For the company deployment discussed most recently, the dashboard, Go control
plane, PostgreSQL/RDS, object storage/S3, KMS, and session compute all run in the
company's AWS account. Employees never enter AWS credentials when they click
“Move to cloud”; the installed control plane uses a narrowly scoped IAM role.
AO's central infrastructure may provide licensing, signed updates, and opt-in
support telemetry, but it does not receive the customer's repositories,
conversations, credentials, logs, or session state.

The cloud system is intended to be complete and production-grade. It is not
intended to ship as a disposable or insecure prototype.

---

## This is what we talked about

## 1. The existing branch is not the architecture we are building

The reviewed branch contains two different experiments:

### Existing Daytona work

```text
GitHub Actions
    → create temporary Daytona sandbox
    → upload an AO desktop release
    → run two smoke tests
    → delete sandbox
```

This proves that AO software can run inside Daytona. It does not let an AO user
create or manage a cloud coding session.

### Existing Docker work

```text
Local AO
    → local Docker CLI
    → local container
    → host worktree mounted into container
    → host tmux controls the agent
```

This remains dependent on the user's computer. It is local container isolation,
not remote cloud execution.

### Decision

- Keep useful ideas and the Daytona CI smoke test.
- Do not use the stale Docker branch as the cloud implementation base.
- Build the cloud feature from the current Go architecture.
- Use Go ports and adapters so Daytona is the first provider, not a permanent
  dependency throughout the core code.

---

## 2. Local AO and AO Cloud are separate deployments

The current Electron application starts a local Go daemon. That daemon controls
local sessions and remains bound to loopback.

The complete system adds a separately deployable Go application:

```text
User device
├── Local Go daemon
│   └── local worktrees and agents
│
└── AO Cloud service
    ├── PostgreSQL
    ├── sandbox provider adapter
    ├── worker connections
    ├── model and Git gateways
    └── cloud-session APIs and streams
```

### Decision

- The local daemon remains responsible for local sessions.
- The AO Cloud service remains responsible for cloud sessions.
- Closing the local daemon must not affect cloud sessions.
- The two deployments may share Go domain packages and interfaces.
- The cloud service can initially be one modular Go application. It does not
  need to be split into many microservices.
- The local unauthenticated daemon must never be exposed to the internet.

---

## 3. What “AO Cloud Control Plane” means

The control plane is not necessarily a giant new platform. It is the hosted Go
service plus its database and reconciliation loop.

Its minimum responsibilities are:

- authenticate users
- authorize repository and session access
- map an AO session to a provider sandbox
- request VM creation, pause, resume, snapshot, and deletion
- route commands to the correct worker
- receive logs and events from workers
- enforce resource and spending limits
- protect model, Git, and infrastructure credentials
- detect and repair mismatches between AO and its configured provider

### Core identity mapping

The central mapping is simple:

```text
AO session ID → provider → sandbox/VM ID
```

The additional state exists for security and recovery, not because routing
requires a complicated scheduler.

---

## 4. One active cloud session gets one VM by default

“One cloud agent gets one VM” means one worker/task session, not one shared
orchestrator.

```text
AO Cloud service
├── Session A → isolated environment A
├── Session B → isolated environment B
└── Session C → isolated environment C
```

Two tasks working on the same repository still receive separate VMs:

```text
Repository backend
├── Session 123 → VM A → branch ao/session-123
└── Session 124 → VM B → branch ao/session-124
```

### Reasons

- independent CPU and memory
- no terminal or port collisions
- simpler cleanup
- better credential isolation
- one failed agent does not damage another session
- VMs can be paused or deleted independently
- session-to-VM routing remains obvious

### Decision

- Default to one isolated Linux VM or equivalently strong sandbox per active AO
  cloud session.
- Use Daytona as the intended first AO-managed provider, while customer-hosted
  deployments use a customer-approved provider inside their account.
- Do not route a new unrelated worker into an existing VM merely because it
  uses the same repository.
- Improve startup time with snapshots and warm capacity rather than sharing VMs.
- Multiple agents in one VM may be considered later only as an explicit,
  trusted coordination mode.

---

## 5. Repository clone, branch, and worktree model

Because a cloud VM belongs to one session, a normal clone and branch already
provide isolation.

```text
Session VM or sandbox
└── /workspace/repository
    └── checked out at ao/session-123
```

A Git worktree is not required for the default model. Worktrees become useful
only if several workers intentionally share one VM or one repository cache.

### Decision

- Clone the repository inside the session environment.
- Use a dedicated branch for the AO session.
- Do not bind-mount paths from the user's laptop.
- Do not require Git worktrees inside the VM for the normal one-session-per-VM
  model.
- Allow a single task to clone more than one related repository when required.

---

## 6. AO software inside the VM

The VM needs AO software, but not the entire desktop application or hosted
control plane.

Each VM contains:

```text
Isolated session VM or sandbox
├── lightweight signed AO worker
├── selected coding-agent CLI
├── authorized repository clone(s)
├── development tools
└── task-specific processes and preview servers
```

The AO worker:

- registers the session and sandbox identity
- starts and controls Claude, Codex, Cursor, OpenCode, or another agent
- captures raw terminal output
- captures structured agent events
- handles user messages and interrupts
- reports heartbeats and process state
- reports preview ports
- reports resource usage
- reconnects to AO after transient network failures

### Decision

- Install a lightweight, headless AO worker in each VM.
- Do not install the Electron desktop application in each VM.
- The worker connects outward to the AO Cloud control plane responsible for its
  deployment.
- Do not expose an unauthenticated worker or SSH endpoint publicly.
- Use an authenticated encrypted worker connection, with mTLS as the current
  recommended mechanism.

---

## 7. How applications communicate

```text
Electron, web, or mobile client
    → authenticated HTTPS commands
    → its AO Cloud deployment

AO Cloud control plane
    → selected provider API
    → create/pause/resume/delete session environment

AO worker inside session environment
    → outbound authenticated stream
    → AO Cloud control plane

AO Cloud control plane
    → replay + live WebSocket/SSE
    → connected clients
```

The desktop client should not receive provider credentials or directly control
a VM.

The VM should not be a public service that trusts possession of a session ID.

### Decision

- Clients communicate with their AO Cloud deployment.
- AO Cloud communicates with the configured sandbox provider.
- Workers create outbound connections to AO Cloud.
- AO Cloud routes commands and streams to the correct session.
- Other authorized devices can interact with the same cloud session.

---

## 8. Desired state and observed state

### Desired state

What the user or AO wants:

```text
running
paused
deleted
```

### Observed state

What the configured provider and AO worker last confirmed is actually true:

```text
provisioning
bootstrapping
ready
running
paused
disconnected
deleting
deleted
failed
```

The client does not declare that an operation succeeded. It only requests a
change in desired state.

### Example: deletion timeout

```text
User clicks Delete
desired_state = deleted

Daytona request times out
observed_state = running

AO reconciler retries
Daytona confirms deletion
observed_state = deleted
```

### Why both are required

They handle:

- AO restarting during VM creation
- a response being lost after Daytona created a VM
- Daytona automatically stopping a VM
- an unexpected VM crash
- a disconnected worker
- a deletion request timing out
- an orphaned VM continuing to run and cost money

### Decision

- Store desired and observed state separately.
- Provider observations and worker reports update observed state.
- A reconciliation loop retries until desired and observed state agree.
- A failed probe is not proof that a VM is dead or deleted.

---

## 9. Minimum cloud-session record

Repository and branch facts may already live in AO's existing session records.
The cloud-specific mapping can remain small.

```text
cloud_sessions
├── session_id
├── provider
├── sandbox_id
├── desired_state
├── observed_state
├── worker_last_seen_at
├── resource_profile
├── last_error
├── created_at
└── updated_at
```

Additional tables may be required for operations, events, grants, previews,
usage, and audits, but the routing identity remains `session_id → sandbox_id`.

### Decision

- Use PostgreSQL for hosted cloud state.
- Keep the session-to-sandbox mapping explicit.
- Do not duplicate repository and branch data unnecessarily if existing session
  tables already own those facts.

---

## 10. Cloud sessions continue after the local app closes

Expected behavior:

```text
User starts cloud task
    → closes Electron and local Go daemon
    → AO Cloud continues running
    → session environment and agent continue running
    → agent completes or waits for input
    → user opens AO later or from another device
    → AO loads durable session state
    → missed events are replayed
    → live streaming resumes
```

### Durable storage responsibilities

- **PostgreSQL:** session records, conversations, structured events, lifecycle
  state, VM mapping, checkpoints, grants, and usage records.
- **Object storage:** large terminal logs, test artifacts, screenshots, traces,
  and other large blobs.
- **Provider volume or snapshot:** current filesystem and process state.
- **Git provider:** durable branch, commits, and pull request.

Not every byte needs to be stored directly inside PostgreSQL.

### Decision

- Cloud sessions must not depend on the local daemon remaining alive.
- Users must be able to reconnect from another authorized device.
- Missed events must be replayable before the client rejoins the live stream.

---

## 11. Logs, terminal output, and agent events

The AO worker sends two related streams.

### Raw terminal stream

- PTY bytes
- stdout and stderr
- interactive input
- terminal resize events

### Structured event stream

- agent started
- tool call started/completed
- command started/completed
- test failed/passed
- agent waiting for input
- agent blocked
- agent completed
- preview started
- Git branch or PR updated
- resource and lifecycle events

Events receive ordered sequence numbers.

Reconnect flow:

```text
Client last received sequence 520
    → reconnect with after_sequence=520
    → AO replays 521 through current
    → AO switches client to live events
```

### Decision

- Stream actual raw logs, not only summarized status.
- Also stream structured events for UI, recovery, and automation.
- Persist enough history to replay missed output.
- Redact credentials before durable storage or display.

---

## 12. Local versus cloud task creation

Task/session creation should let the user choose:

```text
Run locally
Run in cloud
```

Cloud sessions are created through AO Cloud. Local sessions continue
through the local daemon.

### Decision

- Cloud should be a first-class execution choice during task creation.
- Local mode remains supported.
- The UI also needs a “Move to cloud” concept, subject to the migration details
  listed in the unresolved section.

---

## 13. What “Move to cloud” means

Moving to cloud does not teleport a running operating-system process.

Conceptually AO will:

1. capture or publish the local code state
2. create a cloud session and isolated environment
3. clone the repository inside the VM
4. check out the same session branch
5. transfer conversation context and relevant AO configuration
6. start or resume the selected agent remotely
7. switch the UI to the cloud session

The exact handling of dirty, uncommitted files is not yet confirmed.

### Decision

- “Move to cloud” recreates or resumes the logical AO session remotely.
- It does not move the exact local process or RAM state.
- Code, conversation, configuration, and agent resume identity are the portable
  parts.

---

## 14. Claude, Codex, and other agent authentication

The sandbox provider supplies the computer. It does not automatically supply
Anthropic, OpenAI, or other model usage.

Users should connect model access once through AO. Permanent credentials should
not be copied into every VM.

Recommended flow:

```text
User connects model provider to AO
    → credential encrypted outside VM
    → AO issues short-lived session access
    → agent calls AO model gateway
    → AO authorizes and forwards to model provider
```

Claude and Codex technically support API or automation credentials, but
subscription-login support for a third-party product may require explicit
provider approval.

### Decision

- Build for complete credential isolation rather than raw key injection.
- Permanent model credentials remain outside session environments.
- Use short-lived, session-scoped access from the VM.
- The exact BYOK, AO-billed, OAuth, and subscription-login product model remains
  unresolved.

---

## 15. Git authentication

The VM should not receive a broad permanent GitHub token.

Recommended flow:

```text
Agent requests Git operation
    → AO Git proxy validates user, session, repository, branch, and operation
    → proxy uses GitHub App authorization
    → GitHub receives the request
```

The normal cloud session may:

- clone authorized repositories
- fetch updates
- push its dedicated session branch
- create or update its pull request

It should not automatically:

- push directly to protected branches
- access unrelated repositories
- merge without policy
- delete repositories
- use a user's broad personal token

### Decision

- Use a GitHub App and branch-scoped authorization boundary.
- Keep broad Git credentials outside the VM.
- Final merge and protected-branch policies still need confirmation.

---

## 16. Permission behavior inside cloud VMs

Cloud coding agents should not stop for ordinary command-approval prompts.

Inside their disposable VM they may:

- read and write workspace files
- install dependencies allowed by network policy
- run tests and builds
- start development servers
- use normal shell commands

The worker should still run without access to the provider host or other
tenants.

### Hard boundaries at exits

- model calls go through the model gateway
- Git operations go through scoped authorization
- no production credentials are available
- outbound network access is restricted
- preview access is authenticated
- CPU, disk, time, concurrency, and spending are limited

### Decision

- Use automatic command approval inside the isolated cloud VM.
- Avoid routine permission popups for sandbox-internal work.
- Do not interpret “bypass permissions” as unrestricted access to GitHub,
  production systems, the provider host, or other tenants.
- Use the principle: **freedom inside the sandbox, strict control at every
  exit**.

---

## 17. Resource sizing and accounting

Each session receives a resource profile:

- CPU
- memory
- disk
- maximum lifetime
- idle timeout
- concurrency allocation

Small tasks may use low-spec VMs. Builds, browsers, large monorepos, or several
repositories may require larger profiles.

AO Cloud tracks usage for:

- quota enforcement
- cost visibility
- spending limits
- automatic pause/delete decisions
- billing if AO charges users

### Decision

- Apply maximum resources and runtime limits.
- Track usage and cost.
- Default to smaller VMs where practical.
- Do not assume one VM size can handle every repository and workload.

---

## 18. Complete product target

Nihal explicitly rejected shipping a disposable “MVP” architecture.

The target system includes:

- isolated Linux VM or strong sandbox per active session
- provider-neutral Go sandbox interface
- signed AO worker inside each VM
- outbound authenticated worker connection
- model gateway
- GitHub App and Git proxy
- KMS-backed secret management
- authenticated terminal access
- authenticated preview access
- PostgreSQL control-plane state
- append-only events and replayable logs
- retry-safe lifecycle reconciliation
- snapshots, warm capacity, pause, resume, and recovery
- network egress policy
- users, organizations, RBAC, and session ownership
- quotas, usage metering, and spending limits
- audit logs, metrics, traces, and alerts
- backup, restore, and disaster-recovery testing
- orphaned-resource detection and cleanup
- security review and penetration testing

Implementation may still occur in internal stages, but the product should not be
described as complete until these production boundaries exist.

---

## 19. Self-hosted AWS is a deployment of AO Cloud, not a different product

The recent company requirement changes where AO Cloud runs, but it does not
remove the control plane or worker architecture.

### AO-managed deployment

```text
AO account
├── AO dashboard and Go control plane
├── AO PostgreSQL, object storage, and KMS
└── AO sandbox-provider account
    └── isolated session environments
```

### Fully self-hosted company deployment

```text
Company AWS account
├── AO dashboard
├── AO Go control plane
├── PostgreSQL/RDS
├── S3-compatible object storage
├── KMS/Secrets Manager
├── queues and observability
└── AWS sandbox provider
    └── one isolated environment per active AO session
```

The company installs AO once. A privileged company administrator grants the
deployed control plane a narrowly scoped IAM role. Ordinary users then click
“Run in cloud” or “Move to cloud” without seeing AWS credentials or managing
infrastructure.

### AO ships separate artifacts

Do not combine the control plane and per-session worker into one image.

1. **AO control-plane image**
   - dashboard and authenticated API
   - session and repository services
   - PostgreSQL migrations
   - provider adapters and lifecycle reconciler
   - worker connection manager
   - Git, model, secret, terminal, and preview gateways
   - usage, audit, metrics, and update reporting
2. **AO worker image**
   - minimal Linux userspace
   - signed AO worker
   - supported coding-agent CLIs
   - Git and development tools
   - bootstrap that obtains only session-scoped grants
3. **Deployment package**
   - Terraform or CloudFormation
   - IAM policies
   - networking and load-balancer configuration
   - RDS, S3, KMS, backups, monitoring, and upgrade jobs

### Security boundary

- The self-hosted dashboard talks to the company's AO Go service.
- The company's AO Go service talks to the company's PostgreSQL and VMs.
- AO's central service must not retain the company's AWS administrator
  credentials.
- Prefer workload identity/IAM roles over static access keys.
- AO's optional central services may handle license validation, signed-update
  metadata, opt-in anonymous telemetry, and support diagnostics.
- A deployment where customer session data still flows through AO's database is
  hybrid, not fully self-hosted.

### What remains deployment-neutral

The domain records, worker protocol, event schema, session lifecycle,
desired/observed-state reconciliation, Git/model gateways, and UI should remain
the same in AO-managed and customer-managed deployments. Only infrastructure
adapters and deployment configuration should change.

---

## 20. Competitive research summary

Research date: **2026-07-29**.

| Product       | Source visibility                                                  | Execution unit                                 | Remote/cloud model                                                                 | Most useful lesson for AO                                                              |
| ------------- | ------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Factory Droid | Relevant cloud internals closed; official docs reviewed            | Persistent Droid Computer                      | Factory-managed computer or customer-owned machine connected through Factory relay | Offer managed, hybrid, BYOM, and airgapped deployment patterns                         |
| Conductor     | Relevant cloud internals closed; official docs reviewed            | One workspace per isolated cloud machine       | Vercel Sandbox, prebuilt snapshots, sleep/wake, cloud terminals and file mirror    | Separate reusable snapshot initialization from per-workspace setup                     |
| Orca          | MIT source reviewed at `4543bb68263a89ab520cea62ca69d7ac78330dd3`  | Worktree, optionally one ephemeral environment | Local, SSH, remote Orca server, or provider recipe in the user's account           | Provider-neutral repository recipes and host-owned session authority                   |
| T3 Code       | MIT source reviewed at `49c0d96edf280f1fe6750a83161a3a2cff0f25ef`  | Thread inside one T3 execution environment     | Direct/tunneled WebSocket or SSH-launched server; provisioning is not the core     | Event-sourced orchestration, ordered replay, scoped auth, and access/launch separation |
| Superset      | ELv2 source reviewed at `dae2d98f131c0cb2d45472628b826a6f46b355b3` | Worktree on a registered host                  | Standalone host service connects through Superset relay                            | Separate device from host and keep PTY ownership below restartable services            |

These products solve overlapping but different problems. Conductor is the
closest public product description to AO's intended one-sandbox-per-session
managed cloud flow. Orca and Superset are the strongest references for
customer-owned remote hosts. T3 Code has the strongest directly visible
event/auth boundary. Factory has the broadest enterprise deployment model.

---

## 21. Factory Droid

### What is confirmed

Factory's current “Droid Computer” is a persistent, long-lived compute target.
It keeps installed packages, files, running services, and configuration across
sessions. A user selects a computer and working directory when starting a
session.

Factory explicitly documents that the Droid agent loop, file access, and Git
work happen on the selected computer—not inside Factory's SaaS control plane.
Factory cloud coordinates identity, sessions, web surfaces, analytics, and relay
access in connected deployments.

Factory supports:

- **Managed Droid Computers:** Factory provisions and operates the machine.
- **Bring Your Own Machine:** the user registers a VPS, workstation, cloud VM,
  or on-premises server.
- **Cloud-managed enterprise deployment:** Droid runs on laptops or build
  infrastructure while Factory provides orchestration and optional analytics.
- **Hybrid deployment:** Droid and model traffic run in the customer's
  infrastructure while Factory cloud receives limited metadata when enabled.
- **Fully airgapped deployment:** no Factory runtime dependency.

The documented managed-machine lifecycle is:

```text
allocate computer
→ create factory-user
→ write environment, SSH keys, and service files
→ install Droid
→ start SSH and Droid daemon
→ mark active
→ auto-pause when idle
→ auto-resume when targeted
→ remotely update daemon
```

The default documented managed computer has 4 CPUs, 8 GB RAM, and 6 GB swap.
Factory exposes CPU, memory, disk, connection, and daemon-version information.

BYOM starts `droid daemon --remote-access`. The machine connects through
Factory's relay, so it requires no public inbound port. Managed computers also
support SSH and TCP port forwarding through a secure WebSocket tunnel. Factory
uses a dedicated SSH key separate from personal SSH keys.

Factory also exposes a structured `droid exec` JSON-RPC process protocol for
custom clients and orchestrators. It supports streamed events, permissions,
messages, interrupts, resume, fork, and session settings without exposing the
private implementation of Droid's agent loop.

Git behavior differs by deployment:

- BYOM uses credentials already configured on that machine.
- Managed computers receive credentials from the user's GitHub integration and
  refresh repository access on later session connections.

Factory recommends hardened VMs or containers for high-autonomy execution and
documents centralized settings for model access, network policy, telemetry,
proxies, certificates, and organization policy.

### What is not publicly confirmed

Factory does not expose the implementation of its cloud scheduler, relay,
machine database, credential broker, reconciliation jobs, or tenant isolation.
Its official docs prove the product behavior, not the private internal design.

### Strengths

- One product supports managed, BYOM, hybrid, and airgapped operation.
- A persistent computer avoids repeated dependency installation.
- Relay-based access avoids opening raw SSH and application ports.
- Live provisioning stages and resource metrics make infrastructure visible.
- Enterprise policy is hierarchical and centrally managed.

### Limitations for AO

- A long-lived computer can contain several sessions, repositories, credentials,
  and stale processes. That is cheaper and convenient but weaker than AO's
  one-session-per-environment default.
- BYOM trusts whatever Git credentials are already on the host.
- `factory-user` has passwordless sudo; Factory's docs acknowledge that it can
  change host firewall rules.
- Factory's kernel-enforced sandbox is still preview functionality and is
  defense in depth, not a substitute for a dedicated hostile-code VM boundary.
- Persistent computers require stronger cleanup, per-session authorization, and
  cross-session leakage controls.

### AO decision

Adopt Factory's deployment flexibility and relay/BYOM product shape. Do not make
one permanent per-user machine AO's default isolation unit. AO can later offer a
trusted “persistent development host” mode, but its safe default remains one
isolated environment per cloud session.

---

## 22. Conductor

### What is confirmed

Local Conductor workspaces use Git worktrees. A workspace has its own branch,
files, commands, chats, diff, terminal state, and pull-request flow.
Those local worktrees isolate development state, not security permissions:
agents still execute directly with the Mac user's access.

Conductor Cloud keeps the same workspace UX but runs each cloud workspace on an
isolated cloud machine. Its public documentation states that:

- the agent, worktree, and development processes run on the cloud machine
- the agent continues after the laptop closes
- files and conversation survive idle sleep
- cloud terminals run beside the agent
- a read-only local mirror supports editors and local analysis
- ports are forwarded to a local `localhost` address
- up to ten cloud workspaces may run per account during the beta
- cloud repositories currently come from GitHub

Conductor documents Vercel Sandbox as its cloud machine foundation.

### Snapshot and setup model

Conductor builds a reusable project snapshot by:

```text
clone repository
→ run snapshot initialization script
→ install slow/shared dependencies and tools
→ save the environment
```

Each new workspace then:

```text
fork saved snapshot
→ refresh repository to latest commit
→ run per-workspace setup script
→ start agent and terminals
```

This cleanly separates:

- **snapshot initialization:** slow, reusable system packages, dependencies,
  browsers, and tools
- **workspace setup:** branch-specific config, generated files, seeds, and fast
  dependency reconciliation

If a new snapshot build fails, existing workspaces continue and new workspaces
use the last known-good snapshot.

Conductor injects a workspace-scoped API key only into machine-launched cloud
agent processes, not every terminal or setup script. It documents managed
Git/`gh` authentication in the sandbox.

### What is not publicly confirmed

Conductor's cloud control plane, sandbox allocation, storage layout, worker
protocol, relay, credential broker, event durability, and reconciliation logic
are not open source. Public docs establish that the behavior exists but do not
establish its private implementation.

### Strengths

- Cloud and local workspaces share one user model.
- Per-workspace machines match task isolation.
- Snapshot forking provides fast startup without sharing active machines.
- Sleep/wake and durable files allow laptop-independent execution.
- Setup, run, and archive scripts make environments reproducible.
- The issue-to-PR review flow is simple and coherent.

### Limitations for AO

- Cloud is beta and currently GitHub-only.
- The implementation is vendor-controlled and built on Vercel Sandbox.
- The docs describe local secret values being included in cloud workspace
  snapshots. AO should not snapshot permanent model or Git credentials.
- Public docs do not prove enterprise self-hosting or customer-owned AWS
  support.

### AO decision

Conductor is the closest UX benchmark for AO cloud sessions. Adopt the
snapshot-versus-setup split, last-good snapshot behavior, cloud terminal, safe
file browsing, port forwarding, sleep/wake, and identical local/cloud review
flow. Keep Daytona/AWS behind AO's own provider interface and keep permanent
credentials outside snapshots.

---

## 23. Orca

### What the source verifies

Orca supports four execution shapes:

1. local worktrees
2. worktrees on an SSH target
3. a persistent remote Orca server
4. one ephemeral environment per workspace

In remote-server mode, the remote machine owns projects, worktrees, PTYs, agent
processes, and persisted session state. Desktop, web, and mobile clients are
control surfaces. `orca serve` can run headlessly under systemd and advertises a
pairing URL for an encrypted WebSocket connection.

Orca's per-workspace environments are provider-neutral command recipes stored
in repository `orca.yaml` configuration. A recipe can provision Vercel Sandbox,
Fly, Modal, Docker, an SSH host, or another provider selected by the user. The
provider account, image, and bill remain the user's responsibility.

The recipe lifecycle supports:

```text
create → suspend → resume → destroy
```

A create/resume recipe returns either:

- an Orca-server connection and pairing URL, or
- normalized SSH connection details and a remote project root.

The source validates recipe output, persists runtime identity and cleanup
status, records provider-specific opaque `userData`, and redacts sensitive SSH
connection fields from diagnostics.

Orca also implements a host-authority protocol for agent sessions:

- the host, not the renderer, owns the live PTY decision
- concurrent create/resume requests claim or adopt one canonical PTY
- operation IDs make retries idempotent while the authority process is alive
- transient unknown liveness is not treated as death
- exact PTY incarnation IDs prevent stale exits from deleting a replacement
- renderer snapshots cannot resurrect a host-retired terminal surface

### Persistence and reconnect

Headless Orca stores projects, worktree metadata, terminal history,
orchestration state, and paired-device keys in the service user's profile.
Clients can reconnect after a server upgrade without pairing again. Its
documented upgrade process backs up both binary and profile state because old
versions may not understand newer persisted schemas.

Orca has hosted login and mobile-relay services, but they provide identity,
entitlements, and connection routing—not hosted ownership of worktrees, PTYs, or
provider compute.

### Strengths

- Strong provider-neutral BYOC model.
- Repository-owned recipes are inspectable and portable.
- Clear distinction between an SSH-controlled host and a full remote runtime.
- Host-owned PTY authority prevents duplicate agent processes.
- Explicit mixed-version capability negotiation and fail-closed behavior.
- MIT license permits studying and reusing compatible ideas or code.

### Limitations for AO

- Orca is intentionally a thin BYOC wrapper, not a hosted multi-tenant control
  plane.
- Provider recipes are shell-command contracts; AO needs typed provider
  adapters, durable operation records, IAM policy, and centralized
  reconciliation.
- Runtime records are profile-local JSON, not a tenant-aware PostgreSQL control
  plane.
- Direct/Tailscale/SSH access puts more networking responsibility on the user.
- Exactly-once fresh launch does not survive every runtime restart; Orca
  documents a durable operation journal as future work.

### AO decision

Adopt repository-owned environment recipes, provider-neutral lifecycle output,
host-owned PTY authority, idempotent operation IDs, explicit liveness
uncertainty, and versioned capability negotiation. Replace profile-local shell
orchestration with AO's typed Go provider ports, PostgreSQL operation journal,
IAM boundary, and reconciliation loop.

---

## 24. T3 Code

### What the source verifies

T3 Code's runtime boundary is one Node.js server per execution environment:

```text
React client
→ authenticated HTTP/WebSocket
→ T3 server
→ provider adapter
→ Codex JSON-RPC, Cursor/Grok ACP, Claude Agent SDK, or OpenCode events
```

The T3 server owns projects, threads, terminals, files, Git operations,
provider state, and server settings. A remote environment is the same server on
another machine reached through direct WSS, a tunnel, or an SSH-launched port
forward. Launch method and access method are deliberately separate concepts.

T3's orchestration engine:

- serializes commands through a queue
- decides commands against a read model
- appends events inside a database transaction
- projects events into read models
- records command receipts for idempotent replay
- publishes committed events to independent consumers
- exposes sequence-based catch-up followed by buffered live delivery
- falls back to a fresh snapshot when the replay gap is too large

Provider ingestion, command reaction, and checkpoint creation run as
queue-backed workers. Typed receipts indicate milestones such as checkpoint
completion or turn quiescence, avoiding state polling. These workers are
unbounded in-memory synchronization queues, not durable cloud job queues.

Its environment authentication uses capability scopes such as:

- `orchestration:read`
- `orchestration:operate`
- `terminal:operate`
- `review:write`
- `access:read` and `access:write`
- `relay:read` and `relay:write`

Browser sessions exchange a bootstrap credential for an HTTP-only cookie.
Non-browser clients exchange it for a short-lived scoped token. WebSocket
connections use a short-lived, single-purpose ticket so bearer tokens and
cookies do not appear in the socket URL. Every RPC still checks its required
scope. Publicly reachable flows can additionally bind credentials to DPoP proofs
with replay protection.

Threads may use Git worktrees for filesystem and branch isolation, but a
worktree is optional and belongs inside one execution environment.

### What remains target architecture

T3 implements direct, Tailscale, SSH-forwarded, and Cloudflare-tunnel access to
an execution environment. T3 Connect provisions tunnels, DNS, and short-lived
access credentials; it does not proxy normal environment RPC or provision a new
isolated VM per thread. A user or desktop process still supplies the execution
host.

### Strengths

- Excellent event, projection, and replay boundary.
- Provider-native events are normalized before reaching clients.
- Access and launch are cleanly separated.
- Short-lived WebSocket tickets and per-RPC scopes are directly applicable to
  AO.
- One server supports desktop, browser, and mobile clients without changing the
  runtime protocol.
- MIT license permits compatible reuse.

### Limitations for AO

- It does not provide AO's required per-session cloud provisioning,
  desired/observed VM reconciliation, cost controls, or tenant scheduler.
- One T3 environment can own many projects and threads, whereas AO's safe
  default isolates each cloud session.
- Provider authentication remains environment-local; T3 explicitly excludes
  syncing provider auth across machines from its remote design.
- Its orchestration workers are in-memory and unbounded, so AO must retain
  durable recovery and bounded backpressure for infrastructure operations.

### AO decision

Borrow T3's append-only orchestration log, transactional command receipts,
sequence replay plus live handoff, normalized provider events, scoped access
tokens, WebSocket tickets, and access-versus-launch vocabulary. Add AO's
provider-provisioned sandbox lifecycle around that runtime.

---

## 25. Superset

### What the source verifies

Superset separates a **device** from a **host**:

- a device is a desktop, browser, or phone that controls work
- a host is a machine that owns repositories, worktrees, files, terminals,
  ports, and agent processes

Its standalone host service:

- registers with Superset cloud
- clones or registers repositories
- creates and deletes worktree-backed workspaces
- manages Git, filesystem watching, ports, and agents
- is documented as serving a local loopback API
- opens an authenticated outbound WebSocket tunnel to the Superset relay

Local commands call the loopback host directly and can work offline. Remote
commands go through the cloud API and relay to a selected host. A host may be a
desktop, Mac mini, dedicated server, CI machine, or sandbox.

Superset recommends a dedicated host containing only repositories and
credentials intended for remote access. This is important because every
authorized remote client can reach the host service's files, terminals, and
agent runs.

Terminal ownership is split into a lower PTY daemon. The host service speaks to
it over a mode-`0600` Unix socket. PTYs survive routine host-service restarts and
can survive PTY-daemon binary replacement through file-descriptor handoff. A
64-KB per-session ring buffer supports short replay, but it is memory-only and
does not provide durable long-gap terminal history.

### Cloud/state split

Superset cloud stores organization, host, project, and routing records. The
host's local database and filesystem remain authoritative for machine-owned
workspaces. The relay routes HTTP and WebSocket traffic; it does not move the
workspace into Superset's own compute.

Stopping the host interrupts host-backed terminals and work. This is remote
access to a machine, not automatic one-sandbox-per-task provisioning.
The reviewed source contains cloud/sandbox metadata and plans but no active
provider that creates, resumes, or destroys cloud sandboxes.

### License boundary

Superset uses the Elastic License 2.0. It allows source inspection and
modification, but prohibits offering the software to third parties as a hosted
or managed service that exposes a substantial set of its functionality. AO may
learn from the architecture but must not copy Superset into an AO hosted
service without separate permission.

### Strengths

- Clean host/device separation.
- Standalone headless host service with no Electron dependency.
- Local-direct and remote-relay routing share one API model.
- Durable PTY ownership is isolated from restartable business logic.
- Host registration, organization access, and relay reconnect are concrete in
  public source.
- A dedicated host is an understandable enterprise/BYOM deployment primitive.

### Limitations for AO

- A single host may contain many workspaces and credentials.
- The host must stay online; stopping it interrupts active work.
- Remote access does not itself create, isolate, pause, meter, or delete cloud
  compute.
- The current host-server source does not explicitly pass a loopback hostname
  when starting its HTTP server. AO must continue binding local control surfaces
  explicitly to `127.0.0.1`.
- Terminal replay is small and memory-only.
- ELv2 prevents treating the source as a drop-in base for AO's hosted product.

### AO decision

Adopt the device-versus-host vocabulary, standalone headless worker boundary,
outbound relay, local-direct routing, and a PTY owner that can survive
control-service restarts. Keep AO's cloud session worker smaller than
Superset's multi-workspace host, persist replayable events outside the VM, and
do not reuse ELv2 implementation code in AO's hosted service.

---

## 26. Best combined design for AO

No competitor supplies the full AO design. The strongest approach combines one
specific idea from each:

| AO concern                     | Best reference      | AO adaptation                                                                                              |
| ------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Enterprise deployment          | Factory             | Same binaries support managed, customer-hosted, hybrid, and eventually airgapped operation                 |
| Per-task cloud UX              | Conductor           | One isolated environment per workspace/session, sleep/wake, snapshot, terminal, preview, and review parity |
| BYOC environment definitions   | Orca                | Repository-owned recipe compiles into a typed AO environment specification                                 |
| Durable event flow and auth    | T3 Code             | Transactional event log, projections, sequence replay, scoped tokens, and one-use WebSocket tickets        |
| Remote host and PTY management | Superset            | Standalone host/worker, outbound relay, and PTY ownership below restartable services                       |
| Strong sandbox supply          | Daytona/AWS adapter | Provider-neutral Go port with retry-safe operations and desired/observed reconciliation                    |

### Recommended product modes

1. **Local AO**
   - current local Go daemon
   - worktrees for parallel sessions
   - no hosted dependency for local work
2. **AO-managed cloud**
   - AO-hosted control plane
   - Daytona or another managed sandbox adapter
   - AO-operated PostgreSQL, storage, gateways, and billing
3. **Customer-hosted AO Cloud**
   - complete AO control plane in the customer's AWS account
   - AWS-native or customer-approved sandbox adapter
   - customer RDS, S3, KMS, networking, IAM, logs, and billing
4. **Trusted persistent host, later**
   - Factory/Orca/Superset-like registered machine
   - several workspaces may share one customer-owned host
   - explicit lower-isolation mode, never silently substituted for isolated
     session compute

### Daytona versus AWS after the self-hosted change

Daytona remains a strong first adapter for AO-managed personal cloud because it
shortens the path to provisioning, snapshots, terminals, and previews.

It must not become a hard dependency of the self-hosted product. A company that
requires all compute and data in its AWS account needs an AWS-native or
customer-operated sandbox adapter. The provider interface therefore becomes
more important, not less.

Do not select the AWS runtime merely by convenience. Compare EC2 VMs,
Firecracker-based services, Kubernetes plus gVisor/Kata, and any approved
self-hosted sandbox provider against:

- tenant isolation
- startup and resume latency
- persistent-volume and snapshot behavior
- outbound network controls
- private VPC connectivity
- image signing and patching
- per-session IAM
- terminal and preview routing
- orphan discovery and deletion guarantees
- customer operational burden and cost

### Final recommendation

Build AO as a deployable control plane with a small session worker, not as a
desktop app that happens to SSH into machines.

```text
repository task
→ AO authenticates user and repository
→ durable session command is recorded
→ provider adapter creates isolated environment
→ signed worker registers outbound
→ repository clone and session branch are prepared
→ selected agent runs
→ PTY bytes and normalized events stream with sequence numbers
→ client disconnects without stopping work
→ state replays on reconnect
→ result is committed/pushed and reviewed
→ environment sleeps, resumes, or is deleted
→ reconciler confirms provider reality
```

Use Conductor's environment lifecycle, Orca's provider flexibility, T3's
durability and auth, Superset's host/PTY split, and Factory's deployment
flexibility. Keep AO's default isolation stronger than Factory, Orca, or
Superset's shared persistent-host modes.

---

## Final confirmed architecture

```text
Desktop / Web / Mobile
        |
        | authenticated HTTPS + WebSocket/SSE
        v
+--------------------------------------------------+
| AO Cloud Go Application                          |
| (AO-managed or deployed in customer AWS)         |
|                                                  |
| Auth and RBAC                                    |
| Cloud session service                            |
| PostgreSQL                                       |
| Sandbox provider adapter                         |
| Desired/observed-state reconciler                |
| Worker connection manager                        |
| Model gateway                                    |
| GitHub App / Git proxy                           |
| Secret broker                                    |
| Terminal gateway                                 |
| Preview gateway                                  |
| Usage, quotas, audit, metrics, and alerts        |
+--------------------------------------------------+
        |
        | provider API: create/pause/resume/delete
        v
+--------------------------------------------------+
| Isolated environment for AO Session 123          |
|                                                  |
| Signed AO worker                                 |
| Coding agent                                     |
| Authorized repository clone(s)                   |
| Dedicated session branch                         |
| Development tools, tests, and preview servers    |
+--------------------------------------------------+
        |
        | outbound authenticated event/PTY stream
        v
AO Cloud → durable storage → connected clients
```

---

## Confirmed decisions checklist

- [x] Build from current Go architecture, not the stale Docker branch.
- [x] Daytona is the intended first AO-managed sandbox/VM provider.
- [x] Hide Daytona behind a provider-neutral Go interface.
- [x] Keep the local Go daemon for local sessions.
- [x] Add a separately deployable Go cloud application.
- [x] Support a complete customer-hosted deployment in the customer's AWS
      account.
- [x] Keep customer repositories, conversations, credentials, logs, and session
      state inside the customer deployment.
- [x] Ship separate control-plane and worker artifacts.
- [x] Use installation-time IAM roles rather than asking users for AWS
      credentials per session.
- [x] Do not expose the local unauthenticated daemon publicly.
- [x] Default to one active AO cloud session per isolated environment.
- [x] Give separate sessions separate VMs, even for the same repository.
- [x] Clone repositories inside the VM.
- [x] Use a dedicated branch for each session.
- [x] Do not require a Git worktree in the normal one-session-per-VM design.
- [x] Install a lightweight AO worker inside each VM.
- [x] Keep the Electron application and cloud control plane outside the VM.
- [x] Use an outbound authenticated worker connection.
- [x] Map AO session ID to provider and sandbox ID in PostgreSQL.
- [x] Store desired and observed lifecycle state separately.
- [x] Reconcile provider state rather than trusting one API response.
- [x] Let cloud sessions continue after the local application closes.
- [x] Support reconnection from another authorized device.
- [x] Replay missed events and then resume live streaming.
- [x] Stream raw terminal output and structured agent events.
- [x] Offer local or cloud execution during task creation.
- [x] Treat “Move to cloud” as logical session recreation/resume.
- [x] Keep permanent model and Git credentials outside VMs.
- [x] Allow automatic command execution inside the isolated VM.
- [x] Enforce strict controls on external side effects.
- [x] Track and limit CPU, memory, disk, runtime, concurrency, usage, and cost.
- [x] Build toward the complete production architecture rather than shipping an
      intentionally insecure shortcut.

---

## Not yet confirmed or requiring more discussion

The following items appear in
[`cloud-agent-plan.md`](cloud-agent-plan.md), follow naturally from the confirmed
architecture, or were mentioned without a final product decision.

## Priority 1: decisions needed before detailed implementation

### 1. Exact AO worker implementation

Options discussed:

- build an AO-native Go worker
- initially run OpenHands Agent Server inside Daytona
- use ideas or components from Background Agents
- use Sandbox Agent's normalized agent protocol

Current recommendation: build an AO-native worker so AO preserves all existing
agent adapters, while borrowing OpenHands' event model and Sandbox Agent's
protocol ideas.

This recommendation has not been explicitly confirmed.

### 2. Exact sandbox products and configuration

Still decide:

- exact Daytona product and VM class for AO-managed cloud
- exact AWS-native or customer-operated provider for self-hosted cloud
- Linux base image and snapshot format
- CPU/memory profiles
- regions
- VM image contents
- root user versus unprivileged worker user
- pause/resume behavior
- hot snapshot behavior
- volume attachment
- warm-pool size
- provider-side TTL

“Use isolated session environments behind a provider interface” is confirmed.
The exact provider and configuration for each deployment type are not.

### 3. Model authentication and billing model

Still decide:

- users bring Anthropic/OpenAI API keys
- AO owns provider accounts and bills users
- support both
- whether provider subscription OAuth is offered
- whether Anthropic/OpenAI approval is required
- model gateway API and credential rotation
- per-user model limits and markups

Permanent credentials staying outside VMs is confirmed. The commercial and OAuth
model is not.

### 4. Local-to-cloud migration of dirty work

Still decide how to transfer:

- committed and pushed branches
- uncommitted tracked changes
- untracked files
- ignored but required files
- local-only generated files
- running development processes
- agent-specific resume IDs
- conversation context
- local environment settings

Possible approaches:

- require commit/push before moving
- create a temporary private migration commit
- upload an encrypted patch and selected files
- create a Git bundle

The “Move to cloud” concept is confirmed; its exact migration contract is not.

### 5. Git proxy and GitHub App policy

Still decide:

- branch naming
- fork support
- pull-request creation permissions
- whether agents may update existing PR branches
- who may merge
- whether agents may create tags or releases
- commit signing
- GitHub App installation scope
- GitLab/Bitbucket support
- credential-proxy protocol

### 6. Deployment packaging and infrastructure

Still decide:

- whether AO-managed cloud ships before, after, or alongside self-hosted cloud
- supported AWS control-plane targets: ECS, EKS, or both
- self-hosted sandbox runtime: EC2, Kubernetes isolation, or another
  customer-approved provider
- exact RDS, S3, KMS, queue, and observability defaults
- supported AWS regions and private-network topologies
- ingress, certificates, DNS, and load balancer
- Terraform versus CloudFormation support
- signed image and schema migration rollout
- rollback, backup, restore, and break-glass operations
- license validation and offline-update policy
- whether a workflow engine is required

The separately deployable Go application and fully customer-owned data plane are
confirmed. The exact AWS installation profile and rollout policy are not.

---

## Priority 2: product and security decisions

### 7. Exact lifecycle state machine

The desired/observed model is confirmed. Final states and transitions are not.

Candidate states:

```text
requested
provisioning
bootstrapping
ready
running
waiting_input
paused
stopping
deleting
deleted
failed
```

Need to define:

- allowed transitions
- retry behavior
- terminal states
- timeout handling
- user-visible versus internal states
- how agent activity and VM lifecycle combine

### 8. Pause, resume, retention, and deletion policy

Still decide:

- idle duration before pause
- maximum session lifetime
- when a session is snapshotted
- when a VM is deleted
- how long snapshots remain
- what “archive” means to the user
- whether completed sessions keep resumable files
- user-controlled “keep alive” behavior

### 9. Snapshot and environment model

Still decide:

- global base snapshots
- project-specific snapshots
- user-specific environment snapshots
- Dockerfile or declarative environment configuration
- snapshot versioning
- invalidation when dependencies change
- whether credentials may ever be present during snapshot creation

Credentials should not be stored in snapshots, but the full environment model
is unconfirmed.

### 10. Network egress policy

Still decide default access for:

- package registries
- arbitrary documentation sites
- user APIs
- MCP servers
- private company services
- databases
- model providers
- Git providers

Also decide:

- default-deny versus broad internet for personal users
- domain versus CIDR rules
- private connectivity
- per-project policies
- egress audit logs

### 11. Secret broker design

Still decide:

- KMS and secret-store technology
- per-session grant format
- secret injection versus request proxying
- rotation intervals
- revocation
- log redaction rules
- user-managed project secrets
- organization-managed secrets
- secrets allowed in shell subprocesses

### 12. Terminal authorization and protocol

Still decide:

- raw WebSocket versus another transport
- terminal ticket format
- ticket expiry
- reconnect behavior
- bandwidth limits
- command audit level
- collaborative terminals
- terminal recording and retention

The terminal must be authenticated and replayable where practical, but the
wire protocol is unconfirmed.

### 13. Preview system

Still decide:

- preview hostname format
- authenticated/private versus optional public previews
- preview expiration
- WebSocket support
- multiple ports
- custom domains
- mobile access
- browser automation
- rate limits and abuse controls

### 14. Organizations, users, and RBAC

Still decide:

- personal accounts versus organizations
- owner/admin/member roles
- repository-level roles
- session sharing
- team visibility
- SSO
- SCIM
- enterprise policy controls
- organization spending limits

### 15. Usage, billing, and quotas

Still decide:

- compute billing unit
- model-token billing
- storage billing
- included quotas
- per-user and per-organization concurrency
- spending alerts
- hard versus soft limits
- handling provider cost after failed deletion
- refunds or credits for infrastructure failures

---

## Priority 3: reliability and operational decisions

### 16. Event and log schema

Still decide:

- canonical event types
- sequence allocation
- ordering across reconnects
- deduplication
- event retention
- log chunking
- PostgreSQL versus object-storage split
- transcript format
- compatibility across Claude, Codex, Cursor, and other agents

OpenHands' append-only event model is a reference, not yet an approved direct
dependency.

### 17. Reconciliation frequency and provider operations

Still decide:

- polling frequency
- use of provider lifecycle WebSocket events where available
- fallback polling
- idempotency-key format
- orphan discovery interval
- retry backoff
- operator override
- handling prolonged provider outages

### 18. Multi-repository sessions

The architecture permits multiple related repositories in one VM, but product
behavior still needs confirmation:

- selection UX
- branch mapping per repository
- multiple pull requests
- repository-specific permissions
- dependency ordering
- shared environment configuration

### 19. Multiple workers in one VM

Default separate VMs are confirmed.

Still decide whether an advanced mode will ever allow:

- several coordinated agents in one VM
- shared repository cache plus Git worktrees
- orchestrator and workers in one VM
- explicit resource partitioning between agents

This should not be part of the default architecture without a separate design.

### 20. Cloud-to-local movement

Only local-to-cloud was discussed.

Still decide whether users can:

- move an active cloud session back to local
- check out its branch locally
- transfer conversation and resume identity
- download uncommitted files
- continue the same terminal session

### 21. Backup and disaster recovery

Still decide:

- PostgreSQL backup schedule
- object-storage durability
- restore testing
- regional recovery
- control-plane recovery time target
- acceptable event loss
- provider outage runbooks
- handling lost provider snapshots

### 22. Observability and service levels

Still decide:

- metrics and tracing stack
- alert thresholds
- startup latency target
- event-delivery latency target
- session availability target
- deletion confirmation target
- operator dashboards
- customer-visible status

### 23. Security and compliance target

Still decide:

- threat-model owner
- external penetration-test timing
- worker-image signing mechanism
- SBOM and image scanning
- incident response
- audit-log retention
- privacy policy
- data residency
- SOC 2 or other compliance goals

### 24. Public API and automation

Still decide whether AO Cloud exposes:

- public REST API
- webhooks
- CLI cloud commands
- GitHub issue/PR triggers
- Slack or Linear triggers
- scheduled agents
- API tokens and service accounts

### 25. Device clients

Cloud architecture supports multiple devices, but still decide:

- Electron-only initial UI
- browser dashboard
- mobile application
- push notifications
- device-session management
- offline caching

---

## Questions for the next architecture discussion

The highest-value next questions are:

1. Are we definitely building an AO-native Go worker, or using OpenHands/Sandbox
   Agent as the first worker?
2. Which Daytona profile serves AO-managed cloud, and which AWS sandbox runtime
   serves customer-hosted cloud?
3. Is model access BYOK, AO-billed, or both?
4. What exactly happens to uncommitted files during “Move to cloud”?
5. What Git operations may an agent perform without approval?
6. Which ECS/EKS, RDS, S3, KMS, networking, installer, and update profile will
   AO support in customer AWS?
7. What is the exact cloud-session lifecycle state machine?
8. What are the default network egress rules?
9. How long are completed sessions, logs, and snapshots retained?
10. What organizations, RBAC, quotas, and billing model are required at launch?

Once these questions are answered, this document can become a concrete
implementation specification and ADR set.

---

## Research sources

### Factory Droid

- [Droid Computers](https://docs.factory.ai/cli/features/droid-computers)
- [Bring Your Own Machine](https://docs.factory.ai/cli/features/droid-computers-byom)
- [Network and deployment configuration](https://docs.factory.ai/enterprise/network-and-deployment)
- [Data flows and privacy](https://docs.factory.ai/enterprise/privacy-and-data-flows)
- [Droid Exec](https://docs.factory.ai/cli/droid-exec/overview)
- [Factory sandbox](https://docs.factory.ai/cli/configuration/sandbox)

### Conductor

- [Conductor Cloud](https://www.conductor.build/docs/cloud-beta)
- [Cloud snapshots](https://www.conductor.build/docs/cloud-beta/snapshots)
- [Working with cloud workspaces](https://www.conductor.build/docs/cloud-beta/working-with-cloud-workspaces)
- [Cloud environment variables](https://www.conductor.build/docs/cloud-beta/environment-variables)
- [Cloud beta limitations](https://www.conductor.build/docs/cloud-beta/limitations)
- [Git worktrees](https://www.conductor.build/docs/concepts/git-worktrees)
- [Project scripts](https://www.conductor.build/docs/reference/scripts)

### Orca

- [stablyai/orca](https://github.com/stablyai/orca)
- [Ways to run Orca](https://www.onorca.dev/docs/ways-to-run)
- Source snapshot:
  `4543bb68263a89ab520cea62ca69d7ac78330dd3`
- Relevant source and repository docs:
  - `src/shared/ephemeral-vm-runtimes.ts`
  - `src/shared/ephemeral-vm-recipes.ts`
  - `src/shared/ephemeral-vm-recipe-runner.ts`
  - `src/shared/ephemeral-vm-recipe-lifecycle-payload.ts`
  - `docs/reference/headless-linux-server.md`
  - `docs/reference/remote-agent-session-host-authority.md`

### T3 Code

- [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- Source snapshot:
  `49c0d96edf280f1fe6750a83161a3a2cff0f25ef`
- Relevant source and repository docs:
  - `docs/architecture/overview.md`
  - `docs/architecture/remote.md`
  - `docs/cloud/environment-auth.md`
  - `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
  - `apps/server/src/ws.ts`
  - `apps/server/src/auth/dpop.ts`
  - `infra/relay/src/environments/ManagedEndpointProvider.ts`

### Superset

- [superset-sh/superset](https://github.com/superset-sh/superset)
- [Remote workspaces](https://docs.superset.sh/remote-workspaces)
- [Host server](https://docs.superset.sh/cli/host-server)
- [CLI reference](https://docs.superset.sh/cli/cli-reference)
- Source snapshot:
  `dae2d98f131c0cb2d45472628b826a6f46b355b3`
- Relevant source and repository docs:
  - `apps/desktop/docs/HOST_SERVICE_ARCHITECTURE.md`
  - `packages/host-service/src/tunnel/connect.ts`
  - `packages/host-service/src/tunnel/tunnel-client.ts`
  - `packages/pty-daemon/README.md`
  - `LICENSE.md`

### Earlier cloud-agent research

- [Cursor Cloud Agents overview](https://cursor.com/docs/cloud-agent)
- [Cursor Cloud Agent setup](https://cursor.com/docs/cloud-agent/setup)
- [Cursor Cloud Agent security](https://cursor.com/docs/cloud-agent/security)
- [Cursor Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities)
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code web quickstart](https://code.claude.com/docs/en/web-quickstart)
- [Anthropic: Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
