# AgentMesh — Engineering Reference

AgentMesh is the coordination layer built on top of AgentMesh Core. AO solves the infrastructure problem: running many agents in parallel, isolating their workspaces, tracking their PRs, reacting to CI failures. AgentMesh solves the product problem: making those agents cooperate instead of running blind in separate terminals.

**One-line definition:** AgentMesh lets Claude Code, Codex, Devin, Gemini, OpenCode, Cursor, and other coding agents work together like an engineering team.

**Core loop:** Claude Code builds a feature. Codex tests it as QA. If QA fails, Claude receives the structured report and fixes it. If QA passes, AgentMesh opens a PR, waits for CI, and shows the full execution timeline.

**Implementation Status:** ✅ **CORE COORDINATION LAYER IMPLEMENTED**

The AgentMesh coordination layer is now fully implemented with:

- Task board with SQLite storage (`@aoagents/agentmesh-core`)
- Message bus with typed routing and JSONL logging
- Role manager with prompt templates for 6+ agent roles
- QA loop engine with state machine and retry budgets
- Policy engine for diff validation
- PR gate for QA-based PR opening
- Timeline logger for complete audit trails
- CLI interface (`agentmesh` command)

**✅ AGENT ADAPTERS IMPLEMENTED**

- Claude Code adapter (`@aoagents/agentmesh-adapters`)
- Codex adapter (`@aoagents/agentmesh-adapters`)
- Devin adapter (`@aoagents/agentmesh-adapters`) - GitHub-based external agent
- Cursor adapter (`@aoagents/agentmesh-adapters`) - IDE integration with .cursor/chat.md monitoring
- Aider adapter (`@aoagents/agentmesh-adapters`) - Git-aware coding with automated commits
- Gemini CLI adapter (`@aoagents/agentmesh-adapters`) - Multi-modal AI with large context window
- OpenCode adapter (`@aoagents/agentmesh-adapters`) - Open-source workflow optimization
- KimiCode adapter (`@aoagents/agentmesh-adapters`) - Moonshot AI with Chinese language support
- Adapter registry for dynamic agent management

**✅ AO INTEGRATION IMPLEMENTED**

- CoordinationService bridges AgentMesh with AO's SessionManager
- Full QA loop workflow: builder → QA → rework → PR
- Policy engine integration with PR workflow
- Timeline logging integrated with session events
- Lock management for multi-agent coordination
- Automatic conflict detection and resolution
- Cost tracking with budget management

**✅ WEB UI IMPLEMENTED**

- Task Board component with kanban-style view
- QA Loop Status component with real-time state visualization
- AgentMesh page at `/agentmesh` route
- Real-time API integration for task management

## Implementation Details

### Package Structure

```
packages/
├── agentmesh-core/          # Core coordination services
│   ├── src/
│   │   ├── types.ts         # Type definitions
│   │   ├── task-manager.ts  # Task board with SQLite
│   │   ├── message-bus.ts   # Typed message routing
│   │   ├── role-manager.ts  # Role definitions and prompts
│   │   ├── qa-loop.ts       # QA state machine
│   │   ├── policy-engine.ts # Diff validation
│   │   ├── pr-gate.ts       # PR opening controls
│   │   ├── timeline-logger.ts # JSONL audit trail
│   │   ├── storage.ts       # Storage management
│   │   └── coordination-service.ts # AO integration layer
│   └── package.json
├── agentmesh-adapters/      # Agent adapters for AO integration
│   ├── src/
│   │   ├── claude-code-adapter.ts # Claude Code adapter
│   │   ├── codex-adapter.ts        # Codex adapter
│   │   └── index.ts               # Adapter registry
│   └── package.json
├── agentmesh-cli/           # CLI interface
│   ├── src/
│   │   └── index.ts         # CLI commands
│   └── package.json
└── web/                     # Web dashboard
    ├── src/
    │   ├── components/
    │   │   ├── TaskBoard.tsx      # Kanban task board
    │   │   └── QALoopStatus.tsx   # QA loop visualization
    │   └── app/
    │       ├── agentmesh/
    │       │   └── page.tsx       # AgentMesh page
    │       └── api/
    │           └── agentmesh/
    │               ├── tasks/
    │               │   ├── route.ts     # Task list/create
    │               │   └── [id]/
    │               │       ├── route.ts # Task details/delete
    │               │       ├── start/
    │               │       │   └── route.ts # Start builder phase
    │               │       └── qa/
    │               │           └── route.ts # Submit QA result
    └── package.json
```

### Usage

