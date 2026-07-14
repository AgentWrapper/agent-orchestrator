# Cloud Plan V1: Azure Coordinator With Portable Runners

## Objective

Build a rudimentary hybrid version of Agent Orchestrator where:

- The AO coordinator runs continuously in Azure and stores durable state in SQLite.
- A coding session can run on a Windows, macOS, or Linux laptop runner.
- A coding session can run on a separate Azure runner VM.
- An idle Codex session can move from a laptop runner to the Azure runner while preserving its Git state and native Codex conversation.
- The Electron desktop remains the main control surface.

Phase 1 prioritizes proving the complete workflow. It deliberately defers PostgreSQL, dynamic VM creation, multi-user application authentication, and migration support for agent harnesses other than Codex.

## System Shape

### Azure coordinator

The coordinator owns business logic and durable state. It:

- Runs the AO daemon continuously.
- Stores projects, sessions, runner assignments, migration state, and CDC events in SQLite.
- Accepts REST, SSE, terminal WebSocket, hook, and runner-control traffic through Tailscale.
- Does not run Codex, create worktrees, or manage agent terminals.

### Laptop runner

The laptop runner executes sessions locally. It:

- Supports Windows, macOS, and Linux.
- Creates AO-managed clones and worktrees below `~/.ao`.
- Runs Codex through ConPTY on Windows or tmux on macOS/Linux.
- Connects outward to the Azure coordinator.
- Exports Git and Codex state when a session moves to Azure.

### Azure runner

The Azure runner is a separate Ubuntu VM. It:

- Runs the same `aorunner` protocol as laptop runners.
- Creates its own AO-managed repository clones and worktrees.
- Runs Codex inside tmux.
- Imports a migrated session and resumes the original Codex conversation.

Phase 1 uses one permanent Azure runner. The coordinator does not create or delete VMs dynamically.

### Electron desktop

Electron connects to the hosted coordinator. It:

- Does not launch a local daemon while remote-coordinator mode is enabled.
- Shows available laptop and Azure runners.
- Lets the user select a runner when creating a task.
- Shows the runner currently executing each session.
- Provides a **Move to cloud** action and migration progress.

## Azure Infrastructure

Create reproducible Bicep and cloud-init configuration under `cloud-agents/azure/`.

### Network

- Create one resource group, virtual network, and subnet.
- Install Tailscale on the coordinator, Azure runner, and operator devices.
- Keep the AO daemon bound to `127.0.0.1`.
- Publish the coordinator through Tailscale HTTPS.
- Do not expose the AO API port through an Azure Network Security Group.
- Allow SSH to the coordinator only from an operator-supplied public `/32` address.
- Give the Azure runner no public inbound endpoint.

### Coordinator VM

- Ubuntu 24.04 LTS.
- Initial size: `Standard_B2s`.
- 128 GiB Premium SSD managed data disk.
- Mount the data disk at the `ao` service account's `~/.ao` directory.
- Run AO as a systemd service.
- Back up the data disk daily using Azure Disk Backup or Azure VM Backup.

### Azure runner VM

- Ubuntu 24.04 LTS.
- Initial size: `Standard_D4s_v5` with 4 vCPUs and 16 GiB memory.
- 256 GiB Premium SSD managed data disk.
- Mount the data disk at the runner service account's `~/.ao` directory.
- Install Git, tmux, Codex, the AO CLI, and `aorunner`.
- Run `aorunner` as a systemd service.

### Managed-disk decision

An Azure managed disk is a persistent virtual hard drive attached to a VM. It is not a Docker image.

The coordinator disk protects:

- `~/.ao/data/ao.db`
- Temporary migration bundles
- Coordinator logs and operational state

The runner disk protects:

- Repository clones and worktrees
- Codex native session files
- Build caches and runner state

Replacing a VM must not require replacing its AO data disk.

### Docker decision

Do not run `aorunner` in Docker during Phase 1. Native execution is simpler for PTYs, tmux, ConPTY, Git worktrees, authentication, project containers, and preview ports.

Run the coordinator as a native systemd service initially as well. A coordinator Docker image may be added later, but its `~/.ao` directory must still be mounted from the managed data disk.

Use cloud-init and installation scripts for reproducible setup instead of Docker images in Phase 1.

## Implementation Sequence

### 1. Validate Codex conversation portability

This experiment is a hard gate before implementing migration:

1. Start a Codex conversation on a laptop.
2. Record its native Codex session ID.
3. Locate the matching `~/.codex/sessions/.../rollout-*.jsonl` file.
4. Install the identical Codex version on Ubuntu.
5. Clone the same repository on Ubuntu.
6. Copy the rollout file to the corresponding Codex sessions directory on Ubuntu.
7. Run `codex resume <original-session-id>` from the Ubuntu clone.
8. Confirm that previous conversation turns and tool history are present.
9. Send a new prompt and confirm that it continues the original conversation.

If this experiment fails, stop migration implementation and revise the requirement. Do not silently replace exact continuation with a new conversation and summary.

### 2. Add remote-coordinator mode

Introduce:

