# Architecture Design — Agent Orchestrator

_Compiled: 2026-02-13_

## Core Philosophy

**Push, not pull.** The human never polls. The human never checks a dashboard wondering "what's happening?" The system pushes notifications to the human exactly when their attention is needed — and stays silent otherwise.

The dashboard is a **drill-down tool** you open after receiving a notification, not something you sit and watch. The **Notifier is the primary interface.**

### Interaction Model

```
Human spawns 20 agents → walks away → lives their life
                                          │
          ┌───────────────────────────────┘
          │
          ▼
    Orchestrator runs autonomously:
    ├── Agents work on issues
    ├── CI fails? → auto-send fix to agent → resolved silently
    ├── Review comments? → auto-send to agent → resolved silently
    ├── Agent stuck? → NOTIFY HUMAN
    ├── Agent needs input? → NOTIFY HUMAN
    ├── PR ready to merge? → NOTIFY HUMAN (or auto-merge if configured)
    ├── Agent errored? → NOTIFY HUMAN
    └── All done? → NOTIFY HUMAN with summary

Human only intervenes when notified. Everything else is handled.
```

### Design Principles

1. **Push, not pull**: Notifications are the primary interface. Dashboard is secondary drill-down.
2. **Server-centric**: All agents report to a central server. The server coordinates everything.
3. **Plugin everything**: 8 pluggable abstraction slots. Swap any component.
4. **Works out of the box**: Default config (tmux + claude-code + worktree + github) requires zero setup beyond `npx agent-orchestrator init`.
5. **Silence by default, loud when needed**: Auto-handle routine issues (CI failures, review comments). Only notify the human when their judgment or action is truly required.
6. **Runtime agnostic**: tmux is just one way to run agents. Docker, K8s, cloud, SSH, child processes — all through the same interface.

---

## Nomenclature

| Term             | Definition                                 | Examples                         |
| ---------------- | ------------------------------------------ | -------------------------------- |
| **Orchestrator** | The central server that manages everything | The Next.js app                  |
| **Project**      | A configured repository to work on         | `my-app`, `backend-api`          |
| **Session**      | A running agent instance working on a task | `my-app-1`, `my-app-2`           |
| **Runtime**      | Where/how the session executes             | tmux, docker, k8s, process       |
| **Agent**        | The AI coding tool being used              | claude-code, codex, aider        |
| **Workspace**    | Isolated code copy for a session           | git worktree, clone, volume      |
| **Tracker**      | Issue/task tracking system                 | github, linear, jira             |
| **SCM**          | Source code management platform            | github, gitlab, bitbucket        |
| **Notifier**     | Communication/alert channel                | slack, discord, desktop, webhook |
| **Terminal**     | Human interaction interface                | iterm2, web terminal, none       |

---

## System Architecture

```
                          ┌──────────────────────────────────────┐
       CLI ───REST───►    │         Orchestrator Server           │
                          │           (Next.js)                   │
       Web ───REST/───►   │                                       │
            SSE           │  ┌────────────┐  ┌────────────────┐  │
                          │  │  Session    │  │   Plugin       │  │
       Agents ────────►   │  │  Manager    │  │   Registry     │  │
       (heartbeat/        │  └──────┬─────┘  └───────┬────────┘  │
        webhook)          │         │                │            │
                          │  ┌──────┴─────┐  ┌───────┴────────┐  │
                          │  │  Lifecycle  │  │   Config       │  │
                          │  │  Manager    │  │   Manager      │  │
                          │  └──────┬─────┘  └────────────────┘  │
                          │         │                             │
                          │  ┌──────┴──────────────────────────┐ │
                          │  │          Event Bus               │ │
                          │  │  (pub/sub + persistence)         │ │
                          │  └──┬──────┬──────┬──────┬────────┘ │
                          └─────┼──────┼──────┼──────┼──────────┘
                                │      │      │      │
                        ┌───────┘      │      │      └───────┐
                        ▼              ▼      ▼              ▼
                   ┌─────────┐   ┌────────┐ ┌────────┐  ┌─────────┐
                   │ SSE →   │   │Notifier│ │Reaction│  │ Event   │
                   │ Web UI  │   │Plugins │ │ Engine │  │ Log     │
                   └─────────┘   └────────┘ └────────┘  └─────────┘
```