```bash
# Install dependencies
pnpm install

# Build AgentMesh packages
pnpm build

# Use the AgentMesh CLI
cd packages/agentmesh-cli
node dist/index.js task create --title "Fix login bug" --role builder
node dist/index.js task list
node dist/index.js board
node dist/index.js roles
```

### Programmatic Usage

```typescript
import { CoordinationService } from "@aoagents/agentmesh-core";
import { ClaudeCodeAdapter, CodexAdapter } from "@aoagents/agentmesh-adapters";
import { SessionManager } from "@aoagents/ao-core";

// Initialize coordination service
const sessionManager = new SessionManager(config);
const coordinationService = new CoordinationService(sessionManager, "my-project");

// Register adapters
coordinationService.registerAdapter("claude-code", new ClaudeCodeAdapter(sessionManager));
coordinationService.registerAdapter("codex", new CodexAdapter(sessionManager));

// Create and start a task
const task = await coordinationService.createTask({
  title: "Fix login bug",
  description: "Users cannot login with SSO",
  role: "builder",
  priority: "high",
  projectId: "my-project",
  branch: "fix/login-sso",
  issueId: "ISSUE-123",
});

// Start the builder phase
await coordinationService.startBuilder(task.id);

// When builder completes, start QA
await coordinationService.handleBuilderComplete(task.id);

// Process QA result
const qaResult = {
  verdict: "FAIL",
  summary: "Found security vulnerabilities",
  findings: [...],
};
const decision = await coordinationService.processQAResult(task.id, qaResult);
```

### Web UI

Access the AgentMesh dashboard at `http://localhost:3000/agentmesh` to see:

- Task Board with kanban-style view of all tasks
- QA Loop Status with real-time state visualization
- Task details with issue links and timeline

### Core Services

**TaskManager**: SQLite-based task board with full CRUD operations and status transitions.

**MessageBus**: Typed message routing with JSONL logging for replay and debugging.

**RoleManager**: Defines agent roles (builder, qa, planner, security_reviewer, docs_writer, release_manager) with role-specific prompt templates.

**QALoopEngine**: State machine managing builder → QA → rework cycles with configurable retry budgets.

**PolicyEngine**: Configurable policy rules for diff validation. Includes security rules (secrets, SQL injection, XSS), performance rules (no sync operations), accessibility rules (alt text, ARIA labels), and code quality rules (no TODO comments, magic numbers, error handling, hardcoded URLs).

**PRGate**: Controls PR opening based on QA results and policy checks with configurable gates.

**TimelineLogger**: JSONL-based audit trail logging all task events for replay and debugging.

**LockManager**: SQLite-based lock management for multi-agent coordination. Prevents conflicts when multiple agents work on the same codebase. Supports file, directory, branch, and feature-level locking with automatic expiration and conflict detection.

**CostTracker**: SQLite-based cost and token usage tracking for budget management. Supports per-task and daily budget limits, configurable alert thresholds, and detailed cost breakdowns by agent and model.

**CoordinationService**: High-level service that integrates all AgentMesh components with AO's SessionManager. Manages the full workflow from task creation through QA loops to PR opening, including lock management and cost tracking.

### Next Steps

The AgentMesh coordination layer is **feature-complete** with comprehensive functionality. Remaining work includes:

1. **External Integrations**: GitHub Projects sync, Linear integration for alternative project tracking
2. **Advanced Lock Features**: Hierarchical locking, lock inheritance, and deadlock detection
3. **Testing**: Comprehensive unit and integration tests for the coordination layer
4. **Performance**: Optimization for large-scale deployments with many concurrent tasks
5. **Additional Policy Rules**: More sophisticated security patterns, performance benchmarks, accessibility standards
6. **Cost Integration**: Real-time cost capture from agent adapters (currently manual recording)

---

## Product Thesis

Developers already run multiple AI coding agents in parallel — different terminals, IDE sessions, or web environments. The problem is not that agents cannot code. The problem is that they do not coordinate.

Each agent sees only its own session. They do not share a task board. They do not hand work to QA. They cannot safely loop from implementation to verification to rework without a human manually copying prompts between terminals.

AgentMesh fixes that. The missing layer is not intelligence — it is coordination. Agents need shared state, task ownership, role assignment, message passing, QA handoff, retry rules, audit logs, and completion gates.

---

## Where AgentMesh Sits

```
User
 ↓
agentmesh CLI
 ↓
AgentMesh Core (roles, message bus, QA loop, task board, policy engine, timeline)
 ↓
AO Core Infrastructure (session manager, lifecycle manager, plugin registry)
 ↓
Agent Adapters (Claude Code, Codex, Devin, Gemini CLI, OpenCode, Cursor Agent)
 ↓
Git / GitHub / CI / PRs
```

