# Development Guide

Architecture overview, code conventions, and patterns for contributors and AI agents working on this codebase.

## Architecture Overview

AgentMesh is a monorepo with four main packages:

```
packages/
├── core/          # Types, services, config — the engine
├── cli/           # `ao` command (depends on core + all plugins)
├── web/           # Next.js dashboard (depends on core)
└── plugins/       # 21 plugin packages across 8 slots
```

**Build order matters**: core must be built before cli, web, or plugins.

### Eight Plugin Slots

Every abstraction is a swappable plugin. All interfaces are defined in [`packages/core/src/types.ts`](../packages/core/src/types.ts).

| Slot      | Interface   | Default                                                  | Alternatives                                       |
| --------- | ----------- | -------------------------------------------------------- | -------------------------------------------------- |
| Runtime   | `Runtime`   | `tmux` (Unix) / `process` (Windows; ConPTY via node-pty) | `process`, `docker`, `k8s`, `ssh`, `e2b`           |
| Agent     | `Agent`     | `claude-code`                                            | `codex`, `aider`, `cursor`, `kimicode`, `opencode` |
| Workspace | `Workspace` | `worktree`                                               | `clone`                                            |
| Tracker   | `Tracker`   | `github`                                                 | `linear`                                           |
| SCM       | `SCM`       | `github`                                                 | —                                                  |
| Notifier  | `Notifier`  | `desktop`                                                | `slack`, `webhook`, `composio`                     |
| Terminal  | `Terminal`  | `iterm2`                                                 | `web`                                              |
| Lifecycle | —           | (core)                                                   | Non-pluggable                                      |

### Hash-Based Namespacing

All runtime data paths are derived from a SHA-256 hash of the config file directory:

```typescript
const hash = sha256(path.dirname(configPath)).slice(0, 12); // e.g. "a3b4c5d6e7f8"
const instanceId = `${hash}-${projectId}`; // e.g. "a3b4c5d6e7f8-myapp"
const dataDir = `~/.agent-orchestrator/${instanceId}`;
```

This means:

- Multiple orchestrator checkouts on the same machine never collide
- Runtime handles are globally unique: `{hash}-{prefix}-{num}` (tmux session name on Unix; suffix of the named pipe `\\.\pipe\ao-pty-{sessionId}` on Windows)
- User-facing names stay clean: `ao-1`, `myapp-2`

### Session Lifecycle

```
spawning → working → pr_open → ci_failed
                             → review_pending → changes_requested
                             → approved → mergeable → merged
                                                    ↓
                             cleanup → done (or killed/terminated)
```

Activity states (orthogonal to lifecycle): `active`, `ready`, `idle`, `waiting_input`, `blocked`, `exited`.

### Key Services

| File                                     | Purpose                                        |
| ---------------------------------------- | ---------------------------------------------- |
| `packages/core/src/session-manager.ts`   | Session CRUD: spawn, list, kill, send, restore |
| `packages/core/src/lifecycle-manager.ts` | State machine, polling loop, reactions engine  |
| `packages/core/src/prompt-builder.ts`    | Layered worker prompt assembly (system + task) |
| `packages/core/src/config.ts`            | Config loading and Zod validation              |
| `packages/core/src/plugin-registry.ts`   | Plugin discovery, loading, resolution          |
| `packages/core/src/agent-selection.ts`   | Resolves worker vs orchestrator agent roles    |
| `packages/core/src/observability.ts`     | Correlation IDs, structured logging, metrics   |
| `packages/core/src/paths.ts`             | Hash-based path and session name generation    |

### Working Principles

These apply to both human contributors and AI agents:

1. **Think before coding.** If a task is ambiguous, ask for clarification. If multiple approaches exist, present the tradeoff.
2. **Minimum code.** No speculative features. No abstractions for code used once. Plugin slots exist for extensibility - use them instead of config proliferation.
3. **Surgical diffs.** Don't touch files outside your change scope. Don't reformat adjacent code. Match existing patterns even if you prefer differently. Every changed line should trace to a specific requirement.
4. **Verifiable goals.** Before implementing, state what "done" looks like and how to verify it. For bug fixes: write a test that reproduces the bug first.