### Data Flow

1. **Agent → Server**: Heartbeats, status updates, "need input" signals
2. **Server → Dashboard**: SSE stream of session state changes
3. **Server → Notifiers**: Alerts when human attention is needed
4. **Server → Agents**: Commands via runtime-specific channels (tmux send-keys, docker exec, HTTP POST, etc.)
5. **CLI → Server**: REST API calls for spawn, kill, send, status
6. **SCM → Server**: PR state, CI checks, review comments (polled or webhooks)

---

## The 8 Plugin Slots

### 1. Runtime — Where sessions execute

```typescript
interface Runtime {
  readonly name: string;

  // Lifecycle
  create(session: SessionConfig): Promise<RuntimeHandle>;
  destroy(handle: RuntimeHandle): Promise<void>;

  // Communication
  sendMessage(handle: RuntimeHandle, message: string): Promise<void>;
  getOutput(handle: RuntimeHandle, lines?: number): Promise<string>;

  // Health
  isAlive(handle: RuntimeHandle): Promise<boolean>;
  getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics>;

  // Optional: interactive access
  attach?(handle: RuntimeHandle): Promise<AttachInfo>;
}
```

| Implementation   | How it works                   | Best for                       |
| ---------------- | ------------------------------ | ------------------------------ |
| `tmux` (default) | tmux sessions + send-keys      | Local development, interactive |
| `process`        | Child processes + stdin/stdout | Headless, CI/CD, scripting     |
| `docker`         | Docker containers + exec       | Isolation, reproducibility     |
| `kubernetes`     | K8s pods/jobs                  | Scale, enterprise              |
| `ssh`            | SSH to remote + tmux/process   | Remote machines                |
| `e2b`            | E2B SDK (Firecracker microVMs) | Cloud sandboxes                |
| `fly`            | Fly.io Machines API            | Cost-effective cloud           |
| `modal`          | Modal Sandboxes                | GPU, autoscaling               |

### 2. Agent — AI coding tool

```typescript
interface Agent {
  readonly name: string;
  readonly processName: string; // for detection

  // Launch
  getLaunchCommand(session: SessionConfig, project: ProjectConfig): string;
  getEnvironment(session: SessionConfig): Record<string, string>;

  // Activity detection
  detectActivity(session: Session): Promise<ActivityState>;
  isProcessRunning(runtimeHandle: RuntimeHandle): Promise<boolean>;

  // Introspection
  introspect(session: Session): Promise<AgentIntrospection | null>;

  // Optional
  postLaunchSetup?(session: Session): Promise<void>;
  estimateCost?(session: Session): Promise<CostEstimate>;
}
```

| Implementation          | Launch command                          | Activity detection         |
| ----------------------- | --------------------------------------- | -------------------------- |
| `claude-code` (default) | `claude --dangerously-skip-permissions` | JSONL mtime + process tree |
| `claude-headless`       | `claude -p --output-format stream-json` | stdout parsing             |
| `codex`                 | `codex`                                 | Process detection          |
| `aider`                 | `aider --no-auto-commits`               | Process detection          |
| `goose`                 | `goose session`                         | Process detection          |
| `custom`                | User-defined command                    | Configurable               |

### 3. Workspace — Code isolation

```typescript
interface Workspace {
  readonly name: string;

  create(project: ProjectConfig, session: SessionConfig): Promise<WorkspacePath>;
  destroy(path: WorkspacePath): Promise<void>;
  list(project: ProjectConfig): Promise<WorkspaceInfo[]>;

  // Optional hooks
  postCreate?(path: WorkspacePath, project: ProjectConfig): Promise<void>;
}
```

