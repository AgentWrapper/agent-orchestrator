# Architecture

Agent Orchestrator is a long-running Go daemon that orchestrates parallel AI coding agents, each in an isolated `git worktree`, with automatic feedback routing from CI failures, review comments, and merge conflicts.

## Core Mental Model

```
OBSERVE external facts → UPDATE durable facts → DERIVE display status / ACT
```

The system stores only immutable facts (`activity_state`, `is_terminated`, PR facts) in SQLite. Display status is computed at read time — never stored.

The durable session facts are:

- **`activity_state`** — what the agent last reported or what the runtime observer can safely conclude (`active`, `idle`, `waiting_input`, `exited`)
- **`is_terminated`** — whether the session should be treated as over
- **PR facts** — in the `pr`, `pr_checks`, and `pr_comment` tables

The UI status is not stored. `service.Session` computes it from the session record plus PR facts while assembling controller-facing read models.

## Architecture Overview

```mermaid
graph TB
    subgraph Frontend["Frontend Layer"]
        EMain["Electron Main Process"]
        React["React 19 UI (renderer)"]
        TanStack["TanStack Router/Query + shadcn/ui"]

        EMain --> HTTP["HTTP (REST + SSE + WebSocket)"]
        React --> HTTP
        TanStack --> HTTP
    end

    subgraph Backend["Backend Go Daemon"]
        HTTP2["HTTP Layer (Controllers)"]
        CLI["CLI Layer (Cobra cmd)"]
        Service["Service Layer<br/>(Project/Session/PR)"]
        SessionMgr["Session Manager<br/>(spawn/kill/restore/cleanup)"]
        RuntimeSelect["Runtime Selector<br/>(Platform-based)"]
        Tmux["tmux<br/>(Darwin/Linux)"]
        Conpty["conpty<br/>(Windows)"]
        Lifecycle["Lifecycle Manager<br/>(Reduces observations → facts)"]
        SCM["SCM Observer<br/>(GitHub)"]
        Reaper["Reaper<br/>(Runtime liveness)"]
        Storage["Storage + CDC<br/>(SQLite with triggers)"]

        CLI --> Service
        HTTP2 --> Service
        Service --> SessionMgr
        SessionMgr --> RuntimeSelect

        RuntimeSelect -->|Darwin/Linux| Tmux
        RuntimeSelect -->|Windows| Conpty

        SessionMgr --> Lifecycle
        Tmux --> Lifecycle
        Conpty --> Lifecycle

        Lifecycle --> Storage
        SCM --> Lifecycle
        Reaper --> Lifecycle
    end

    HTTP -->|"Loopback Only<br/>(127.0.0.1)"| HTTP2
```

## Runtime Architecture

### Platform-Specific Runtime Selection

The system uses a dual-runtime architecture optimized for each platform:

```mermaid
graph LR
    AO["Agent Orchestrator"] --> RuntimeCheck{"Platform Check"}
    RuntimeCheck -->|Darwin/Linux| TmuxRuntime["tmux Runtime"]
    RuntimeCheck -->|Windows| ConptyRuntime["conpty Runtime"]

    TmuxRuntime --> TmuxFeatures["• tmux sessions<br/>• Direct CLI interaction<br/>• Unix PTY integration"]
    ConptyRuntime --> ConptyFeatures["• Pty-host server<br/>• B1 binary protocol<br/>• Loopback TCP communication"]

    TmuxFeatures --> Common["Common Interface:<br/>ports.Runtime + ports.Attacher"]
    ConptyFeatures --> Common

    Common --> Session["Session Management<br/>& Terminal Streaming"]
```

### Runtime Interface

Both tmux and conpty implement the same core interface:

```go
type Runtime interface {
    ports.Runtime      // Create, Destroy, IsAlive
    ports.Attacher     // Attach for terminal streaming
    SendMessage()       // Send input to session
    GetOutput()        // Get scrollback output
}
```

### tmux Runtime (Darwin/Linux)