For AI agent-specific guidance (including high-risk files like `types.ts`, `lifecycle-manager.ts`, `globals.css`), see CLAUDE.md -> Working Principles.

---

## Getting Started

**Prerequisites**: Node.js 20.18.3+, pnpm 9.15+, Git 2.25+

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
pnpm install
pnpm build
cp agent-orchestrator.yaml.example agent-orchestrator.yaml
$EDITOR agent-orchestrator.yaml
```

### Running the dev server

**Always build before starting the web dev server** — it depends on built packages:

```bash
pnpm build
cd packages/web && pnpm dev
# Open http://localhost:3000
```

### Project structure

```
agent-orchestrator/
├── packages/
│   ├── core/              # Core types, services, config
│   ├── cli/               # CLI tool (ao command)
│   ├── web/               # Next.js dashboard
│   ├── plugins/           # All plugin packages
│   │   ├── runtime-*/     # Runtime plugins (tmux, docker, k8s)
│   │   ├── agent-*/       # Agent adapters (claude-code, codex, aider)
│   │   ├── workspace-*/   # Workspace providers (worktree, clone)
│   │   ├── tracker-*/     # Issue trackers (github, linear)
│   │   ├── scm-github/    # SCM adapter
│   │   ├── notifier-*/    # Notification channels
│   │   └── terminal-*/    # Terminal UIs
│   └── integration-tests/ # Integration tests
├── agent-orchestrator.yaml.example
└── docs/                  # Documentation
```

---

## Development Workflow

1. **Create a feature branch**

   ```bash
   git checkout -b feat/your-feature
   ```

2. **Make your changes** — follow conventions below, add tests, update docs

3. **Build and test**

   ```bash
   pnpm build && pnpm test && pnpm lint && pnpm typecheck
   ```

4. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/)

   ```bash
   git commit -m "feat: add your feature"
   ```

   Pre-commit hook scans for secrets automatically.

5. **Push and open a PR**

---

## Keeping the local AgentMesh install current

When you are developing AgentMesh from a long-lived local checkout, refresh the local `ao` install before debugging launcher or packaging issues:

```bash
git switch main
git status --short --branch   # `ao update` expects a clean working tree on main
ao update
```

`ao update` is intentionally conservative: it fast-forwards the local install checkout from `origin/main`, runs `pnpm install`, clean-rebuilds `@aoagents/ao-core`, `@aoagents/ao-cli`, and `@aoagents/ao-web`, refreshes the global launcher with `npm link`, and ends with CLI smoke tests. Use `ao update --skip-smoke` to stop after the rebuild, or `ao update --smoke-only` to rerun the smoke checks without fetching or rebuilding.

If your branch has drift from `main`, update the install checkout first and then return to your feature worktree. That keeps CLI behavior and generated docs aligned with the version contributors are expected to run.

---

## Code Conventions

### TypeScript

```typescript
// ESM modules only — all packages use "type": "module"
// .js extension required on local imports
import { foo } from "./bar.js";
import type { Session } from "./types.js";

// node: prefix for builtins
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

// No `any` — use `unknown` + type guards
function processInput(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value.trim();
}

// Type-only imports for type-only usage
import type { PluginModule, Runtime } from "@aoagents/ao-core";
```

Formatting: semicolons, double quotes, 2-space indent, strict mode.

### Shell Commands

These rules prevent command injection. Follow them exactly.

```typescript
// Always execFile (never exec — exec runs a shell, enabling injection)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// Always pass arguments as an array (never interpolate into strings)
await execFileAsync("git", ["checkout", "-b", branchName]);

// Always add timeouts
await execFileAsync("gh", ["pr", "create", "--title", title], {
  timeout: 30_000,
});