AgentMesh does not rewrite AO's core lifecycle. The first version adds a thin coordination layer:

```
agentmesh commands
  → call AO session APIs
  → write AgentMesh task/message state
  → route prompts between AO sessions
  → inspect AO session output
  → trigger AO reactions
```

### What AgentMesh reuses from AO

- Session management and worktree isolation
- Runtime plugins (tmux on Unix, ConPTY pty-host on Windows)
- Agent plugins (all existing adapters)
- SCM plugins (GitHub PR creation, CI tracking, review routing)
- Tracker plugins (GitHub Issues, Linear)
- Notifier plugins
- CI reaction loop
- Review comment reaction loop
- Web dashboard (extended in V1)

### What AgentMesh adds

- Role-based agents (builder, qa, planner, security_reviewer, docs_writer, release_manager)
- Agent-to-agent typed message bus
- QA workflow state machine with PASS/FAIL/BLOCKED verdicts
- Structured QA reports
- Builder rework loop with retry budgets
- Shared task board (local SQLite → GitHub Projects / Linear in V1)
- Code ownership and locking
- Timeline replay (`agentmesh replay TASK-001`)
- Policy gates (block dangerous file changes before merge)
- PR gate (PR opens only after QA passes)
- `.agentmesh/` storage directory inside the repo

---

## System Components

| Component            | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| CLI                  | `agentmesh` commands — init, run, watch, replay, board               |
| Local daemon         | Coordinates the QA loop polling and reaction routing                 |
| Task board           | Local-first SQLite board (Backlog → Building → QA → PR Ready → Done) |
| Message bus          | Typed, logged, replayable inter-agent messages                       |
| Role manager         | Defines builder and QA roles, prompt templates, permissions          |
| Workflow engine      | State machine driving the task from `created` to `done` or `blocked` |
| QA loop engine       | Builder → QA → rework cycles with retry enforcement                  |
| Agent adapter layer  | Per-agent interface for start, send, getOutput, getStatus, stop      |
| AO integration layer | Calls AO session APIs; routes prompts via AO runtime                 |
| Timeline logger      | Logs every task event as structured JSONL                            |
| Policy engine        | Checks diffs against policy config before any PR-open                |
| PR gate              | Opens PR only after QA passes and policy is clean                    |
| Storage layer        | `.agentmesh/` directory + SQLite inside the repo                     |

---

## Core Concept: Agent Roles

AO treats agents as workers. AgentMesh adds explicit roles.

### Role definition

Each role has:

| Field               | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `name`              | Role identifier                                       |
| `purpose`           | Human-readable description                            |
| `agent`             | Default agent plugin for this role                    |
| `permissions`       | `can_edit_code`, `can_run_tests`, `can_open_pr`, etc. |
| `prompt_template`   | Path to `.agentmesh/prompts/*.md`                     |
| `allowed_actions`   | Enumerated permitted actions                          |
| `forbidden_actions` | Hard-blocked actions                                  |
| `completion_signal` | What output indicates the agent is done               |
| `output_format`     | Expected structured output shape                      |
| `retry_behavior`    | Max retries, backoff policy                           |

### MVP roles

- `builder` — implements the feature (default: Claude Code)
- `qa` — tests the feature ruthlessly, returns PASS/FAIL/BLOCKED (default: Codex)

### V1 roles

- `planner`
- `backend_builder`
- `frontend_builder`
- `qa_engineer`
- `security_reviewer`
- `docs_writer`
- `release_manager`

### Example role config

```yaml
roles:
  backend_builder:
    agent: claude-code
    purpose: "Implement backend feature work."
    can_edit_code: true
    can_run_tests: true
    can_open_pr: false
    can_merge: false
    prompt_template: ".agentmesh/prompts/backend-builder.md"

  qa_engineer:
    agent: codex
    purpose: "Ruthlessly test feature work and report pass/fail."
    can_edit_code: false
    can_add_tests: true
    can_run_tests: true
    can_open_pr: false
    can_merge: false
    verdict_required: true
    prompt_template: ".agentmesh/prompts/qa-engineer.md"
```

---

## Core Concept: Message Bus

All agent-to-agent communication goes through a typed, logged message bus. The UX can feel like direct messaging, but internally every message is linked to a task, stored, and replayable.

### Message types