```mermaid
sequenceDiagram
    participant AO
    participant Tmux
    participant Shell
    participant Agent

    AO->>Tmux: tmux new-session -d -s <session-id>
    Tmux->>Shell: Launch shell with agent command
    Shell->>Agent: Execute agent
    Agent->>Shell: Agent output
    Shell->>Tmux: Terminal data
    AO->>Tmux: tmux attach-session -t <session-id>
    Tmux-->>AO: Terminal stream
```

**Key Features:**

- Creates detached tmux sessions with hidden status bar
- Direct tmux CLI interaction for session management
- `tmux send-keys` for input delivery
- `tmux capture-pane` for scrollback retrieval
- Sessions survive daemon restart (tmux persistence)

### conpty Runtime (Windows)

```mermaid
sequenceDiagram
    participant AO
    participant Host
    participant Conpty
    participant Agent

    AO->>Host: Spawn detached pty-host process
    Host->>Host: Create ConPTY
    Host->>Host: Listen on loopback TCP
    Host-->>AO: READY signal
    AO->>Host: Store session (addr + PID)
    Host->>Agent: Execute agent in ConPTY
    Agent->>Host: Terminal output
    Host->>Host: Store in ring buffer

    Note over AO,Host: Attach Phase
    AO->>Host: Dial loopback TCP
    Host-->>AO: Scrollback replay (MsgTerminalData)
    Host->>AO: Live terminal stream
```

**Key Features:**

- Detached pty-host process with ConPTY
- Custom B1 binary protocol over loopback TCP
- Ring buffer for scrollback storage
- File-based registry for crash recovery
- Graceful shutdown with cleanup

## Package Layout

```
backend/internal/domain           shared vocabulary and API status value types
backend/internal/ports            inbound/outbound interfaces
backend/internal/service/{project,session,pr,review}
                                  controller-facing services and read-model assembly
backend/internal/session_manager  internal session command manager
backend/internal/lifecycle        runtime/activity/spawn/termination session fact reducer
backend/internal/observe/scm      SCM (GitHub) observer loop feeding PR facts
backend/internal/observe/reaper   runtime liveness observation loop
backend/internal/storage          SQLite persistence and DB-triggered CDC
backend/internal/cdc              change-log poller and broadcaster
backend/internal/httpd            daemon HTTP surface (REST + SSE + terminal mux)
backend/internal/terminal         WebSocket terminal multiplexer
backend/internal/adapters         agent/tmux+conpty runtime/git-worktree/GitHub SCM + tracker adapters
backend/internal/daemon           production wiring and shutdown
backend/internal/config           daemon env/default config
```

## Adapter Layer

Swappable implementations for each port:

| Port          | Darwin/Linux                     | Windows                          | Purpose                                     |
| ------------- | -------------------------------- | -------------------------------- | ------------------------------------------- |
| **Runtime**   | tmux                             | conpty                           | Terminal multiplexing and session isolation |
| **Workspace** | git worktree                     | git worktree                     | Isolated working directories                |
| **Agent**     | claude-code, codex, etc.         | claude-code, codex, etc.         | AI coding agent execution                   |
| **SCM**       | GitHub                           | GitHub                           | Pull request observation                    |
| **Tracker**   | GitHub                           | GitHub                           | Issue tracking                              |
| **Reviewer**  | claude-code                      | claude-code                      | Code review execution                       |
| **Notifier**  | desktop, slack, discord, webhook | desktop, slack, discord, webhook | Notification delivery                       |

## Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Creating: POST /api/v1/sessions

    Creating --> WorkspaceCreated: Create git worktree
    WorkspaceCreated --> RuntimeCreated: Create tmux/conpty session
    RuntimeCreated --> Launching: Execute agent command
    Launching --> Spawned: Agent running

    Spawned --> Active: Agent reports activity
    Spawned --> Idle: Agent waiting
    Spawned --> WaitingInput: Agent needs input
    Spawned --> Terminated: Agent exits

    Active --> Idle: Agent finishes task
    Active --> WaitingInput: Agent needs input
    Active --> Terminated: Agent exits

    Idle --> Active: Agent starts new task
    Idle --> WaitingInput: Agent needs input
    Idle --> Terminated: Agent exits

    WaitingInput --> Active: User provides input
    WaitingInput --> Terminated: Session killed

    Terminated --> [*]: Session cleaned up