// Never use JSON.stringify for shell escaping — use the array form
// ❌ Bad
await execFileAsync("sh", ["-c", `git commit -m "${message}"`]);
// ✅ Good
await execFileAsync("git", ["commit", "-m", message]);
```

---

## Plugin Pattern

A plugin exports a `manifest`, a `create()` factory, and a default `PluginModule` export.

```typescript
// packages/plugins/runtime-myplugin/src/index.ts
import type { PluginModule, Runtime } from "@aoagents/ao-core";

export const manifest = {
  name: "myplugin",
  slot: "runtime" as const,
  description: "My custom runtime",
  version: "0.1.0",
};

export function create(): Runtime {
  return {
    name: "myplugin",
    async create(config) {
      /* start session */
    },
    async destroy(sessionName) {
      /* tear down */
    },
    async send(sessionName, text) {
      /* send input */
    },
    async isRunning(sessionName) {
      return false;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
```

**Plugin package setup** — `package.json`:

```json
{
  "name": "@aoagents/ao-runtime-myplugin",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest"
  },
  "dependencies": {
    "@aoagents/ao-core": "workspace:*"
  }
}
```

After creating the package, add it to `packages/cli/package.json` and register it in `packages/core/src/plugin-registry.ts` inside `loadBuiltins()`.

---

## Spawn Flow

`session-manager.ts:spawn()` is the core path most features touch:

```
spawn(config)
  ├─ Validate issue (Tracker.getIssue) — fails fast, no resources created yet
  ├─ Reserve session ID
  ├─ Determine branch name
  ├─ Create workspace (Workspace.create)
  ├─ Generate issue prompt (Tracker.generatePrompt)
  ├─ Assemble layered prompt (prompt-builder.ts) → {systemPrompt, taskPrompt}
  ├─ Persist worker system prompt file
  ├─ For OpenCode workers: write OPENCODE_CONFIG pointing at that file
  ├─ Build agent launch command (Agent.getLaunchCommand)
  ├─ Create runtime session (Runtime.create)
  ├─ Post-launch setup (Agent.postLaunchSetup, optional)
  └─ Write metadata file → return Session
```

If issue validation fails, nothing is created — fail before allocating resources.

---

## Prompt Assembly

Worker prompts are built in three persistent layers (`packages/core/src/prompt-builder.ts`):

1. **Base agent guidance** — standard instructions for all sessions (git workflow, PR conventions, lifecycle hooks)
2. **Config context** — project-specific info (repo, branch, tracker, issue details, automated reactions)
3. **Project rules** — content from `agentRules` / `agentRulesFile`

The explicit user request is returned separately as `taskPrompt`. This lets session manager persist stable system instructions to disk while still sending only task-specific text to agents that need post-launch prompt delivery.

Orchestrator sessions use a separate prompt from `packages/core/src/orchestrator-prompt.ts`.

---

## Testing

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @aoagents/ao-core test

# Watch mode
pnpm --filter @aoagents/ao-core test -- --watch

# Integration tests
pnpm test:integration
```

Key test files in core (`src/__tests__/`):

- `session-manager.test.ts` — session CRUD and spawn flow
- `lifecycle-manager.test.ts` — state machine and reactions
- `plugin-registry.test.ts` — plugin loading and resolution
- `prompt-builder.test.ts` — prompt generation

Use mock plugins in tests — don't call real tmux or external services in unit tests.

---

## Common Development Tasks

### Add a field to Session

1. Edit `Session` interface in `packages/core/src/types.ts`
2. Initialize the field in `spawn()` in `session-manager.ts`
3. Rebuild: `pnpm --filter @aoagents/ao-core build`

### Add a new reaction

1. Add handler in `packages/core/src/lifecycle-manager.ts`
2. Wire it up in the polling loop
3. Add config schema in `packages/core/src/config.ts` if needed

### Add a new event type

1. Extend `EventType` union in `packages/core/src/types.ts`
2. Emit it via `eventEmitter.emit()` in the relevant service
3. Handle it in `lifecycle-manager.ts` if it should trigger a reaction

### Add a new CLI command

1. Add the command in `packages/cli/src/index.ts` using `commander`
2. Import from core services as needed
3. Update the CLI reference in `README.md`

### Debug a session

```bash
# Inspect raw metadata
cat ~/.agent-orchestrator/{hash}-{project}/sessions/{session-id}

# Check API state
curl http://localhost:3000/api/sessions/{session-id}

# Attach to the runtime session directly
# Unix:
tmux attach -t {hash}-{prefix}-{num}
# Windows: there's no tmux. Use the AO command, which connects to \\.\pipe\ao-pty-<sessionId>:
ao session attach <sessionId>

# Enable verbose logging
AO_LOG_LEVEL=debug ao start
```

---

## Working with Git Worktrees

This project uses itself to develop itself — agents work in git worktrees:

```bash
# Create a worktree for a feature branch
git worktree add ../ao-feature-x feat/feature-x
cd ../ao-feature-x

# Install and build in the worktree
pnpm install
pnpm build

# Copy config
cp ../agent-orchestrator/agent-orchestrator.yaml .

# Start dev server
cd packages/web && pnpm dev
```

---

## Security During Development

Pre-commit hooks scan for secrets automatically on every commit. If triggered:

1. Remove the secret from the file
2. Use environment variables: `${SECRET_NAME}`
3. Store real values in `.env.local` (gitignored)

To manually scan:

```bash
gitleaks detect --no-git   # scan current files
gitleaks protect --staged  # scan staged files (same as pre-commit)
```

To allow a false positive, add it to `.gitleaks.toml`:

```toml
[allowlist]
regexes = ['''your-pattern-here''']
```

---

## Environment Variables

```bash
# Mux WebSocket server port (web dashboard terminal + session updates)
DIRECT_TERMINAL_PORT=14801

# User integrations
GITHUB_TOKEN=ghp_...
LINEAR_API_KEY=lin_api_...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Store in `.env.local` (gitignored). Never commit real values.

---

## Key Design Decisions

**Why flat metadata files instead of a database?**
Debuggability: `cat ~/.agent-orchestrator/a3b4-myapp/sessions/ao-1` shows full state. No database to spin up, no schema to migrate, survives crashes.

**Why polling instead of webhooks?**
Simpler local setup (no ngrok), survives orchestrator restarts, works offline. CI/review state is fetched, not pushed.

**Why plugin slots?**
Swappability: use `process` (ConPTY) on Windows, tmux on Linux/macOS, Docker in CI, Kubernetes in prod — without changing application code. The `Runtime` interface is the layer that lets the same agent/workspace/tracker stack run across all of them. Testability: mock any plugin in unit tests. Extensibility: users add company-specific plugins without forking.

**Why hash-based namespacing?**
Multiple orchestrator checkouts on the same machine don't collide at the runtime layer (tmux session names on Unix, named-pipe paths on Windows) or on disk. Different checkouts get different hashes; projects within the same config share a hash.

**Why ESM with `.js` extensions?**
Node.js ESM requires explicit extensions on local imports. All packages use `"type": "module"`. Missing extensions cause runtime errors.

---

## Resources

- [`packages/core/README.md`](../packages/core/README.md) — Core service reference
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — Hash-based namespace design
- [`SETUP.md`](../SETUP.md) — Installation and configuration reference
- [`SECURITY.md`](../SECURITY.md) — Security practices
- [`agent-orchestrator.yaml.example`](../agent-orchestrator.yaml.example) — Full config reference

---

# AgentMesh Development Guide

AgentMesh is built on top of AO. All existing AO development practices (TypeScript strict mode, plugin pattern, `execFile` for shell commands, vitest for tests) apply equally to AgentMesh packages. This section covers the additions.

## Additional Monorepo Packages

AgentMesh adds these packages to the AO monorepo:

```
packages/
├── agentmesh-core/        # Task board, message bus, QA loop engine, role manager,
│                          # policy engine, PR gate, timeline logger
├── agentmesh-cli/         # `agentmesh` command — thin wrapper around agentmesh-core
└── agentmesh-adapters/    # Agent adapter implementations (Claude Code, Codex, Devin, …)
```

**Build order**: `core` → `agentmesh-core` → `agentmesh-adapters` → `agentmesh-cli`.

AgentMesh packages declare `@aoagents/ao-core` as a dependency (not a devDependency). They call AO's session manager, lifecycle manager, and plugin registry via the stable public API in `packages/core/src/index.ts`. They must never import directly from AO's internal modules.

## Key AgentMesh Files

| File                                             | Purpose                                           |
| ------------------------------------------------ | ------------------------------------------------- |
| `packages/agentmesh-core/src/task-manager.ts`    | Task CRUD, status transitions, SQLite persistence |
| `packages/agentmesh-core/src/message-bus.ts`     | Typed message routing and JSONL log               |
| `packages/agentmesh-core/src/qa-loop.ts`         | Builder → QA → rework state machine               |
| `packages/agentmesh-core/src/role-manager.ts`    | Role definitions, prompt template assembly        |
| `packages/agentmesh-core/src/policy-engine.ts`   | Diff analysis, forbidden-change detection         |
| `packages/agentmesh-core/src/pr-gate.ts`         | Pre-PR checks, PR creation via AO SCM             |
| `packages/agentmesh-core/src/timeline-logger.ts` | Structured event append (JSONL)                   |
| `packages/agentmesh-core/src/lock-manager.ts`    | Task, branch, file lock enforcement               |
| `packages/agentmesh-adapters/src/claude-code.ts` | Claude Code adapter (builder role)                |
| `packages/agentmesh-adapters/src/codex.ts`       | Codex adapter (QA role)                           |
| `packages/agentmesh-adapters/src/devin.ts`       | Devin adapter (GitHub-native)                     |

## Implementation Phases

AgentMesh is built in 10 phases. Each phase has a clear exit criterion — do not start the next phase until current exit criteria are met.

### Phase 0 — Fork and baseline AO

**Objective:** Get AO running locally and understand its extension points.

Tasks:

- Fork AO; run setup script; start AO on a test repo
- Spawn Claude Code session, spawn Codex session
- Confirm worktree creation, branch creation, PR detection, dashboard, CI reaction loop
- Read `core/src/types.ts`, `session-manager.ts`, `lifecycle-manager.ts`; identify metadata location, CLI command structure, plugin loading path, dashboard data API

**Exit criteria:** AO runs locally. At least one agent can work on one issue. You can inspect where sessions, logs, metadata, and config live.

### Phase 1 — AgentMesh namespace

**Objective:** Add AgentMesh-specific commands without breaking AO.

Tasks:

- Add `agentmesh` CLI package
- Add `.agentmesh/` storage directory
- Add SQLite database with task, message, and timeline tables
- Add config parser for `agentmesh.yaml`
- Add task creation and local board

Commands: `agentmesh init`, `agentmesh task create`, `agentmesh board`, `agentmesh status`

**Exit criteria:** User can create local tasks. State persists after restart.

### Phase 2 — Role manager

**Objective:** Define builder and QA roles.

Tasks:

- Add role schema and default role templates
- Add builder and QA prompt templates
- Add role assignment to tasks and role-specific launch prompts

**Exit criteria:** A task can have builder and QA assigned. Prompt generation includes role context. Agent session metadata stores role.

### Phase 3 — Message bus

**Objective:** Let agents communicate through logged messages.

Tasks:

- Add message schema and `agentmesh message send`
- Add message delivery to AO runtime (via `SessionManager.send()`)
- Add task-linked messages, attachments, and replay

Commands: `agentmesh message send TASK-001 claude.backend codex.qa "QA this."`, `agentmesh message list TASK-001`

**Exit criteria:** One running agent can receive a message from AgentMesh. Messages are persisted. Messages appear in task timeline.

### Phase 4 — Builder session integration

**Objective:** Start a builder agent from a task.

Tasks:

- Map task to AO session spawn
- Create branch, start Claude Code builder
- Capture output, detect ready-for-QA condition, generate builder summary
- Capture diff and test logs

Command: `agentmesh task run TASK-001 --builder claude-code`

**Exit criteria:** Builder starts from AgentMesh task. Builder output is captured. Builder can mark task ready for QA. Diff is saved.

### Phase 5 — QA session integration

**Objective:** Start QA against builder output.

Tasks:

- Start Codex QA session
- Send QA prompt with task, diff, builder summary, and builder logs
- Capture QA output, parse verdict, save QA report, update task status

Command: `agentmesh qa run TASK-001 --qa codex`

**Exit criteria:** QA session starts. QA receives diff and context. QA returns PASS/FAIL/BLOCKED. QA report is saved.

### Phase 6 — Loop engine

**Objective:** Automate builder → QA → rework.

Tasks:

- Add workflow state machine
- Add retry counter, rework prompt, fail route back to builder, pass route to PR gate
- Add blocked route, stop conditions, and timeline events

Command: `agentmesh run TASK-001 --loop --retries 2`

**Exit criteria:** FAIL sends QA feedback back to builder. PASS moves task to PR-ready. Two failures create a blocked task. No infinite loops.

### Phase 7 — PR gate

**Objective:** Open PR only after QA pass.

Tasks:

- Reuse AO SCM plugin (`SCM.createPullRequest()`)
- Detect branch and diff, create PR with QA summary and timeline summary attached
- Link PR to task, wait for CI, use AO CI reaction loop

Command: `agentmesh pr open TASK-001`

**Exit criteria:** PR opens only after QA pass. PR includes useful body. CI status is tracked. CI failures are routed back to agent.

### Phase 8 — Timeline and replay

**Objective:** Make every CLI step visible.

Tasks:

- Capture session output continuously, normalize command events, store raw and summarized logs
- Add replay command and timeline command with agent filter

Commands: `agentmesh timeline TASK-001`, `agentmesh replay TASK-001`, `agentmesh logs TASK-001 --agent qa`

**Exit criteria:** User can inspect full task execution including prompts, outputs, commands, QA reports, and PR events.

### Phase 9 — Policy engine

**Objective:** Prevent dangerous autonomous behavior.

Tasks:

- Add policy config, forbidden file checks, dependency change detection
- Add test deletion detection, max diff checks, approval-required state
- Add secret scan hook and policy warning in timeline

**Exit criteria:** Dangerous changes stop the loop or require approval. Policy violations are visible and logged.

### Phase 10 — Public MVP release

**Objective:** Ship usable open-source MVP.

Tasks:

- Clean README with install instructions and demo GIF
- Add example repo, config examples, troubleshooting docs, plugin docs
- Add tests, tag release, publish package

**Exit criteria:** New user can install and run demo. Claude builder to Codex QA loop works. PR opens after QA pass. Docs explain limits clearly.

## Common AgentMesh Development Tasks

### Add a new agent adapter

1. Create `packages/agentmesh-adapters/src/{name}.ts` implementing `AgentMeshAgentAdapter`
2. Implement `preflight()` — check binary/API availability
3. Implement `start()` — call `SessionManager.spawn()` with role context
4. Implement `sendMessage()` — call `SessionManager.send()` to deliver a prompt
5. Implement `getOutput()` — read from AO session output
6. Implement `getStatus()` — map AO activity state to AgentMesh status
7. Implement `stop()` — call `SessionManager.kill()`
8. Add adapter to the registry in `agentmesh-core/src/adapter-registry.ts`
9. Add tests in `src/__tests__/{name}.test.ts` — mock all AO calls

### Add a new agent role

1. Add the role definition to `agentmesh-core/src/role-manager.ts`
2. Add a prompt template to `.agentmesh/prompts/{role-name}.md`
3. Wire the role to a default adapter in `agentmesh.yaml`
4. Add tests for prompt assembly with the new role

### Add a new QA loop state

1. Extend the state union in `agentmesh-core/src/task-types.ts`
2. Add the transition to the state machine in `qa-loop.ts` with explicit guards
3. Add the state to the board column mapping in `agentmesh-cli/src/board.ts`
4. Add a timeline event type for the new state
5. Write tests for every affected transition

### Add a new policy rule

1. Add a rule handler in `agentmesh-core/src/policy-engine.ts`
2. Add the config key to the `agentmesh.yaml` schema
3. Add a test that uses a fixture diff that triggers the rule
4. Verify it blocks the loop and logs a timeline event

## First Build Prompts

Use these prompts with Claude Code inside the AO fork to bootstrap AgentMesh.

### First build prompt (Phase 1)

```
You are working inside a fork of Agent Orchestrator. Build the first AgentMesh
MVP layer without breaking existing AO behavior.

Goal:
Add a local-first AgentMesh workflow that supports builder → QA → rework → PR loops.

Scope for this task:
1. Add an AgentMesh namespace/module.
2. Add local task storage under .agentmesh/.
3. Add a SQLite-backed task board.
4. Add message bus tables and JSONL logging.
5. Add role definitions for builder and qa.
6. Add CLI commands:
   - agentmesh init
   - agentmesh task create
   - agentmesh board
   - agentmesh message list
   - agentmesh timeline
7. Do not implement actual Claude/Codex loop yet.
8. Preserve all existing AO tests.
9. Add unit tests for task creation, message persistence, and timeline logging.

Acceptance criteria:
- Existing AO functionality still works.
- New AgentMesh commands compile and run.
- Tasks persist locally.
- Messages persist locally.
- Timeline events persist locally.
- Tests are added.
- No unrelated refactors.
```

### Second build prompt (Phase 4)

```
Extend AgentMesh inside the Agent Orchestrator fork.

Goal:
Implement the first builder session integration.

Scope:
1. Add command: agentmesh task run TASK_ID --builder claude-code
2. Reuse AO agent/session/runtime infrastructure where possible.
3. Generate a builder prompt from the task description.
4. Start the builder agent session.
5. Capture session ID, branch, workspace path, and logs.
6. Add timeline events for session start, output capture, and completion claim.
7. Add a manual ready-for-QA transition: agentmesh task ready-for-qa TASK_ID

Acceptance criteria:
- A task can start a Claude Code builder session.
- Session metadata is linked to the AgentMesh task.
- Logs are visible from AgentMesh.
- Task can be marked ready for QA.
- Existing AO commands still work.
```

### Third build prompt (Phase 5)

```
Extend AgentMesh with QA session integration.

Goal:
Implement Codex as QA for a completed builder task.

Scope:
1. Add command: agentmesh qa run TASK_ID --qa codex
2. Gather task description, builder summary, git diff, and builder logs.
3. Generate QA prompt.
4. Start Codex QA session.
5. Capture QA output.
6. Save plain-English QA report.
7. Parse or require verdict: PASS, FAIL, BLOCKED.
8. Save structured QA report.
9. Update task status.

Acceptance criteria:
- QA receives enough context to test the feature.
- QA report is persisted.
- PASS moves task to qa_passed.
- FAIL moves task to qa_failed.
- BLOCKED moves task to blocked.
- Timeline shows all QA steps.
```

### Fourth build prompt (Phase 6)

```
Implement the AgentMesh autonomous QA loop.

Goal:
Make builder → QA → rework happen automatically.

Scope:
1. Add command: agentmesh run TASK_ID --loop --retries 2
2. If builder finishes, run QA.
3. If QA PASS, move to PR-ready.
4. If QA FAIL, send QA feedback back to builder.
5. Let builder perform one rework attempt.
6. Run QA again.
7. If QA fails twice, mark blocked.
8. Save every prompt, response, log, and state transition.
9. Add replay command.

Acceptance criteria:
- Loop runs without manual prompt copying.
- Retry limit is enforced.
- Task becomes blocked after max retries.
- Timeline replay shows the full loop.
- PR is not opened unless QA passes.
```