| Implementation       | How                      | Tradeoff                                 |
| -------------------- | ------------------------ | ---------------------------------------- |
| `worktree` (default) | `git worktree add`       | Fast, shared objects, requires same repo |
| `clone`              | `git clone`              | Full isolation, slower, more disk        |
| `copy`               | `cp -r`                  | No git dependency, heaviest              |
| `volume`             | Docker/K8s volume mounts | For container runtimes                   |

### 4. Tracker — Issue/task tracking

```typescript
interface Tracker {
  readonly name: string;

  getIssue(identifier: string): Promise<Issue>;
  isCompleted(identifier: string): Promise<boolean>;
  issueUrl(identifier: string): string;
  branchName(identifier: string): string;
  generatePrompt(identifier: string, project: ProjectConfig): string;

  // Optional
  listIssues?(filters?: IssueFilters): Promise<Issue[]>;
  updateIssue?(identifier: string, update: IssueUpdate): Promise<void>;
  createIssue?(input: CreateIssueInput): Promise<Issue>;
}
```

| Implementation     | API         | Auth           |
| ------------------ | ----------- | -------------- |
| `github` (default) | `gh` CLI    | GitHub token   |
| `linear`           | GraphQL API | Linear API key |
| `jira`             | REST API    | Jira token     |
| `plain`            | Local files | None           |

### 5. SCM — Source code platform (PR, CI, Reviews)

```typescript
interface SCM {
  readonly name: string;

  // PR lifecycle
  detectPR(session: Session): Promise<PRInfo | null>;
  getPRState(pr: PRInfo): Promise<PRState>;
  createPR(session: Session, title: string, body: string): Promise<PRInfo>;
  mergePR(pr: PRInfo, method?: MergeMethod): Promise<void>;
  closePR(pr: PRInfo): Promise<void>;

  // CI tracking
  getCIChecks(pr: PRInfo): Promise<CICheck[]>;
  getCISummary(pr: PRInfo): Promise<CIStatus>;

  // Review tracking
  getReviews(pr: PRInfo): Promise<Review[]>;
  getReviewDecision(pr: PRInfo): Promise<ReviewDecision>;
  getPendingComments(pr: PRInfo): Promise<ReviewComment[]>;
  getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]>;

  // Merge readiness
  getMergeability(pr: PRInfo): Promise<MergeReadiness>;
}
```

| Implementation     | API                 | Features                   |
| ------------------ | ------------------- | -------------------------- |
| `github` (default) | `gh` CLI + REST API | Full PR/CI/review support  |
| `gitlab`           | REST API            | MR/pipeline/review support |
| `bitbucket`        | REST API            | PR/pipeline support        |

### 6. Notifier — THE PRIMARY INTERFACE

The notifier is not a nice-to-have — it is the primary way the system communicates with humans. The human walks away after spawning agents. Notifications bring them back only when needed.

```typescript
interface Notifier {
  readonly name: string;

  // Core: push a notification to the human
  notify(event: OrchestratorEvent): Promise<void>;

  // Optional: actionable notifications (buttons/links)
  notifyWithActions?(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void>;

  // Optional: richer communication (post to channel)
  post?(message: string, context?: NotifyContext): Promise<string | null>;
}

// Notifications can include actions the human can take directly
interface NotifyAction {
  label: string; // "Merge PR", "Open Dashboard", "Kill Session"
  url?: string; // Deep link to dashboard action
  callback?: string; // API endpoint to call
}
```

| Implementation      | Channel                      | Best for            | Actionable?                   |
| ------------------- | ---------------------------- | ------------------- | ----------------------------- |
| `desktop` (default) | OS notifications (clickable) | Solo developer      | Click → opens dashboard       |
| `slack`             | Slack messages with buttons  | Teams               | Buttons → merge, review, kill |
| `discord`           | Discord messages             | Communities         | Links                         |
| `webhook`           | HTTP POST                    | Custom integrations | Custom                        |
| `email`             | Email digest                 | Async               | Links                         |