| Type                  | Direction         | Meaning                          |
| --------------------- | ----------------- | -------------------------------- |
| `task_assignment`     | system → agent    | New task assigned                |
| `task_claim`          | agent → system    | Agent acknowledges task          |
| `progress_update`     | agent → system    | Heartbeat update                 |
| `completion_claim`    | agent → system    | Builder says "ready for QA"      |
| `qa_request`          | system → qa_agent | Route task to QA                 |
| `qa_report`           | qa_agent → system | QA verdict and structured report |
| `rework_request`      | system → builder  | QA failed; here is the feedback  |
| `blocker_report`      | agent → system    | Agent cannot proceed             |
| `pr_ready`            | system → user     | PR opened after QA pass          |
| `human_input_request` | agent → system    | Agent needs approval             |
| `policy_violation`    | system → user     | Dangerous change detected        |
| `merge_request`       | system → user     | CI passed; ready to merge        |
| `system_notice`       | system → all      | Lifecycle event                  |

### Message schema

```json
{
  "id": "MSG-000001",
  "task_id": "TASK-001",
  "from_agent_id": "claude.backend.1",
  "to_agent_id": "codex.qa.1",
  "type": "qa_request",
  "body": "Feature implementation is ready for QA.",
  "attachments": {
    "diff_path": ".agentmesh/tasks/TASK-001/attempts/attempt-1.diff",
    "logs_path": ".agentmesh/tasks/TASK-001/logs/builder.log",
    "test_log_path": ".agentmesh/tasks/TASK-001/logs/self-test.log"
  },
  "created_at": "2026-06-16T20:00:00Z",
  "status": "delivered"
}
```

---

## Core Concept: QA Loop

### QA loop states

```
created → assigned → building → builder_self_testing → ready_for_qa
  → qa_running
      ├── qa_passed → pr_opening → ci_running → merge_ready → done
      ├── qa_failed → reworking → builder_self_testing (retry)
      └── blocked → blocked
```

Full state list: `created`, `planned`, `assigned`, `building`, `builder_self_testing`, `ready_for_qa`, `qa_running`, `qa_failed`, `reworking`, `qa_passed`, `pr_opening`, `ci_running`, `ci_failed`, `review_pending`, `merge_ready`, `done`, `blocked`, `cancelled`.

### Retry policy

```yaml
qa_loop:
  max_retries: 2
  stop_on_p0: true
  stop_on_policy_violation: true
  stop_on_forbidden_file_change: true
  stop_on_dependency_change: false
```

Attempt 1: builder implements → QA tests → if fail, builder receives feedback.
Attempt 2: builder fixes → QA retests → if fail again, task becomes `blocked`.
No unlimited loops.

---

## Core Concept: QA Report

### QA verdicts

| Verdict   | Meaning                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`    | Feature requirements met, tests pass, no regressions, no critical security issues, QA has evidence                                |
| `FAIL`    | Feature incomplete, tests fail, regression exists, security problem, or requirement mismatch — QA can provide actionable feedback |
| `BLOCKED` | App cannot start, dependencies cannot install, environment broken, requirements unclear, repo state corrupted                     |

### User-facing QA report (plain English)

```
QA failed.

The password reset feature works in the happy path, but reset tokens can be
reused after a successful password reset. That is a P1 security issue.

Commands run:
- npm test
- npm run test:e2e