```text
AO_COORDINATOR_URL=https://ao-coordinator.<tailnet>.ts.net
```

When configured:

- Electron does not launch, identify, supervise, or stop a local daemon.
- REST, SSE, notification streams, and terminal WebSockets use the configured base URL.
- HTTPS automatically maps to WSS for terminal connections.
- The CLI bypasses local `running.json` and local PID validation.
- Electron persists the configured URL below `~/.ao/electron`.
- The desktop displays coordinator connectivity errors without falling back to a new local daemon.

Keep CORS restricted to the packaged `app://renderer` origin and explicitly configured development origins. Never add a wildcard origin.

### 3. Build the runner

Add `backend/cmd/aorunner` and build it for:

- Windows amd64
- macOS amd64 and arm64
- Linux amd64 and arm64

Each runner maintains one persistent WebSocket to the coordinator and reports:

- Stable runner ID and name
- Runner kind: `laptop` or `azure`
- Operating system and architecture
- Git version
- Codex version
- tmux or ConPTY availability
- Codex and GitHub authentication readiness
- Active runtime handles
- A heartbeat every 30 seconds

The coordinator derives a runner as offline after three missed heartbeats. A new connection with the same runner ID supersedes the old connection.

Use a shared enrollment token for runner registration in Phase 1. Store it in protected local service configuration and never commit it.

### 4. Install laptop runners as background services

Provide `ao runner install` and `ao runner uninstall`.

- Windows: install a per-user hidden Task Scheduler entry.
- macOS: install a per-user LaunchAgent.
- Linux: install a systemd user service.
- Store runner configuration and state under `~/.ao`.
- Reconnect automatically after login, network interruption, or coordinator restart.

### 5. Move execution responsibilities onto runners

The selected runner, not the coordinator, must perform:

- Repository clone and fetch
- Worktree creation, preservation, restoration, and removal
- Agent binary discovery
- Agent authentication checks
- Codex launch and resume command construction
- tmux or ConPTY runtime management
- Terminal attach, input, resize, and output
- Git-state export and import
- Codex-state export and import

Add runner identity to runtime and workspace handles. Do not encode runner identity into an absolute path.

Every runner-originated hook or status event must carry:

- AO session ID
- Runner ID
- Execution generation

The coordinator rejects events from an old execution generation after a session moves.

### 6. Register hosted projects by Git URL

The Azure coordinator cannot use a laptop filesystem path.

In hosted mode:

- Add a project using its canonical GitHub repository URL.
- Persist that URL in the existing repository-origin field.
- Each runner creates its own managed clone below `~/.ao`.
- Do not modify the user's normal repository checkout.
- Configure GitHub and Codex authentication independently on every runner.

Phase 1 supports one GitHub repository per AO project. Reject composed or multi-repository projects with a typed validation error.

### 7. Extend SQLite

Add new migrations rather than modifying existing migrations.

Add a `runners` table containing:

- Runner ID and display name
- Runner kind
- OS and architecture
- Capability facts
- Creation time
- Last heartbeat time

Add to sessions:

- Nullable `runner_id`
- `execution_generation`, initially `1` for hosted sessions

Add a `session_moves` table containing:

- Move ID and session ID
- Source and target runner IDs
- Source and target generations
- Current migration phase
- Bundle checksum
- Typed error code and message
- Creation, update, and completion timestamps

Existing sessions with no runner ID remain legacy-local and cannot be moved until recreated as hosted sessions.

Emit runner and move changes through SQLite triggers into the existing `change_log`. Do not emit duplicate manual CDC events.

### 8. Add client and runner APIs

Add client-facing endpoints:

```text
GET  /api/v1/runners
POST /api/v1/sessions
POST /api/v1/sessions/{sessionId}/moves
GET  /api/v1/session-moves/{moveId}
```

Hosted session creation accepts `runnerId`.

Session responses add:

```json
{
  "execution": {
    "runnerId": "azure-1",
    "runnerName": "Azure Runner",
    "runnerKind": "azure",
    "generation": 2,
    "move": null
  }
}
```

Add an internal runner endpoint:

```text
/runner/v1/connect
```

The runner WebSocket multiplexes versioned RPC messages, terminal bytes, heartbeats, and correlated responses.

After changing API source types, regenerate sqlc, OpenAPI, and frontend TypeScript types using the repository's documented commands.

### 9. Implement local-to-Azure migration

A session can move only when:

- The session uses Codex.
- The session is idle or waiting for input.
- The source and target runners are online.
- Both runners use the same Codex version.
- GitHub and Codex authentication are ready on the target.

The move sequence is:

1. Create a durable `session_moves` record.
2. Mark the session as moving.
3. Reject new messages with HTTP `409 SESSION_MOVING`.
4. Gracefully stop Codex on the source runner so its native session file is flushed.
5. Abort rather than force-kill if Codex cannot stop within the allowed timeout.
6. Capture commits, tracked edits, and non-ignored untracked files using AO's preserved-ref semantics.
7. Export the Git objects and preserved ref as a streamed Git bundle.
8. Export only the rollout JSONL matching the native Codex session ID.
9. Build a manifest with relative destinations, Codex version, file sizes, and SHA-256 checksums.
10. Stream the migration bundle through the coordinator to `~/.ao/transfers/<move-id>`.
11. Verify all checksums before importing.
12. Create the target clone and worktree.
13. Import the Git bundle and apply the preserved ref.
14. Install the Codex rollout file into the target runner's OS-specific Codex sessions directory.
15. Start `codex resume <same-session-id>` on the target.
16. Confirm that the target reports the original native Codex session ID.
17. Atomically update the session's runner, workspace handle, runtime handle, and execution generation.
18. Reconnect the Electron terminal to the new runtime.
19. Remove the source worktree only after target confirmation.
20. Delete the successful transfer bundle.

Do not transfer:

- Codex authentication files
- GitHub tokens
- `.env` files or other ignored files
- Codex configuration
- Dependency directories
- Build caches
- Unrelated Codex sessions

### 10. Roll back failed moves

If target import or Codex resume fails before cutover:

- Restart the original session on the source runner using its preserved state.
- Keep the target inactive.
- Mark the move as rolled back.
- Surface the typed error in Electron.

If rollback also fails:

- Keep both workspaces and transfer bundles.
- Do not force-delete either copy.
- Mark the move as requiring manual recovery.

Reap failed transfer bundles after 24 hours. Never delete a bundle still referenced by an unresolved move.

### 11. Add Electron controls

Add to the new-task dialog:

- A runner selector.
- The current laptop as the default when online.
- The Azure runner as the fallback.
- Disabled runners with a concise readiness reason.

Add to the session view:

- Current runner name and kind.
- Runner connectivity.
- A **Move to cloud** action for eligible Codex sessions.
- Migration phases: preparing, exporting, transferring, importing, starting, completed, rolled back, or manual recovery required.
- Disabled reasons for busy sessions, offline runners, authentication failures, and Codex-version mismatches.

After successful cutover, keep the current session page open and reconnect its terminal automatically.

## Authentication Boundaries

Phase 1 does not implement AO accounts, OIDC, RBAC, or multi-user sessions.

Use:

- Tailscale identity as the operator network perimeter.
- A shared protected enrollment token for runners.
- Independent Codex authentication on every runner.
- Independent GitHub authentication on every runner.

Do not transfer model-provider or GitHub credentials during session migration.

## Testing

### Backend and protocol tests

- Runner registration and reconnect
- Request correlation and cancellation
- Heartbeat expiry and derived connectivity
- Newest connection wins
- Runtime and workspace routing by runner
- Execution-generation fencing
- Git and Codex bundle checksums
- Archive path-traversal rejection
- Target failure and source rollback
- Rollback failure retention
- Coordinator restart during each migration phase
- SQLite migrations and CDC triggers
- API validation and error envelopes

### Frontend tests

- Remote coordinator configuration
- No local-daemon launch in remote mode
- Runner selection and readiness states
- Move eligibility and confirmation
- Migration progress and errors
- Terminal reconnection after cutover
- Rollback and manual-recovery presentation

### Cross-platform tests

- Build and test `aorunner` on Windows, macOS, and Linux CI runners.
- Verify background installation on every supported OS.
- Run a release smoke test from each laptop OS to the Ubuntu Azure runner.

### End-to-end acceptance scenario

For Windows, macOS, and Linux:

1. Connect Electron to the Azure coordinator.
2. Confirm the laptop and Azure runners are listed.
3. Start a Codex session on the laptop.
4. Exchange at least two conversation turns.
5. Create committed changes, tracked uncommitted changes, and a non-ignored untracked file.
6. Move the idle session to Azure.
7. Confirm the native Codex session ID is unchanged.
8. Confirm previous conversation turns are available.
9. Confirm all expected Git state exists on Azure.
10. Stop the laptop runner.
11. Continue the Codex conversation on Azure.
12. Restart Electron and confirm the coordinator still shows the current session and terminal.
13. Repeat with an injected target failure and verify automatic source rollback.

Run the repository's backend race tests, lint, frontend typecheck, frontend build, sqlc drift check, and API drift check before completion.

## Phase 1 Completion Criteria

Phase 1 is complete when:

- The Azure coordinator survives laptop shutdown and retains SQLite state.
- Windows, macOS, and Linux laptop runners can execute Codex sessions.
- The Azure runner can execute new Codex sessions.
- Electron can select runners and operate remote terminals.
- An idle Codex session can move from every supported laptop OS to Azure.
- The exact Codex conversation and supported Git state survive the move.
- Stale source-runner events cannot modify the migrated session.
- A failed move restores the source session without deleting recoverable data.

## Explicitly Deferred

- PostgreSQL and `LISTEN`/`NOTIFY`
- Dynamic Azure VM creation and destruction
- Automatic runner scaling or idle shutdown
- AO login, OIDC, MFA, RBAC, and multi-tenancy
- Public coordinator access
- Offline runner event buffering and replay
- Normalized transcript storage in the coordinator
- Migration support for Claude Code, Crush, or other harnesses
- Multi-repository workspace migration
- Docker-based runners