```

## Data Flow: Spawn Session

```mermaid
sequenceDiagram
    participant User
    participant CLI
    participant HTTP
    participant Service
    participant SessionMgr
    participant Workspace
    participant Runtime
    participant Agent
    participant Lifecycle
    participant SQLite
    participant CDC
    participant Frontend

    User->>CLI: ao spawn --project my-repo
    CLI->>HTTP: POST /api/v1/sessions
    HTTP->>Service: service.Session.Spawn()
    Service->>SessionMgr: session_manager.Spawn()

    SessionMgr->>SQLite: Create session row (seed state)
    SessionMgr->>Workspace: Workspace.Create()
    Workspace-->>SessionMgr: git worktree created
    SessionMgr->>Runtime: Runtime.Create()

    alt Darwin/Linux
        Runtime->>Runtime: tmux new-session -d -s <id>
    else Windows
        Runtime->>Runtime: Spawn pty-host + ConPTY
    end

    Runtime-->>SessionMgr: Session handle
    SessionMgr->>Agent: Get launch command
    Agent-->>SessionMgr: Command
    Runtime->>Agent: Execute in tmux/ConPTY
    Agent->>Lifecycle: Report spawn complete

    Lifecycle->>SQLite: Update session (spawned state)
    SQLite->>CDC: Trigger change_log
    CDC->>Frontend: SSE session_created event
    Frontend->>User: UI update
```

## Data Flow: Terminal Streaming

```mermaid
sequenceDiagram
    participant Frontend
    participant HTTP
    participant TerminalMgr
    participant Runtime

    Frontend->>HTTP: WebSocket upgrade /api/v1/sessions/{id}/terminal
    HTTP->>TerminalMgr: Create terminal session
    TerminalMgr->>Runtime: Runtime.Attach(handle, rows, cols)

    alt tmux (Darwin/Linux)
        Runtime->>Runtime: tmux attach-session -t <id>
        Runtime-->>TerminalMgr: PTY stream
    else conpty (Windows)
        Runtime->>Runtime: Dial loopback TCP
        Runtime->>Runtime: B1 protocol handshake
        Runtime->>Runtime: MsgTerminalData (scrollback)
        Runtime-->>TerminalMgr: TCP stream
    end

    TerminalMgr-->>Frontend: WebSocket terminal stream

    Note over Frontend,Runtime: Bidirectional terminal I/O
```

## Status Derivation

`service.Session` selects the display PR from all PR snapshots for a session, then applies this precedence:

```mermaid
graph TD
    Start["Session Status Check"] --> Check1{"is_terminated?"}
    Check1 -->|Yes| Merged{"Merged PR?"}
    Check1 -->|No| Check2{"activity_state = waiting_input?"}

    Merged -->|Yes| Status1["Status: merged"]
    Merged -->|No| Status2["Status: terminated"]

    Check2 -->|Yes| Status3["Status: needs_input"]
    Check2 -->|No| Check3{"Open PR Facts?"}

    Check3 -->|Yes| PRStatus["PR Pipeline Status:<br/>ci_failed, draft, changes_requested,<br/>mergeable, approved, review_pending, pr_open"]
    Check3 -->|No| Check4{"activity_state = active?"}

    Check4 -->|Yes| Status4["Status: working"]
    Check4 -->|No| Check5{"Signal capable + <90s grace?"}

    Check5 -->|Yes| Status5["Status: no_signal"]
    Check5 -->|No| Status6["Status: idle"]

    PRStatus --> Final["Display Status"]
    Status1 --> Final
    Status2 --> Final
    Status3 --> Final
    Status4 --> Final
    Status5 --> Final
    Status6 --> Final