Required fix:
Invalidate the reset token after first successful use and add a regression
test proving token reuse fails.
```

### Internal QA report (structured)

```json
{
  "task_id": "TASK-001",
  "attempt": 1,
  "verdict": "FAIL",
  "confidence": 0.91,
  "summary": "Password reset happy path works, but reset tokens can be reused.",
  "severity": "P1",
  "commands_run": [
    { "command": "npm test", "status": "PASS", "log_path": "..." },
    { "command": "npm run test:e2e", "status": "FAIL", "log_path": "..." }
  ],
  "issues": [
    {
      "id": "QA-001",
      "severity": "P1",
      "title": "Reset token can be reused",
      "expected": "A reset token is invalid after first successful use.",
      "actual": "The same token can reset the password multiple times.",
      "repro_steps": [
        "Request password reset.",
        "Use token to reset password.",
        "Reuse the same token for another reset.",
        "Observe that second reset succeeds."
      ],
      "likely_files": ["src/auth/reset.ts", "tests/auth/reset.test.ts"]
    }
  ],
  "next_prompt_for_builder": "Fix reset token invalidation after successful password reset. Add a regression test proving reused tokens fail."
}
```

---

## Core Concept: Task Board

### Board columns

`Backlog` → `Ready` → `Building` → `Ready for QA` → `QA Running` → `Rework` → `PR Ready` → `Blocked` → `Done`

### Task object

```json
{
  "id": "TASK-001",
  "title": "Add password reset flow",
  "description": "Implement password reset request, email token creation, reset endpoint, and tests.",
  "status": "qa_failed",
  "priority": "P1",
  "created_at": "2026-06-16T20:00:00Z",
  "updated_at": "2026-06-16T20:30:00Z",
  "assigned_agents": {
    "builder": "claude.backend.1",
    "qa": "codex.qa.1"
  },
  "attempt": 1,
  "max_attempts": 2,
  "branch": "agentmesh/TASK-001-password-reset",
  "pr_url": null
}
```

### Board storage

MVP: local SQLite at `.agentmesh/db.sqlite`.
V1: GitHub Projects, Linear, Jira (via AO tracker plugin extension).

---

## Core Concept: Code Ownership and Locking

Multiple agents editing the same files at the same time corrupts work.

### Lock types

- `task_lock` — one task owns an agent slot at a time
- `branch_lock` — one agent writes to a branch at a time
- `file_lock` — glob-based file ownership
- `directory_lock` — subtree ownership
- `role_lock` — QA cannot edit production code in review mode
- `pr_lock` — PR cannot be opened by two agents simultaneously

### Lock schema

```json
{
  "id": "LOCK-001",
  "task_id": "TASK-001",
  "agent_id": "claude.backend.1",
  "type": "file_glob",
  "target": "src/auth/**",
  "created_at": "2026-06-16T20:00:00Z",
  "expires_at": "2026-06-16T21:00:00Z"
}
```

### MVP rule

Only one editing agent may own a task at a time. QA may inspect and run tests. QA may not edit implementation files unless explicitly switched to QA fix mode.

### QA editing modes

| Mode             | Can do                                                          | Cannot do                                           |
| ---------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| Review mode      | Inspect diff, run tests, start app, write report, suggest fixes | Edit implementation, approve own code, merge PR     |
| Test-author mode | Add regression tests, add failing tests, update test fixtures   | Change production code                              |
| Fix mode         | Edit production code, patch simple bugs, create fix branch      | Self-approve (another agent must review the QA fix) |

Rule: No agent approves its own implementation.

---

## Core Concept: Policy Engine

The policy engine prevents agents from doing dangerous things autonomously.

### MVP policies — block or require human approval when:

- Dependency file changes (`package.json`, lockfiles)
- CI config changes (`.github/workflows/**`)
- Environment files change (`**/.env*`)
- Database migrations are added
- Secrets are detected
- Tests are deleted
- Large unrelated diffs appear (> 30 files or > 1500 lines added)
- Generated files dominate the diff
- Branch has merge conflicts
- Agent asks for credentials
- Agent attempts to merge without approval

### Policy config

```yaml
policy:
  require_approval:
    - package.json
    - pnpm-lock.yaml
    - package-lock.json
    - yarn.lock
    - .github/workflows/**
    - "**/.env*"
    - "migrations/**"
  forbidden_changes:
    - ".git/**"
    - "**/secrets/**"
    - "**/*.pem"
    - "**/*.key"
  max_diff:
    files: 30
    lines_added: 1500
    lines_deleted: 1000
  tests:
    deleting_tests_requires_approval: true
```

---

## Core Concept: PR Gate

### PR opening requirements

AgentMesh may open a PR only if all of the following are true:

1. Builder claims completion
2. Builder self-tests have run
3. QA passes
4. No policy blocker exists
5. Branch is clean
6. Diff is attached to task
7. Timeline is complete

### Merge requirements

1. PR exists
2. CI passes
3. Required reviews approved
4. No unresolved review comments
5. No policy blocker
6. Merge mode allowed
7. User enabled auto-merge

Default: agents make PRs ready, they do not merge. Auto-merge is off by default.

```yaml
pr_gate:
  open_pr_after_qa_pass: true
  auto_merge: false
  merge_method: squash
```

---

## Core Concept: Timeline and Replay

Every task step is logged as a structured event. The user can replay the full execution.

### Timeline events

Every important event is recorded: task created, agent spawned, prompt sent, file changed, command run, command output captured, test started/completed, QA requested, QA verdict received, retry started, PR opened, CI status changed, review comment received, merge ready, task blocked.

### Timeline event schema

```json
{
  "id": "EVT-000001",
  "task_id": "TASK-001",
  "agent_id": "claude.backend.1",
  "type": "command_started",
  "title": "Builder ran npm test",
  "data": {
    "command": "npm test",
    "cwd": "/Users/vlad/project",
    "attempt": 1
  },
  "created_at": "2026-06-16T20:00:00Z"
}
```

### Replay command

```bash
agentmesh replay TASK-001
```

Shows: prompts sent, agent outputs, commands run, test results, file diffs, QA reports, PR state changes.

---

## Configuration

AgentMesh extends AO's config with its own section. Use `agentmesh.yaml` for product clarity, supporting import of the existing `agent-orchestrator.yaml`.

### Full config example

```yaml
name: my-project

