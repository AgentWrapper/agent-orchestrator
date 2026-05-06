# @aoagents/ao-core

Core services, types, and configuration for the Agent Orchestrator system.

## What's Here

- **`src/types.ts`** — All TypeScript interfaces (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal, Session, events)
- **`src/services/`** — Core services (SessionManager, LifecycleManager, PluginRegistry)
- **`src/config.ts`** — Configuration loading + Zod schemas
- **`src/utils/`** — Shared utilities (shell escaping, metadata parsing, etc.)

## Key Files

### `src/types.ts` — The Source of Truth

Every interface the system uses is defined here. If you're working on any part of the orchestrator, start by reading this file.

**Main interfaces:**

- `Runtime` — where sessions execute (tmux, docker, k8s)
- `Agent` — AI coding tool adapter (claude-code, codex, aider)
- `Workspace` — code isolation (worktree, clone)
- `Tracker` — issue tracking (GitHub Issues, Linear)
- `SCM` — PR/CI/reviews (GitHub, GitLab)
- `Notifier` — push notifications (desktop, Slack, webhook)
- `Terminal` — human interaction UI (iTerm2, web)
- `Session` — running agent instance (state, metadata, handles)
- `OrchestratorEvent` — events emitted by lifecycle manager
- `PluginModule` — what every plugin exports

### `src/services/session-manager.ts` — Session CRUD

Handles session lifecycle:

- `spawn(config)` — create new session (workspace + runtime + agent)
- `list(projectId?)` — list all sessions
- `get(sessionId)` — get session details
- `kill(sessionId)` — terminate session
- `cleanup(projectId?)` — kill completed/merged sessions
- `send(sessionId, message)` — send message to agent

**Data flow in `spawn()`:**

1. Load project config
2. **Validate issue exists** via `Tracker.getIssue()` (if issueId provided, fails-fast if not found)
3. Reserve session ID
4. Determine branch name
5. Create workspace via `Workspace.create()`
6. Generate prompt via `Tracker.generatePrompt()`
7. Build layered worker prompt via `buildPrompt()` into `systemPrompt` + `taskPrompt`
8. Persist `systemPromptFile` for the session and, for OpenCode workers, write `OPENCODE_CONFIG`
9. Build launch command via `Agent.getLaunchCommand()`
10. Create runtime session via `Runtime.create()`
11. Run `Agent.postLaunchSetup()` (optional)
12. Write metadata file
13. Return Session object

**Note:** If issue validation fails (not found, auth error), spawn fails before creating any resources (no workspace, no runtime, no session ID). This prevents spawning sessions with broken issue references.
Worker sessions keep persistent instructions in the prompt file. OpenCode workers consume that file through `OPENCODE_CONFIG`, while OpenCode orchestrators continue to project their system prompt into workspace `AGENTS.md`.

### `src/services/lifecycle-manager.ts` — State Machine + Reactions

Polls sessions, detects state changes, triggers reactions:

**State machine:**

```
spawning → working → pr_open → ci_failed/review_pending/approved → mergeable → merged
```

**Reactions:**

- `ci-failed` → send fix prompt to agent
- `changes-requested` → send review comments to agent
- `approved-and-green` → notify human (or auto-merge)
- `agent-stuck` → notify human

**Polling loop:**

1. For each session: check agent activity state (`Agent.getActivityState()`)
2. If PR exists: check CI status (`SCM.getCISummary()`), review state (`SCM.getReviewDecision()`)
3. Update session status based on state
4. Trigger reactions if state changed
5. Emit events

### `src/services/plugin-registry.ts` — Plugin Discovery + Loading

Loads plugins and provides access to them:

- `register(plugin, config?)` — register a plugin instance
- `get<T>(slot, name)` — get plugin by slot + name
- `list(slot)` — list all plugins for a slot
- `loadBuiltins(config?)` — load built-in plugins (runtime-tmux, agent-claude-code, etc.)
- `loadFromConfig(config)` — load built-ins today; external plugin descriptors are the marketplace extension point

**Built-in plugins** (loaded by default):

- runtime-tmux, runtime-process
- agent-claude-code, agent-codex, agent-aider, agent-cursor, agent-kimicode, agent-opencode
- workspace-worktree, workspace-clone
- tracker-github, tracker-linear, tracker-gitlab
- scm-github, scm-gitlab
- notifier-desktop, notifier-discord, notifier-slack, notifier-composio, notifier-openclaw, notifier-webhook
- terminal-iterm2, terminal-web