**Multiple notifiers can be active simultaneously.** E.g., desktop for immediate alerts + Slack for team visibility + email for daily digest.

### 7. Terminal — Human interaction interface

```typescript
interface Terminal {
  readonly name: string;

  openSession(session: Session): Promise<void>;
  openAll(sessions: Session[]): Promise<void>;

  // Optional
  isSessionOpen?(session: Session): Promise<boolean>;
}
```

| Implementation   | How                       | Platform      |
| ---------------- | ------------------------- | ------------- |
| `auto` (default) | Detect best available     | Any           |
| `iterm2`         | AppleScript API           | macOS         |
| `web`            | xterm.js in browser       | Any           |
| `tmux-attach`    | `tmux attach` in terminal | Any with tmux |
| `none`           | Headless                  | CI/CD         |

### 8. Lifecycle Manager (Core — not pluggable)

The Lifecycle Manager is the orchestrator's brain. It:

- Polls SCM + Agent plugins on configurable intervals
- Maintains state machine per session
- Emits events on state transitions
- Runs configured reactions
- Feeds real-time data to dashboard via SSE

---

## Session Lifecycle State Machine

```
                    ┌──────────┐
                    │ SPAWNING │
                    └────┬─────┘
                         │ runtime.create() + agent launched
                         ▼
                    ┌──────────┐
              ┌─────│ WORKING  │◄─────────────────────────┐
              │     └────┬─────┘                          │
              │          │ PR detected                     │
              │          ▼                                 │
              │     ┌──────────────┐                      │
              │     │ PR_OPEN      │                      │
              │     └────┬─────────┘                      │
              │          │                                │
              │     ┌────┴────────────┐                   │
              │     ▼                 ▼                   │
              │ ┌──────────┐  ┌─────────────────┐        │
              │ │ CI_FAILED│  │ REVIEW_PENDING  │        │
              │ └────┬─────┘  └────┬────────────┘        │
              │      │             │                      │
              │      │  ┌──────────┴──────┐               │
              │      │  ▼                 ▼               │
              │      │ ┌──────────────┐  ┌──────────┐    │
              │      │ │CHANGES_REQ'D │  │ APPROVED │    │
              │      │ └──────┬───────┘  └────┬─────┘    │
              │      │        │               │          │
              │      └────────┼───────────────┘          │
              │               │ agent fixes              │
              │               └──────────────────────────┘
              │
              │     When approved + CI green + no conflicts:
              │          ▼
              │     ┌──────────┐
              │     │MERGEABLE │──► auto-merge or notify human
              │     └────┬─────┘
              │          │
              │          ▼
              │     ┌──────────┐
              │     │ MERGED   │
              │     └────┬─────┘
              │          │
              │          ▼
              │     ┌──────────┐
              │     │ CLEANUP  │──► destroy workspace + archive metadata
              │     └──────────┘
              │
              │  At any point:
              │     ┌───────────────┐
              ├────►│ NEEDS_INPUT   │──► notify human
              │     └───────────────┘
              │     ┌───────────────┐
              ├────►│ STUCK/IDLE    │──► notify human after threshold
              │     └───────────────┘
              │     ┌───────────────┐
              ├────►│ ERRORED       │──► notify human
              │     └───────────────┘
              │     ┌───────────────┐
              └────►│ KILLED        │──► cleanup
                    └───────────────┘
```

---

## Human Attention Optimization

**The system notifies the human. The human never polls.**

The orchestrator operates on a simple principle: handle everything you can automatically, and push a notification to the human only when their judgment or action is truly required. The human spawns agents, walks away, and gets notified.

### Two-Tier Event Handling

**Tier 1: Auto-handled (human never sees these)**
The orchestrator resolves these silently. The human is only notified if auto-resolution fails.