ao:
  config_path: ./agent-orchestrator.yaml
  reuse_runtime: true
  reuse_workspace: true
  reuse_scm: true
  reuse_notifiers: true

defaults:
  builder: claude-code
  qa: codex
  retries: 2
  workspace: worktree
  open_pr_after_qa_pass: true
  auto_merge: false

agents:
  claude-code:
    role_defaults:
      - backend_builder
      - frontend_builder
      - planner
  codex:
    role_defaults:
      - qa_engineer
      - code_reviewer
  devin:
    mode: github_external
    role_defaults:
      - external_reviewer
      - async_builder

roles:
  backend_builder:
    agent: claude-code
    prompt: .agentmesh/prompts/backend-builder.md
    can_edit_code: true
    can_run_tests: true
    can_open_pr: false
  qa_engineer:
    agent: codex
    prompt: .agentmesh/prompts/qa-engineer.md
    can_edit_code: false
    can_add_tests: true
    can_run_tests: true
    verdict_required: true

qa_loop:
  enabled: true
  max_retries: 2
  pass_opens_pr: true
  fail_returns_to_builder: true
  blocked_requires_user: false

visibility:
  capture_cli_output: true
  store_raw_logs: true
  timeline_enabled: true
  replay_enabled: true

policy:
  require_approval:
    - package.json
    - pnpm-lock.yaml
    - .github/workflows/**
    - "**/.env*"

board:
  mode: local
  storage: sqlite

scm:
  provider: github
  pr_base_branch: main

timeouts:
  builder_minutes: 45
  qa_minutes: 30
  command_minutes: 10
  idle_minutes: 10

budget:
  max_task_cost_usd: 5.00
  max_daily_cost_usd: 25.00
```

---

## Storage Design

### Directory layout (inside repo)

```
.agentmesh/
├── db.sqlite
├── config.resolved.json
├── tasks/
│   └── TASK-001/
│       ├── task.md
│       ├── state.json
│       ├── plan.md
│       ├── attempts/
│       │   ├── attempt-1/
│       │   │   ├── builder-output.log
│       │   │   ├── builder-summary.md
│       │   │   ├── diff.patch
│       │   │   ├── self-test.log
│       │   │   ├── qa-report.json
│       │   │   └── qa-report.md
│       │   └── attempt-2/
│       │       └── (same structure)
│       ├── messages.jsonl
│       ├── timeline.jsonl
│       └── final-report.md
├── logs/
├── messages/
├── prompts/
├── policies/
└── timelines/
```

### SQLite tables

| Table             | Purpose                                 |
| ----------------- | --------------------------------------- |
| `tasks`           | Task metadata, status, attempt counters |
| `agents`          | Active agent sessions and roles         |
| `sessions`        | AO session IDs linked to tasks          |
| `messages`        | Message bus log                         |
| `timeline_events` | Full task timeline                      |
| `qa_reports`      | Structured QA verdict and issues        |
| `attempts`        | Per-attempt metadata                    |
| `locks`           | Active file/branch/task locks           |
| `policies`        | Policy check results                    |
| `prs`             | PR tracking per task                    |
| `command_logs`    | Raw command output                      |
| `artifacts`       | Diffs, summaries, test outputs          |

### Key table schemas

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority TEXT,
  branch TEXT,
  pr_url TEXT,
  builder_agent_id TEXT,
  qa_agent_id TEXT,
  attempt INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 2,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  from_agent_id TEXT,
  to_agent_id TEXT,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  attachments_json TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE qa_reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  verdict TEXT NOT NULL,    -- PASS | FAIL | BLOCKED
  severity TEXT,
  confidence REAL,
  summary TEXT,
  report_json TEXT NOT NULL,
  report_md TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

---

## Prompt Templates

Prompt templates live in `.agentmesh/prompts/`. AgentMesh assembles them at runtime with task context filled in.

### Builder prompt

```
You are the builder agent for AgentMesh task {{task_id}}.