### `src/config.ts` — Configuration Loading

Loads and validates `agent-orchestrator.yaml`:

**Main config sections:**

- Runtime data paths are auto-derived from the config location under `~/.agent-orchestrator/{hash}-{projectId}/`
- `port` — web dashboard port (default 3000, set different values for multiple projects)
- `terminalPort` — terminal WebSocket port (auto-detected if not set)
- `directTerminalPort` — direct terminal WebSocket port (auto-detected if not set)
- `defaults` — default plugins (runtime, agent, workspace, notifiers)
- `plugins` — installer-managed external plugin descriptors (registry, npm, or local)
- `projects` — per-project config (repo, path, branch, symlinks, reactions, agentRules)
- `notifiers` — notification channel config (Slack webhooks, etc.)
- `notificationRouting` — which notifiers get which priority events
- `reactions` — auto-response config (ci-failed, changes-requested, approved-and-green, etc.)

**Zod schemas** validate all config at load time.

## Common Tasks

### Adding a Field to Session

1. Edit `src/types.ts` → `Session` interface
2. Edit `src/services/session-manager.ts` → initialize field in `spawn()`
3. Rebuild: `pnpm --filter @aoagents/ao-core build`

### Adding an Event Type

1. Edit `src/types.ts` → `EventType` union
2. Emit the event: `eventEmitter.emit()` in relevant service
3. Add reaction handler (optional): `src/services/lifecycle-manager.ts`

### Adding a Reaction

1. Edit `src/services/lifecycle-manager.ts` → add handler function
2. Wire it up in the polling loop
3. Add config schema in `src/config.ts` if new reaction type

### Feedback Tools (v1)

`@aoagents/ao-core` exports two structured feedback tool contracts:

- `bug_report`
- `improvement_suggestion`

Both share the same required input fields:

- `title`
- `body`
- `evidence` (array of strings)
- `session`
- `source`
- `confidence` (0..1)

Example:

```ts
import { FEEDBACK_TOOL_NAMES, FeedbackReportStore, getFeedbackReportsDir } from "@aoagents/ao-core";

const reportsDir = getFeedbackReportsDir(configPath, projectPath);
const store = new FeedbackReportStore(reportsDir);

const saved = store.persist(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
  title: "SSO login loop",
  body: "Google SSO redirects back to /login repeatedly.",
  evidence: ["trace_id=abc123", "screenshot: login-loop.png"],
  session: "ao-22",
  source: "agent",
  confidence: 0.84,
});
```

Storage format:

- Reports are persisted under `~/.agent-orchestrator/{hash}-{projectId}/feedback-reports`
- Each report is a typed key=value file (`report_<timestamp>_<id>.kv`) for easy inspection
- A deterministic dedupe key (`sha256`, 16 hex chars) is generated from normalized tool+content

Migration notes:

- No migration needed for existing AO installs
- The `feedback-reports` directory is created lazily on first persisted report

## Testing

```bash
# Run all core tests
pnpm --filter @aoagents/ao-core test

# Run in watch mode
pnpm --filter @aoagents/ao-core test -- --watch

# Run specific test
pnpm --filter @aoagents/ao-core test -- session-manager.test.ts
```

Tests are in `src/__tests__/`:

- `session-manager.test.ts` — session CRUD, spawn, cleanup
- `lifecycle-manager.test.ts` — state machine, reactions
- `plugin-registry.test.ts` — plugin loading, resolution
- `tmux.test.ts` — tmux utility functions (not a plugin test)
- `prompt-builder.test.ts` — prompt generation utilities

## Building

```bash
# Build core
pnpm --filter @aoagents/ao-core build

# Typecheck
pnpm --filter @aoagents/ao-core typecheck
```

This package is a dependency of all other packages. Build it first if working on the codebase.

## Architecture Notes

**Why flat metadata files?**

- Debuggability: `cat ~/.agent-orchestrator/<hash>-my-app/sessions/app-3` shows full state
- No database dependency (survives crashes, easy to inspect)
- Backwards-compatible with bash script orchestrator

**Why polling instead of webhooks?**

- Simpler (no webhook setup, no ngrok for local dev)
- Works offline (CI/review state is fetched, not pushed)
- Survives orchestrator restarts (no missed events)

**Why plugin slots?**

- Swappability: use tmux locally, docker in CI, k8s in prod
- Testability: mock plugins for tests
- Extensibility: users can add custom plugins (e.g., company-specific notifier)