| Event                  | Auto-Response                    | Escalation                       |
| ---------------------- | -------------------------------- | -------------------------------- |
| CI failed              | Send fix prompt to agent         | Notify after 2 failed attempts   |
| Review comments        | Send "address comments" to agent | Notify if unresolved after 30min |
| Bugbot/linter comments | Send fix prompt to agent         | Notify if unresolved after 30min |
| Merge conflicts        | Send "rebase" to agent           | Notify if unresolved after 15min |

**Tier 2: Notify human (requires human judgment)**
These always push a notification. The human's phone buzzes, Slack pings, etc.

| Event                                                          | Priority | Notification                                          |
| -------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| **Agent needs input** (permission, question, stuck)            | URGENT   | "Session X needs your input" + deep link              |
| **Agent errored** (crashed, unrecoverable)                     | URGENT   | "Session X crashed" + error context                   |
| **PR ready to merge** (approved + CI green)                    | ACTION   | "PR #42 ready to merge" + merge button                |
| **Agent idle too long** (no PR, no progress)                   | WARNING  | "Session X idle for 15min, may need help"             |
| **Auto-fix failed** (CI fix failed 2x, comments not addressed) | WARNING  | "Session X couldn't resolve CI/review — needs you"    |
| **All work complete**                                          | INFO     | "All 20 sessions done. 18 PRs merged, 2 need review." |

### Escalation Chains

Events start at auto-handle and escalate through notification tiers:

```
Event detected
    │
    ▼
Can auto-handle? ──yes──► Auto-respond (send to agent)
    │                          │
    no                    Resolved? ──yes──► Done (silent)
    │                          │
    ▼                          no (retry N times)
NOTIFY HUMAN                   │
    │                          ▼
    │                     NOTIFY HUMAN
    │                     "Tried to auto-fix, couldn't resolve"
    ▼
Human acts via:
  ├── Notification action button (merge, kill, open)
  ├── Dashboard deep link
  ├── CLI command
  └── Direct tmux attach
```

### Notification Channels (Priority-Based Routing)

Different priorities route to different channels:

```yaml
notifications:
  routing:
    urgent: [desktop, slack, sms] # Agent stuck, errored, needs input
    action: [desktop, slack] # PR ready to merge
    warning: [slack] # Auto-fix failed, idle too long
    info: [slack] # Summary, all done
```

### Reactions (configurable auto-responses)

```yaml
# agent-orchestrator.yaml
reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    message: "CI is failing. Run `gh pr checks` to see failures, fix them, and push."
    retries: 2
    escalate-after: 2 # notify human after 2 failed auto-fix attempts

  changes-requested:
    auto: true
    action: send-to-agent
    message: "Review comments on your PR. Check with `gh pr view --comments` and address each one."
    escalate-after: 30m

  bugbot-comments:
    auto: true
    action: send-to-agent
    message: "Automated review comments found. Fix the issues flagged by the bot."
    escalate-after: 30m

  merge-conflicts:
    auto: true
    action: send-to-agent
    message: "Your branch has merge conflicts. Rebase on the default branch and resolve them."
    escalate-after: 15m

  approved-and-green:
    auto: false # require human confirmation by default
    action: notify
    priority: action
    message: "PR is ready to merge"
    # Set auto: true + action: auto-merge for full automation

  agent-stuck:
    threshold: 10m
    action: notify
    priority: urgent

  agent-needs-input:
    action: notify
    priority: urgent

  agent-exited:
    action: notify
    priority: urgent

  all-complete:
    action: notify
    priority: info
    message: "All sessions complete"
    include-summary: true # PRs merged, pending, failed

  agent-idle-no-pr:
    threshold: 30m # working for 30min with no PR
    action: notify
    priority: warning
    message: "Agent has been working for 30min without creating a PR"
```

### Dashboard (Secondary — Drill-Down Tool)

The dashboard exists for when you get a notification and need to drill down. It's organized by attention priority:

- **Red zone** (top): URGENT — sessions needing human input RIGHT NOW
- **Orange zone**: ACTION — PRs ready to merge, decisions needed
- **Yellow zone**: WARNING — auto-fix failed, agents idle too long
- **Green zone**: Sessions working normally (collapsed by default)
- **Grey zone**: Completed/merged (collapsed by default)

Clicking a notification deep-links directly to the relevant session/PR in the dashboard.

---

## Configuration

### Minimal Config (works out of the box)

```yaml
# agent-orchestrator.yaml
projects:
  my-app:
    repo: org/repo
    path: ~/my-app
```

Everything else uses sensible defaults:

- Runtime: tmux
- Agent: claude-code
- Workspace: worktree
- Tracker: github (inferred from repo)
- SCM: github (inferred from repo)
- Notifier: desktop
- Terminal: auto-detect

### Full Config

```yaml
# agent-orchestrator.yaml
dataDir: ~/.agent-orchestrator # metadata storage
worktreeDir: ~/.worktrees # workspace root
port: 3000 # web dashboard port

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  my-app:
    name: My App
    repo: org/repo
    path: ~/my-app
    defaultBranch: main
    sessionPrefix: app

    # Override defaults per project
    agent: claude-code
    runtime: tmux

    # Issue tracker
    tracker:
      plugin: linear
      teamId: "abc-123"

    # SCM (usually inferred from repo)
    scm:
      plugin: github

    # Symlinks to copy into workspaces
    symlinks: [.env, .claude]

    # Commands to run after workspace creation
    postCreate:
      - "pnpm install"
      - "claude mcp add rube --transport http https://rube.app/mcp"

    # Agent-specific config
    agentConfig:
      permissions: skip # --dangerously-skip-permissions
      model: opus

    # Reaction overrides
    reactions:
      approved-and-green:
        auto: true # enable auto-merge for this project

# Notification channels
notifiers:
  slack:
    plugin: slack
    webhook: ${SLACK_WEBHOOK_URL}
    channel: "#agent-updates"
  desktop:
    plugin: desktop

# Reaction defaults (can be overridden per project)
reactions:
  ci-failed:
    auto: true
    retries: 2
    escalate-after: 2
  changes-requested:
    auto: true
    escalate-after: 30m
  approved-and-green:
    auto: false
  agent-stuck:
    threshold: 10m
  agent-needs-input:
    priority: high
```

---

## Tech Stack

| Segment             | Choice                                  | Why                                                  |
| ------------------- | --------------------------------------- | ---------------------------------------------------- |
| **Core library**    | TypeScript                              | Shared types across all packages                     |
| **Web + API**       | Next.js 15 (App Router)                 | SSR + API routes in one process                      |
| **Styling**         | Tailwind CSS                            | Dark theme, responsive                               |
| **Real-time**       | Server-Sent Events                      | One-way push, auto-reconnect, simpler than WebSocket |
| **CLI**             | TypeScript + Commander.js               | Shares types with core                               |
| **Config**          | YAML + Zod validation                   | Human-readable, type-safe                            |
| **State**           | Flat metadata files + Event log (JSONL) | Stateless orchestrator, crash recovery               |
| **Package manager** | pnpm workspaces                         | Fast, monorepo-native                                |
| **Distribution**    | npm (`npx agent-orchestrator`)          | Zero install                                         |

### Why TypeScript Throughout

1. **One language** — Plugin authors only need TypeScript/JavaScript
2. **Shared types** — No serialization boundaries between core, web, CLI, plugins
3. **npm distribution** — `npx agent-orchestrator` works everywhere
4. **Next.js** — Web + API server in one process, great DX
5. **Largest ecosystem** — More packages on npm than any other registry
6. **Performance is fine** — Bottleneck is AI agents, not orchestrator. We shell out to tmux/git/docker anyway.

---

## Directory Structure