Your job:
- Implement the requested feature.
- Keep changes scoped to the task.
- Add or update tests when needed.
- Run relevant tests.
- Do not merge.
- Do not delete tests to make the build pass.
- Do not modify unrelated files.
- Stop when implementation is ready for QA.

Task:
{{task_description}}

Acceptance criteria:
{{acceptance_criteria}}

Previous QA feedback:
{{qa_feedback}}

Required final response:
1. Summary of changes
2. Files changed
3. Commands run
4. Known risks
5. Whether task is ready for QA
```

### QA prompt

```
You are the QA engineer agent for AgentMesh task {{task_id}}.

Your job:
- Test the implementation ruthlessly.
- Verify the original requirements.
- Inspect the git diff.
- Run existing tests.
- Add tests only if allowed by policy.
- Look for regressions, edge cases, security issues, broken UX, bad docs,
  and incomplete behavior.
- Return PASS only with evidence.
- Return FAIL when there is a real issue.
- Return BLOCKED when the environment or requirements prevent testing.

Task:
{{task_description}}

Builder summary:
{{builder_summary}}

Git diff:
{{diff_summary}}

Commands already run:
{{builder_commands}}

You must produce:
1. Plain English QA report
2. Structured verdict internally
3. Next prompt for builder if failed
```

### Rework prompt

```
QA failed the task.

You are the builder agent. Fix only the issues listed below. Do not rewrite
unrelated code.

QA report:
{{qa_report}}

Required fix:
{{next_prompt_for_builder}}

After fixing:
- Run relevant tests.
- Summarize what changed.
- Request QA again.
```

---

## Agent Adapter Interface

Every coding agent needs an adapter. The adapter knows how to start the agent, send it prompts, read its output, classify its state, and stop it.

```typescript
interface AgentMeshAgentAdapter {
  name: string;
  displayName: string;

  preflight(context: PreflightContext): Promise<PreflightResult>;

  start(config: AgentStartConfig): Promise<AgentSession>;

  sendMessage(session: AgentSession, message: AgentMessage): Promise<void>;

  getOutput(session: AgentSession, options?: OutputOptions): Promise<AgentOutput>;

  getStatus(session: AgentSession): Promise<AgentStatus>;

  stop(session: AgentSession): Promise<void>;

  resume?(session: AgentSession): Promise<void>;

  getSessionInfo?(session: AgentSession): Promise<AgentSessionInfo>;
}
```

### Initial adapters

**MVP:**

- Claude Code (builder)
- Codex (QA)

**V1:**

- Devin (via GitHub issue/PR/comment — not a local terminal agent)
- Gemini CLI
- OpenCode
- Cursor Agent
- Aider

### Devin adapter

Devin must be integrated through GitHub (issue assignment, PR review, comments, webhooks, API if available) — not through a local terminal. Devin roles: `external_reviewer`, `async_builder`, `pr_fixer`, `regression_checker`.

### Adapter contract rules

- `preflight()` checks that the binary/API is available before starting
- `sendMessage()` delivers a prompt to the running session (not spawns a new one)
- `getStatus()` returns one of: `active`, `ready`, `idle`, `waiting_input`, `blocked`, `exited`
- Adapters must version-check the underlying tool and fail gracefully on breaking CLI changes
- Use `shellEscape()` from `@aoagents/ao-core` for all command arguments

---

## Runtime Model

### MVP runtime

Uses AO's existing local runtime. Runs on: user laptop, local terminal, local repo, local branch, AO runtime plugins.

### Supported workspace modes

| Mode                               | When       | Notes                                                   |
| ---------------------------------- | ---------- | ------------------------------------------------------- |
| Same repo folder with branch lock  | MVP speed  | Dangerous for multi-agent concurrency — only one writer |
| AO worktree per task (recommended) | V1 default | Full isolation, parallel safe                           |
| Docker per task                    | V2         | Sandboxed environment                                   |
| Remote VM / cloud sandbox          | V3         | Full isolation at infrastructure level                  |

### Workspace config

```yaml
workspace:
  mode: worktree
  allow_same_folder: true
  same_folder_requires_single_writer: true
```

---

## Safety and Reliability

### Hard stop conditions

The loop stops immediately when:

- Max retries reached
- Forbidden file changed
- Agent asks for a secret or credential
- Test deletion detected
- Branch becomes corrupted
- Git conflict cannot be resolved
- Agent loops without progress
- Command runs too long (exceeds `command_minutes` timeout)
- Cost limit reached
- User kills task

### Human approval points

The following always require explicit user approval:

- Merging
- Dependency changes
- CI config changes
- Environment file changes
- Database migrations
- Destructive file changes
- Public release actions
- Production deployment

### Cost controls

Track per task when available:

```yaml
budget:
  max_task_cost_usd: 5.00
  max_daily_cost_usd: 25.00