```

## Core Components

### Lifecycle Manager

`lifecycle.Manager` is the write path for session lifecycle facts:

- Runtime observations can mark a session terminated only when runtime and process are both clearly dead
- Activity signals update `activity_state`; `exited` also marks the session terminated
- PR observations trigger agent nudges for CI failures, review feedback, and merge conflicts

### Session Manager

`session_manager.Manager` performs internal session mutations:

| Operation   | Description                                                                            |
| ----------- | -------------------------------------------------------------------------------------- |
| **Spawn**   | Create row → create workspace → create runtime → execute agent → report spawned        |
| **Kill**    | Mark terminated → destroy runtime → destroy workspace                                  |
| **Restore** | Check terminated → restore workspace → create runtime → execute agent → report spawned |
| **Cleanup** | Reclaim terminated session workspaces                                                  |

### PR Manager

`pr.Manager` records SCM observations into the PR/check/comment tables:

- Persists PR state, CI results, review comments
- Forwards observations to lifecycle for agent nudges
- Merged PR marks owning session terminated

### Reaper

`observe/reaper` polls runtime liveness:

- Checks if tmux sessions still exist
- Checks if pty-host processes are alive
- Marks dead sessions terminated
- Cleans up leaked resources

## Persistence and CDC

SQLite is the durable store with CDC triggers:

```mermaid
graph LR
    SQLite["SQLite Database"]
    Trigger["DB Triggers"]
    ChangeLog["change_log table"]
    Poller["CDC Poller"]
    SSE["SSE Broadcaster"]
    Frontend["Frontend Clients"]

    SQLite -->|"INSERT/UPDATE"| Trigger
    Trigger -->|"append row"| ChangeLog
    ChangeLog -->|"tail (100ms)"| Poller
    Poller -->|"publish events"| SSE
    SSE -->|"SSE stream"| Frontend
```

**Tables:**

- `projects` — Registered repos with soft-delete
- `sessions` — Session facts (activity_state, is_terminated, runtime metadata)
- `pr` — PR facts (state, ci_state, review_decision, mergeability)
- `pr_checks` — CI run history
- `pr_comment` — Review comments
- `change_log` — CDC event log
- `notifications` — Dashboard notifications
- `review_runs` — Code review execution records
- `telemetry_events` — Telemetry storage

## Supported Agents (23+)

claude-code, codex, aider, cursor, opencode, cline, copilot, grok, droid, amp, agy, crush, qwen, goose, auggie, continue, devin, kimi, kiro, kilocode, vibe, pi, autohand

## Configuration

All configuration via environment variables:

| Variable              | Default              | Purpose               |
| --------------------- | -------------------- | --------------------- |
| `AO_PORT`             | `3001`               | HTTP bind port        |
| `AO_REQUEST_TIMEOUT`  | `60s`                | Per-request timeout   |
| `AO_SHUTDOWN_TIMEOUT` | `10s`                | Graceful shutdown cap |
| `AO_RUN_FILE`         | `~/.ao/running.json` | PID/port handshake    |
| `AO_DATA_DIR`         | `~/.ao/data`         | SQLite data directory |
| `AO_AGENT`            | `claude-code`        | Compatibility agent   |
| `GITHUB_TOKEN`        | —                    | GitHub auth token     |

**Runtime selection is automatic** based on platform — no configuration needed.

## Data Directory Structure

```
~/.ao/
├── running.json          # PID + port handshake
├── data/                 # SQLite state
│   ├── ao.db            # Main database
│   ├── ao.db-wal        # Write-ahead log
│   └── ao.db-shm        # Shared memory
└── electron/            # Electron userData (for desktop app)
```

## Load-bearing Rules

- Do not store display status
- Keep session status facts small: `activity_state`, `is_terminated`, and PR facts are the durable inputs
- Do not treat failed probes as death
- Do not force-delete registered dirty worktrees
- Runtime selection is platform-based, not configurable

## Related Documentation

- [Backend Code Structure](backend-code-structure.md) — Package-by-package ownership
- [AGENTS.md](../AGENTS.md) — Contributor and worker-agent contract
- [CLI Reference](cli/README.md) — Complete CLI command documentation
- [Telemetry](telemetry.md) — Telemetry policy and configuration