```
agent-orchestrator/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── agent-orchestrator.yaml.example
│
├── packages/
│   ├── core/                          # @aoagents/ao-core
│   │   └── src/
│   │       ├── types.ts               # All interfaces + types
│   │       ├── config.ts              # YAML config loader + Zod validation
│   │       ├── session-manager.ts     # Session CRUD
│   │       ├── lifecycle-manager.ts   # State machine + reactions
│   │       ├── event-bus.ts           # Pub/sub + JSONL persistence
│   │       ├── plugin-registry.ts     # Plugin discovery + loading
│   │       ├── metadata.ts            # Flat-file read/write
│   │       └── index.ts
│   │
│   ├── cli/                           # @aoagents/ao-cli → `ao` binary
│   │   └── src/
│   │       ├── index.ts               # Commander.js setup
│   │       └── commands/
│   │           ├── init.ts            # ao init
│   │           ├── status.ts          # ao status
│   │           ├── spawn.ts           # ao spawn <project> [issue]
│   │           ├── batch-spawn.ts     # ao batch-spawn <project> <issues...>
│   │           ├── session.ts         # ao session [ls|kill|cleanup]
│   │           ├── send.ts            # ao send <session> <message>
│   │           ├── review-check.ts    # ao review-check [project]
│   │           ├── dashboard.ts       # ao dashboard (starts web)
│   │           └── open.ts            # ao open [session|all]
│   │
│   ├── web/                           # @aoagents/ao-web
│   │   ├── next.config.ts
│   │   └── src/
│   │       ├── app/
│   │       │   ├── layout.tsx
│   │       │   ├── page.tsx           # Dashboard (attention-prioritized)
│   │       │   └── sessions/[id]/
│   │       │       └── page.tsx       # Session detail
│   │       ├── api/
│   │       │   ├── sessions/          # CRUD + actions
│   │       │   ├── spawn/             # POST spawn
│   │       │   ├── events/            # SSE stream
│   │       │   └── health/            # Server health
│   │       └── components/
│   │           ├── SessionCard.tsx
│   │           ├── AttentionZone.tsx
│   │           ├── PRStatus.tsx
│   │           ├── CIBadge.tsx
│   │           └── Terminal.tsx        # xterm.js
│   │
│   └── plugins/                       # Built-in plugins
│       ├── runtime-tmux/
│       ├── runtime-process/
│       ├── runtime-docker/
│       ├── agent-claude-code/
│       ├── agent-codex/
│       ├── agent-aider/
│       ├── workspace-worktree/
│       ├── workspace-clone/
│       ├── tracker-github/
│       ├── tracker-linear/
│       ├── scm-github/
│       ├── notifier-desktop/
│       ├── notifier-slack/
│       ├── terminal-iterm2/
│       └── terminal-web/
│
├── artifacts/                         # Research + design docs
│   ├── competitive-research.md
│   └── architecture-design.md
│
├── scripts/                           # Original bash scripts (reference)
│
└── CLAUDE.md
```

---

## Implementation Phases

### Phase 1: Foundation (Dog-food ready)

- Monorepo scaffolding
- Core types + interfaces
- Config loader
- Session manager + lifecycle manager + event bus
- tmux runtime, claude-code agent, worktree workspace
- GitHub SCM (PR/CI/review tracking)
- GitHub tracker
- Desktop notifier
- CLI (init, status, spawn, session, send, dashboard)
- Web dashboard with attention-prioritized view
- SSE real-time updates
- Reaction engine (CI failed, changes requested, agent stuck)

### Phase 2: Multi-Runtime + More Plugins

- Process runtime (headless claude -p)
- Docker runtime
- Codex + Aider agent adapters
- Linear + Jira trackers
- Slack notifier
- Web terminal (xterm.js)

### Phase 3: Cloud + Scale

- Kubernetes runtime
- E2B / Fly.io runtimes
- Cost tracking
- Webhook-triggered spawning

### Phase 4: Team + Enterprise

- Dashboard auth
- Role-based access
- Remote session support
- Audit log