```

Track: tokens, estimated cost, runtime duration, number of agent turns, number of retries.

---

## MVP Command Flow

```bash
agentmesh run "Add password reset flow" \
  --builder claude-code \
  --qa codex \
  --retries 2 \
  --open-pr
```

Expected output:

```
AgentMesh started TASK-001: Add password reset flow
Builder: claude-code
QA: codex
Retry limit: 2
Branch: agentmesh/TASK-001-password-reset

[10:01:02] Created task TASK-001
[10:01:04] Created branch agentmesh/TASK-001-password-reset
[10:01:08] Started Claude Code builder session
[10:04:32] Builder modified 5 files
[10:05:10] Builder ran npm test
[10:05:42] Builder requested QA
[10:05:45] Started Codex QA session
[10:08:21] QA failed: reset token can be reused
[10:08:23] Sent QA feedback to builder
[10:12:50] Builder submitted fix
[10:13:00] QA retest started
[10:15:30] QA passed
[10:15:52] PR opened
```

---

## Testing Strategy

### Unit tests

Test: task state transitions, retry logic, message bus persistence, QA report parser, config parser, policy engine, lock manager, timeline logger, role assignment, prompt rendering.

### Integration tests

Test: task create → builder spawn, builder ready → QA spawn, QA FAIL → rework, QA PASS → PR creation, retry exhaustion → blocked, policy violation → blocked, timeline replay.

### End-to-end scenarios (small sample repo)

1. Simple passing task
2. QA catches bug, builder fixes it, QA passes after retry
3. QA fails twice → task blocked
4. CI fails after PR — AO CI reaction loop routes back to agent
5. Policy blocks dangerous change
6. Agent crashes mid-task
7. User kills session
8. Resume after restart

### Dogfooding

AgentMesh should be used to build AgentMesh. Early dogfood loop: Claude implements a feature → Codex QA tests it → AgentMesh routes feedback → PR is opened → human reviews architecture.

---

## Roadmap

### MVP

- Local CLI
- Local SQLite task board
- Claude Code as builder
- Codex as QA
- Typed message bus
- QA loop with retry limit
- Timeline logs (JSONL)
- PR opening after QA pass

### V1

- Worktrees by default
- Web dashboard extended with board, timeline, logs, QA reports, PRs
- Policy engine
- GitHub Projects and Linear board integration
- Devin integration via GitHub PRs/issues
- Gemini CLI and OpenCode adapters
- Better replay UI
- Cost tracking per task

### V2

- Multi-agent swarm mode (parallel builders)
- Planner role — decomposes tasks before builder starts
- Security reviewer role
- Docs writer role
- Release manager role
- Agent performance leaderboard
- Auto task decomposition
- Remote control via mobile/Tailscale

### V3

- Public plugin SDK
- Marketplace of agent adapters
- Team mode and organization policies
- Cloud runner
- Remote workers
- Hosted dashboard

---

## MVP Acceptance Criteria

AgentMesh MVP is complete when:

1. `agentmesh init` works
2. `agentmesh run "task" --builder claude-code --qa codex --retries 2` completes the full loop
3. Task state persists locally across restarts
4. Claude Code can build
5. Codex can QA
6. QA can fail a task with an actionable report
7. Claude can receive QA feedback and retry
8. QA can pass after retry
9. PR opens only after QA pass
10. Full task timeline is visible with `agentmesh timeline TASK-001`
11. Logs can be replayed with `agentmesh replay TASK-001`
12. Failed second QA marks task as `blocked`
13. No uncontrolled infinite loop exists

## V1 Acceptance Criteria

1. Worktrees are the default workspace mode
2. Web dashboard shows agents, board, timeline, logs, and PRs
3. Policy engine blocks risky changes before PR
4. Devin can participate through GitHub PRs and issues
5. At least four agent adapters exist
6. GitHub Projects or Linear board integration works
7. Documentation allows external contributors to build adapters

---

## Non-Goals

AgentMesh should never become:

- A new coding model or AI system
- A replacement for Claude Code, Codex, Devin, Cursor, or OpenCode
- A full IDE
- A project management platform from scratch
- A CI provider or replacement for GitHub
- A generic LangGraph demo
- A toy multi-agent chatroom
- An uncontrolled autonomous system that edits and merges without gates

AgentMesh coordinates agents. It does not replace them.
